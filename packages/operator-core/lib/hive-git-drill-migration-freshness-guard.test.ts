/**
 * hive-git-drill-migration-freshness-guard.test.ts — regression guard for WI-3969 / P-401.
 *
 * papercusp-desktop/bin/hive-git-drill.sh bundles a pre-built .deb (with its own frozen
 * db-sql/ migration set) to stand in for a "tower" during the drill. When that .deb goes
 * STALE relative to the live repo's migration set, the sidecar boots fine but a later drill
 * leg queries a table a newer migration created/renamed and dies mid-run with a misleading
 * "relation does not exist" / "git commit failed" trace — indistinguishable from a real
 * pot-git regression (this is exactly how the LEG D "failure" that filed WI-3969 happened:
 * 18 migrations behind, the hives->pots rename migration 557 missing, no real code defect).
 *
 * The fix (landed, P-401 "done") is a fail-FAST guard: before any drill leg runs, compare
 * the bundled .deb's highest db-sql/ migration number against the repo's, and FATAL
 * (exit 2) with an explicit stale-artifact diagnosis if the bundled one is behind.
 *
 * This test is the missing regression coverage flagged by P-412 ("confirm the P-401
 * bundled-artifact freshness guard still holds ... and that a regression test FAILS if it
 * recurs") — until now the guard existed only as inline bash in hive-git-drill.sh with no
 * automated assertion that it actually fires. Running the full drill script end-to-end needs
 * a real built .deb + DHT + two sidecars, so per this repo's regex-extraction convention
 * (see live-federation-gate-fromrepo-default.test.ts) this:
 *
 *   STATIC leg (all platforms): pins the exact guard shape in source — the WI-3969 marker,
 *   the `-lt` staleness comparison, and the `exit 2` FATAL path — so a later edit can't
 *   silently weaken/remove it without this test failing.
 *
 *   BEHAVIORAL leg (all platforms — plain bash + coreutils, no OS-specific bits): extracts
 *   the REAL guard block verbatim from the shipping script and evals it under bash against
 *   fixture `db-sql`-shaped directories, proving:
 *     (1) a bundled artifact BEHIND the repo's highest migration FATALs with exit 2 and
 *         names both migration numbers + the gap, and
 *     (2) a bundled artifact AT or AHEAD of the repo's highest migration passes through
 *         (exit 0) — the guard must not false-positive on a fresh/newer artifact.
 *
 *   cd packages/operator-core && npx vitest run lib/hive-git-drill-migration-freshness-guard.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'hive-git-drill.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate the repo root (no papercusp-desktop/bin/hive-git-drill.sh above this test)');
}

const ROOT = repoRoot();
const DRILL_PATH = join(ROOT, 'papercusp-desktop', 'bin', 'hive-git-drill.sh');
const drill = readFileSync(DRILL_PATH, 'utf8');

// Extract the guard block verbatim: from the REPO_SQL_DIR assignment through the closing
// `fi` of the if/elif that follows it. Non-greedy so it stops at the FIRST `fi` — the block
// contains no nested `if`, so this is exact.
const GUARD_BLOCK_RE =
  /REPO_SQL_DIR="\$REPO_DIR\/libs\/papercusp\/libs\/db\/sql"[\s\S]*?\nfi\n/;
const guardBlockMatch = drill.match(GUARD_BLOCK_RE);

const tempDirs: string[] = [];
function makeSqlFixture(migrationNumbers: number[]): { repoDir: string; sideDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'freshness-guard-fixture-'));
  tempDirs.push(root);
  const repoDir = join(root, 'repo');
  const sideDir = join(root, 'side');
  const repoSqlDir = join(repoDir, 'libs', 'papercusp', 'libs', 'db', 'sql');
  const bundledSqlDir = join(sideDir, 'db-sql');
  mkdirSync(repoSqlDir, { recursive: true });
  mkdirSync(bundledSqlDir, { recursive: true });
  return { repoDir, sideDir };
}

function writeMigrations(dir: string, numbers: number[]) {
  for (const n of numbers) writeFileSync(join(dir, `${n}-some-migration.sql`), '-- fixture\n');
}

afterEach(() => {
  while (tempDirs.length) {
    const d = tempDirs.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function runGuard(repoDir: string, sideDir: string): { status: number | null; stdout: string } {
  expect(guardBlockMatch, 'could not locate the migration-freshness guard block in hive-git-drill.sh').toBeTruthy();
  // DEB is referenced only in the FATAL message body (`set -u` is on in the real script,
  // so it must be bound here too) — its value doesn't affect the guard's pass/fail logic.
  const script = `set -uo pipefail\nREPO_DIR=${JSON.stringify(repoDir)}\nSIDE=${JSON.stringify(sideDir)}\nDEB=${JSON.stringify(join(sideDir, 'fixture.deb'))}\n${guardBlockMatch![0]}`;
  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
  return { status: res.status, stdout: res.stdout + res.stderr };
}

describe('WI-3969/P-401: hive-git-drill.sh migration-freshness guard', () => {
  it('source pins the WI-3969 staleness comparison and its exit-2 FATAL path', () => {
    expect(drill).toMatch(/WI-3969/);
    expect(drill).toMatch(/"\$bundled_max_mig"\s+-lt\s+"\$repo_max_mig"/);
    expect(drill).toMatch(/FATAL: bundled \.deb's db-sql\/ is STALE/);
    expect(drill).toMatch(/exit 2/);
  });

  it('behaviorally: FATALs with exit 2 when the bundled artifact is behind the repo (the WI-3969 class)', () => {
    const { repoDir, sideDir } = makeSqlFixture([557, 600, 620]);
    writeMigrations(join(repoDir, 'libs', 'papercusp', 'libs', 'db', 'sql'), [557, 600, 620]);
    writeMigrations(join(sideDir, 'db-sql'), [557, 600]); // 20 migrations behind
    const { status, stdout } = runGuard(repoDir, sideDir);
    expect(status).toBe(2);
    expect(stdout).toMatch(/FATAL: bundled \.deb's db-sql\/ is STALE/);
    expect(stdout).toMatch(/highest migration 600, repo is at 620 \(20 migration\(s\) behind\)/);
  });

  it('behaviorally: passes through (exit 0) when the bundled artifact matches the repo HEAD migration', () => {
    const { repoDir, sideDir } = makeSqlFixture([557, 600, 620]);
    writeMigrations(join(repoDir, 'libs', 'papercusp', 'libs', 'db', 'sql'), [557, 600, 620]);
    writeMigrations(join(sideDir, 'db-sql'), [557, 600, 620]); // exactly fresh
    const { status, stdout } = runGuard(repoDir, sideDir);
    expect(status).toBe(0);
    expect(stdout).toMatch(/fresh, continuing/);
    expect(stdout).not.toMatch(/FATAL/);
  });

  it('behaviorally: does not false-positive when the bundled artifact is AHEAD of the repo (never regresses to a false FATAL)', () => {
    const { repoDir, sideDir } = makeSqlFixture([557, 600, 620]);
    writeMigrations(join(repoDir, 'libs', 'papercusp', 'libs', 'db', 'sql'), [557, 600, 620]);
    writeMigrations(join(sideDir, 'db-sql'), [557, 600, 620, 626]); // ahead
    const { status, stdout } = runGuard(repoDir, sideDir);
    expect(status).toBe(0);
    expect(stdout).not.toMatch(/FATAL/);
  });
});
