import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * WI-10003455 — INVALID databases must not redden the hourly backup.
 *
 * A DROP DATABASE interrupted mid-flight (PG ≥15) leaves the pg_database row
 * behind with datconnlimit = -2 while datallowconn stays TRUE. The old
 * enumeration (`datistemplate=false AND datallowconn`) admitted those rows, so
 * pg_dump hit "cannot connect to invalid database" and the unit exited 1 on
 * EVERY run (measured 2026-09-27: 18 such leftovers) while the real dumps were
 * fine — a permanent red that masks the real failure it exists to report.
 *
 * The guard below RUNS the script's actual enumeration block (extracted by its
 * markers, not re-typed) against a stub `sudo` that answers like Postgres does
 * for a catalog holding one valid and two invalid databases, and asserts the
 * invalid ones are (a) not dumped, (b) recorded in INVALID_SKIPPED, (c) logged.
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) rather than by mutating the shared checkout.
const SCRIPT =
  process.env.BACKUP_INVALID_DB_SCRIPT ??
  resolve(__dirname, '..', 'systemd', 'papercusp-db-backup.sh');

const src = readFileSync(SCRIPT, 'utf8');

/** The enumeration block: from DB_SELECT_SQL= through the INVALID_SKIPPED log `fi`. */
function enumerationBlock(): string {
  const start = src.indexOf('DB_SELECT_SQL=');
  expect(start, 'DB_SELECT_SQL assignment must exist').toBeGreaterThan(-1);
  const logIdx = src.indexOf('WARN skipping', start);
  expect(logIdx, 'invalid-db WARN log must follow the enumeration').toBeGreaterThan(-1);
  const fiIdx = src.indexOf('\nfi', logIdx);
  expect(fiIdx).toBeGreaterThan(-1);
  return src.slice(start, fiIdx + 3);
}

/**
 * Stub `sudo` emulating Postgres' answer to whichever query it is handed:
 * catalog = { papercusp: valid, papercusp_it_baseline_abc: invalid, org_x: invalid }
 * (all three have datallowconn = true, exactly as observed live).
 */
const STUB_SUDO = `#!/usr/bin/env bash
sql="\${@: -1}"
rows=$'papercusp\\t1\\t-1\\npapercusp_it_baseline_abc\\t1\\t-2\\norg_x\\t1\\t-2'
while IFS=$'\\t' read -r name allow limit; do
  keep=1
  case "$sql" in
    *"datconnlimit = -2"*) [ "$limit" = "-2" ] || keep=0 ;;
  esac
  case "$sql" in
    *"datconnlimit <> -2"*) [ "$limit" != "-2" ] || keep=0 ;;
  esac
  case "$sql" in
    *datallowconn*) [ "$allow" = 1 ] || keep=0 ;;
  esac
  [ "$keep" = 1 ] && echo "$name"
done <<< "$rows"
exit 0
`;

function runEnumeration() {
  const dir = mkdtempSync(join(tmpdir(), 'backup-invalid-db-'));
  try {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    writeFileSync(join(bin, 'sudo'), STUB_SUDO);
    chmodSync(join(bin, 'sudo'), 0o755);
    const harness = [
      'set -uo pipefail',
      `EXCLUDE_RE='(_test$|^template)'`,
      `log() { printf 'LOG %s\\n' "$*"; }`,
      enumerationBlock(),
      `printf 'DBS=%s\\n' "$(echo $DBS)"`,
      `printf 'INVALID=%s\\n' "\${INVALID_SKIPPED[*]}"`,
    ].join('\n');
    const out = execFileSync('bash', ['-c', harness], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('papercusp-db-backup.sh — invalid (datconnlimit=-2) databases (WI-10003455)', () => {
  it('does not select invalid databases for dumping', () => {
    const out = runEnumeration();
    expect(out).toMatch(/^DBS=papercusp$/m);
  });

  it('records every invalid database in INVALID_SKIPPED and logs them (skipped, not silent)', () => {
    const out = runEnumeration();
    expect(out).toMatch(/^INVALID=papercusp_it_baseline_abc org_x$/m);
    expect(out).toMatch(/LOG WARN skipping 2 INVALID database\(s\)/);
  });

  it('never folds invalid databases into FAILED — they are reported in STATUS.json invalidSkipped', () => {
    const code = src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(code).not.toMatch(/FAILED\+=\(\s*"\$inv"/);
    expect(code).toMatch(/"invalidSkipped": \[%s\]/);
  });
});
