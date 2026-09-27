import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * WI-10003478 (plan papercusp-db-backup-invalid-db-2026-09-27 P-002) — the
 * guarded INVALID test-database reaper must NEVER drop a valid database.
 *
 * The script runs for real against a stub `sudo` that plays Postgres. The
 * stub's CENSUS answer is deliberately independent of the truth catalog, so
 * a test can simulate a broken census predicate that returns VALID rows. The
 * script's bash checks (and its per-row re-read of the truth catalog) are what
 * must refuse those rows. Every DROP the script issues is recorded.
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) instead of mutating the shared checkout.
const SCRIPT =
  process.env.INVALID_DB_REAPER_SCRIPT ??
  resolve(__dirname, '..', '..', '..', '..', 'bin', 'reap-invalid-test-databases.sh');

const DEFERRED = 'papercusp-test-db-drop-deferred';

type Row = [name: string, limit: number, comment: string];

const STUB_SUDO = `#!/usr/bin/env bash
sql="$(cat)"
n=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-v" ]; then case "$a" in n=*) n="\${a#n=}" ;; esac; fi
  prev="$a"
done
if [[ "$sql" == *"DROP DATABASE"* ]]; then
  name="$(printf '%s' "$sql" | sed -n 's/.*DROP DATABASE IF EXISTS "\\([^"]*\\)".*/\\1/p')"
  printf '%s\\n' "$name" >> "$REAP_TEST_DROPPED"
  exit 0
fi
is_dropped() { [ -f "$REAP_TEST_DROPPED" ] && grep -qxF "$1" "$REAP_TEST_DROPPED"; }
if [[ "$sql" == *":'n'"* ]]; then
  while IFS=$'\\t' read -r name limit desc; do
    [ "$name" = "$n" ] && ! is_dropped "$name" && printf '%s\\t%s\\t%s\\n' "$name" "$limit" "$desc"
  done < "$REAP_TEST_TRUTH"
  exit 0
fi
while IFS=$'\\t' read -r name limit desc; do
  [ -n "$name" ] && ! is_dropped "$name" && printf '%s\\t%s\\t%s\\n' "$name" "$limit" "$desc"
done < "$REAP_TEST_CENSUS"
exit 0
`;

function tsv(rows: Row[]): string {
  return rows.map((r) => r.join('\t')).join('\n') + '\n';
}

