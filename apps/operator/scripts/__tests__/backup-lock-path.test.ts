import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const PRODUCER = resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');

describe('papercusp-db-backup.sh lock acquisition', () => {
  it('keeps the default lock outside the relocatable Kopia cache', () => {
    const source = readFileSync(PRODUCER, 'utf8');
    expect(source).toContain(
      'LOCK="${PC_BACKUP_LOCK:-$BACKUP_HOME/.cache/papercusp/db-backup.lock}"',
    );
    expect(source).not.toContain(
      'LOCK="${PC_BACKUP_LOCK:-$BACKUP_HOME/.cache/kopia/db-backup.lock}"',
    );
  });

  it('fails non-zero instead of reporting a skipped run when the lock parent is unusable', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-backup-lock-'));
    try {
      const script = join(root, 'papercusp-db-backup.sh');
      const dump = join(root, 'dump');
      const bin = join(root, 'bin');
      const cache = join(root, 'cache');
      const kopiaCache = join(cache, 'kopia');
      const missingTarget = join(root, 'missing-kopia-cache');

      copyFileSync(PRODUCER, script);
      chmodSync(script, 0o755);
      mkdirSync(bin, { recursive: true });
      mkdirSync(cache, { recursive: true });
      symlinkSync(missingTarget, kopiaCache);

      // The producer reaches lock setup after its root-owned PG output mkdir.
      // Stub only that command so this test exercises the real lock bootstrap,
      // without connecting to or mutating the live database.
      const sudo = join(bin, 'sudo');
      writeFileSync(sudo, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(sudo, 0o755);

      const result = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          PAPERCUSP_HOST_PG_DUMP_DIR: dump,
          PC_BACKUP_LOCK: join(kopiaCache, 'db-backup.lock'),
        },
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain('FATAL: unable to create backup lock directory');
      expect(output).not.toContain('skipped: previous backup still running');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns EX_TEMPFAIL when another backup owns the producer lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-backup-lock-held-'));
    try {
      const script = join(root, 'papercusp-db-backup.sh');
      const dump = join(root, 'dump');
      const bin = join(root, 'bin');
      const lock = join(root, 'db-backup.lock');
      const ready = join(root, 'lock-held');

      copyFileSync(PRODUCER, script);
      chmodSync(script, 0o755);
      mkdirSync(bin, { recursive: true });

      // Stub the root-owned output setup; the held-lock branch must be reached
      // without connecting to or mutating the live database.
      const sudo = join(bin, 'sudo');
      writeFileSync(sudo, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(sudo, 0o755);

      const result = spawnSync(
        'bash',
        [
          '-c',
          `
            set -uo pipefail
            (
              exec 8>"$LOCK"
              if ! flock -n 8; then exit 92; fi
              touch "$READY"
              sleep 2
            ) &
            holder=$!
            for _ in $(seq 1 100); do
              [ -e "$READY" ] && break
              sleep 0.01
            done
            [ -e "$READY" ] || exit 91
            bash "$SCRIPT"
            rc=$?
            wait "$holder"
            exit "$rc"
          `,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            PAPERCUSP_HOST_PG_DUMP_DIR: dump,
            PC_BACKUP_LOCK: lock,
            LOCK: lock,
            READY: ready,
            SCRIPT: script,
          },
        },
      );
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

      expect(result.status).toBe(75);
      expect(output).toContain('skipped: previous backup still running');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
