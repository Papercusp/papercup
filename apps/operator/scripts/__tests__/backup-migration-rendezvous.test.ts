import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * EI-22634893804237362 — the host `pcbackup` producer must participate in the
 * same Postgres advisory rendezvous as db:migrate and boot-migrate.
 *
 * The per-workspace backup path already held this key, but the systemd host
 * script only tagged its pg_dump backend. A long host dump could therefore
 * acquire AccessShareLock while a migration was retrying ACCESS EXCLUSIVE and
 * exhaust every short lock-timeout attempt. These tests pin the producer-side
 * contract and execute the real lock helper against a fake psql session.
 */

const SCRIPT = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');
const source = readFileSync(SCRIPT, 'utf8');

function stripCommentLines(shell: string): string {
  return shell
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

function extractFunction(name: string, endMarker: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start);
  if (end < 0) return '';
  return source.slice(start, end + 2);
}

describe('papercusp-db-backup.sh migration rendezvous (EI-22634893804237362)', () => {
  it('is valid shell and acquires the shared lock before the first dump', () => {
    expect(execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).toBe('');
    const stripped = stripCommentLines(source);
    expect(stripped).toContain("readonly BACKUP_MIGRATION_ADVISORY_LOCK_KEY='papercusp:backup:migration-rendezvous'");
    expect(stripped).toContain("readonly BACKUP_MIGRATION_ADVISORY_DATABASE='papercusp'");
    expect(stripped).toContain('coproc BACKUP_MIGRATION_LOCK_PSQL');
    expect(stripped).toContain('-d "$BACKUP_MIGRATION_ADVISORY_DATABASE"');
    expect(stripped).toContain("'SET lock_timeout = 0;'");
    expect(stripped).toContain("'SET statement_timeout = 0;'");
    expect(stripped).toContain("pg_advisory_lock(hashtext('$BACKUP_MIGRATION_ADVISORY_LOCK_KEY'))");
    expect(stripped).toContain('trap release_migration_rendezvous EXIT');

    const acquire = stripped.indexOf('acquire_migration_rendezvous || exit 1');
    const firstDump = stripped.indexOf('pg_dumpall');
    expect(acquire).toBeGreaterThanOrEqual(0);
    expect(firstDump).toBeGreaterThan(acquire);

    // WI-10004870 split the release in two. A run with no transcript tier due
    // releases BEFORE oddsmith, exactly as before (oddsmith is another server, so
    // holding papercusp migrations for it would buy nothing). A run that still has
    // a transcript tier to dump moves that dump to the end of the run and must
    // keep the rendezvous until it finishes: it is a papercusp pg_dump like the
    // others, and a migration must not take its tables mid-dump.
    const oddsmith = stripped.indexOf('ODDSMITH_DISCOVERY=');
    const earlyRelease = stripped.indexOf(
      'if [ ${#TRANSCRIPT_DUE[@]} -eq 0 ]; then\n  release_migration_rendezvous\n  reap_own_stragglers',
    );
    expect(earlyRelease, 'expected the no-transcript-due release').toBeGreaterThan(0);
    expect(oddsmith).toBeGreaterThan(earlyRelease);

    const transcriptPhase = stripped.slice(stripped.indexOf('if [ ${#TRANSCRIPT_DUE[@]} -gt 0 ]; then'));
    expect(transcriptPhase.length, 'expected the local-only transcript phase').toBeGreaterThan(0);
    expect(stripped.indexOf('if [ ${#TRANSCRIPT_DUE[@]} -gt 0 ]; then')).toBeGreaterThan(oddsmith);
    const transcriptDump = transcriptPhase.indexOf('dump_one "$db" "$db-transcript"');
    const lateRelease = transcriptPhase.indexOf('release_migration_rendezvous\n  reap_own_stragglers');
    expect(transcriptDump, 'expected the transcript dump in that phase').toBeGreaterThan(0);
    expect(lateRelease, 'the rendezvous must be held until the transcript dump is done').toBeGreaterThan(
      transcriptDump,
    );
  });

  it('keeps the dedicated lock session open until the real release helper closes it', () => {
    const acquire = extractFunction('acquire_migration_rendezvous', '\n}\n\n# Bounded run');
    const release = extractFunction('release_migration_rendezvous', '\n}\n\ntrap release_migration_rendezvous');
    expect(acquire).not.toBe('');
    expect(release).not.toBe('');

    const dir = mkdtempSync(join(tmpdir(), 'backup-rendezvous-'));
    try {
      const fakeSudo = join(dir, 'sudo');
      const fakePsql = join(dir, 'psql');
      const state = join(dir, 'state');
      writeFileSync(
        fakeSudo,
        '#!/usr/bin/env bash\n' +
          'set -e\n' +
          'while [ "$#" -gt 0 ] && [ "$1" != env ]; do shift; done\n' +
          '[ "$1" = env ] && shift\n' +
          'shift\n' +
          'exec "$@"\n',
      );
      writeFileSync(
        fakePsql,
        '#!/usr/bin/env bash\n' +
          'set -eu\n' +
          `state=${JSON.stringify(state)}\n` +
          'printf "%s\\n" "$@" >"$state.args"\n' +
          ': >"$state.started"\n' +
          'while IFS= read -r line; do\n' +
          '  case "$line" in\n' +
          '    "\\\\echo "*) printf "%s\\n" "${line#\\\\echo }" ;;\n' +
          '    "\\\\q") : >"$state.released"; exit 0 ;;\n' +
          '  esac\n' +
          'done\n',
      );
      chmodSync(fakeSudo, 0o755);
      chmodSync(fakePsql, 0o755);

      const harness = [
        'set -euo pipefail',
        `PATH=${JSON.stringify(dir)}:$PATH`,
        `HOST_BACKUP_APPLICATION_NAME=pcbackup`,
        `BACKUP_MIGRATION_ADVISORY_LOCK_KEY='papercusp:backup:migration-rendezvous'`,
        `BACKUP_MIGRATION_ADVISORY_DATABASE=papercusp`,
        `BACKUP_MIGRATION_LOCK_READY='papercusp_backup_migration_lock_acquired'`,
        `BACKUP_MIGRATION_LOCK_PID=''`,
        `BACKUP_MIGRATION_LOCK_IN_FD=''`,
        `BACKUP_MIGRATION_LOCK_OUT_FD=''`,
        `BACKUP_MIGRATION_LOCK_HELD=false`,
        'log() { :; }',
        release,
        acquire,
        'acquire_migration_rendezvous',
        'test "$BACKUP_MIGRATION_LOCK_HELD" = true',
        `test -e ${JSON.stringify(state + '.started')}`,
        'release_migration_rendezvous',
        `test -e ${JSON.stringify(state + '.released')}`,
      ].join('\n');

      execFileSync('bash', ['-c', harness], { encoding: 'utf8' });
      const args = readFileSync(state + '.args', 'utf8').trim().split('\n');
      const databaseArg = args.indexOf('-d');
      expect(databaseArg).toBeGreaterThanOrEqual(0);
      expect(args[databaseArg + 1]).toBe('papercusp');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