function runReaper(opts: { truth: Row[]; census?: Row[]; args?: string[]; env?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), 'invalid-db-reaper-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'sudo'), STUB_SUDO);
    chmodSync(join(bin, 'sudo'), 0o755);
    const truth = join(dir, 'truth.tsv');
    const census = join(dir, 'census.tsv');
    const dropped = join(dir, 'dropped.txt');
    writeFileSync(truth, tsv(opts.truth));
    // Default census = what a correct `datconnlimit = -2` predicate would return.
    writeFileSync(census, tsv(opts.census ?? opts.truth.filter((r) => r[1] === -2)));
    let status = 0;
    let out: string;
    try {
      out = execFileSync('bash', [SCRIPT, ...(opts.args ?? [])], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          XDG_RUNTIME_DIR: dir,
          REAP_TEST_TRUTH: truth,
          REAP_TEST_CENSUS: census,
          REAP_TEST_DROPPED: dropped,
          ...(opts.env ?? {}),
        },
        encoding: 'utf8',
      });
    } catch (e) {
      const err = e as { status: number; stdout: string };
      status = err.status;
      out = err.stdout;
    }
    const drops = existsSync(dropped) ? readFileSync(dropped, 'utf8').split('\n').filter(Boolean) : [];
    return { out, status, drops };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('reap-invalid-test-databases.sh — guarded INVALID-database reaper (WI-10003478)', () => {
  it('positive control: drops invalid fixture databases carrying a harness marker', () => {
    const { drops, status, out } = runReaper({
      truth: [
        ['papercusp_it_baseline_62c001688262', -2, DEFERRED],
        ['org_7534135814ac', -2, DEFERRED],
        ['papercusp_it_baseline_0123456789ab', -2, 'papercusp-test-db:1790479836922'],
      ],
    });
    expect(status).toBe(0);
    expect(drops.sort()).toEqual(
      ['org_7534135814ac', 'papercusp_it_baseline_0123456789ab', 'papercusp_it_baseline_62c001688262'].sort(),
    );
    expect(out).toMatch(/census before: 3 invalid/);
    expect(out).toMatch(/census after: 0 invalid database\(s\); dropped=3 left=0 failed=0/);
  });

  it('never drops a VALID database even when the census predicate wrongly returns it', () => {
    const valid: Row[] = [
      ['papercusp', -1, ''],
      ['org_8b3b037fb13d', -1, 'papercusp-test-db:1790479836922'],
      ['papercusp_it_baseline_76c6d48167c8', -1, DEFERRED],
    ];
    const { drops, out } = runReaper({
      truth: valid,
      // Broken census: returns valid rows as if they were invalid.
      census: valid.map(([n, , c]) => [n, -2, c] as Row),
    });
    expect(drops).toEqual([]);
    expect(out).toMatch(/LEAVE papercusp \(limit=-2 .*not an invalid test-fixture database/);
    expect(out).toMatch(/LEAVE org_8b3b037fb13d — re-check no longer eligible/);
  });

  it('never drops an invalid database whose name is not a test-fixture name', () => {
    const { drops, out } = runReaper({
      truth: [
        ['papercusp', -2, DEFERRED],
        ['email_app', -2, DEFERRED],
        ['org_short', -2, DEFERRED],
        ['papercusp_it_baseline_62c001688262x', -2, DEFERRED],
      ],
    });
    expect(drops).toEqual([]);
    expect(out).toMatch(/left=4/);
  });

  it('never drops an invalid fixture-named database without a harness marker comment', () => {
    const { drops } = runReaper({
      truth: [
        ['org_ece5231cc705', -2, ''],
        ['papercusp_it_baseline_2e841662829b', -2, 'someone else wrote this'],
      ],
    });
    expect(drops).toEqual([]);
  });

  it('re-checks immediately before DROP: a row that is no longer invalid is left alone', () => {
    const { drops, out } = runReaper({
      truth: [['papercusp_it_baseline_9ba6edc4a4c4', -1, DEFERRED]],
      census: [['papercusp_it_baseline_9ba6edc4a4c4', -2, DEFERRED]],
    });
    expect(drops).toEqual([]);
    expect(out).toMatch(/re-check no longer eligible/);
  });

  it('--dry-run reports what it would drop and drops nothing', () => {
    const { drops, out } = runReaper({
      truth: [['org_2ac8a6908a9e', -2, DEFERRED]],
      args: ['--dry-run'],
    });
    expect(drops).toEqual([]);
    expect(out).toMatch(/DRY-RUN would drop org_2ac8a6908a9e/);
  });

  it('the census SQL itself selects only INVALID rows (datconnlimit = -2)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const census = src.slice(src.indexOf('CENSUS_SQL='), src.indexOf('RECHECK_SQL='));
    expect(census).toMatch(/WHERE d\.datconnlimit = -2/);
    expect(src).not.toMatch(/statement_timeout = '[1-9]/);
  });

  it('ships a timer that runs clear of the :00 hourly backup', () => {
    const dir = resolve(__dirname, '..', 'systemd');
    const timer = readFileSync(join(dir, 'papercusp-invalid-db-reaper.timer'), 'utf8');
    expect(timer).toMatch(/^OnCalendar=\*:40$/m);
    const svc = readFileSync(join(dir, 'papercusp-invalid-db-reaper.service'), 'utf8');
    expect(svc).toMatch(/ExecStart=.*bin\/reap-invalid-test-databases\.sh/);
  });
});
