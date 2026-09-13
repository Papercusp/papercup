/**
 * boot-e2e-pg-lock-guard — the guard for EI-22125738148136740.
 *
 * WHAT WENT WRONG, so the next reader knows what this is defending:
 * `templates/*​/checks/boot-e2e.test.ts` (spawn mode) boots a fresh sidecar
 * against an embedded PG data dir. On a machine where a DIFFERENT deployment
 * (e.g. `papercusp-cloud-portal.service`) already holds that same data dir,
 * the sidecar's embedded PG dies immediately on "FATAL: lock file
 * postmaster.pid already exists" — but the check had no way to know that, so
 * it just polled the health endpoint for the FULL `readyTimeoutMs` (up to
 * 4min) before failing with a generic "sidecar never became healthy"
 * message. Cost measured 2026-09-02: two portal template runs of 650s and
 * 652s, and the generic message caused two successive misattributions
 * before anyone read the process table.
 *
 * The fix adds an optional `boot.pgDataDir` config field + a
 * `pgDataDirLockedBy` preflight that fails FAST (no polling) naming the
 * collision, before either the buildCommand or spawn leg runs. This file
 * guards two things: (1) STRUCTURAL — every portable boot-e2e.test.ts copy
 * implements the same gate, ahead of the expensive legs, so a hand-edit to
 * one copy that misses the other is caught (the exact drift class
 * `boot-check-timeout-coherence.test.ts` next to this file also guards, for
 * the budget-derivation invariant); (2) BEHAVIORAL — the pid-liveness
 * algorithm itself, replicated here (kept in lockstep by the structural
 * guard) and exercised against REAL files and REAL process pids, since the
 * portable checks are deliberately dependency-free and not imported by
 * anything in this repo (same constraint the sibling coherence file notes).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// From the non-test module, never from the sibling TEST file: under the gate's pure lane
// (isolate:false) a test file imported by another test file loads once per fork, so the
// second file collects 0 tests and fails "No test suite found" (WI-212675, 2026-09-03).
import { listBootChecks } from './boot-check-timeout-coherence';

const ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) return dir;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('boot-e2e-pg-lock-guard: could not locate the monorepo root');
})();
const TEMPLATES_DIR = join(ROOT, 'templates');

/**
 * Boot checks whose spawn leg does not gate on a locked `boot.pgDataDir`
 * BEFORE the expensive buildCommand/spawn/health-poll legs. Returns one
 * human-readable violation per offending file, `[]` when the tree is clean.
 */
export function findMissingPgLockGuard(templatesDir: string): string[] {
  const violations: string[] = [];
  for (const file of listBootChecks(templatesDir)) {
    const src = readFileSync(file, 'utf8');
    const rel = file.startsWith(templatesDir) ? file.slice(templatesDir.length + 1) : file;
    if (!/function\s+pgDataDirLockedBy\s*\(/.test(src)) {
      violations.push(`${rel}: missing the pgDataDirLockedBy preflight function (EI-22125738148136740)`);
      continue;
    }
    const directCall = /pgDataDirLockedBy\(\s*section!\.pgDataDir\s*\)/.exec(src);
    const resolvedPathCall =
      /const\s+pgDataDir\s*=\s*bootPath\(\s*section!\.pgDataDir\s*\)\s*;[\s\S]*?pgDataDirLockedBy\(\s*pgDataDir\s*\)/.exec(
        src,
      );
    const lockCall = directCall ?? resolvedPathCall;
    if (!lockCall) {
      violations.push(
        `${rel}: spawn leg never calls pgDataDirLockedBy with section!.pgDataDir or its bootPath-resolved value`,
      );
      continue;
    }
    // Order matters: the whole point is failing BEFORE the expensive legs.
    const lockCallIdx = lockCall.index;
    const buildIdx = src.indexOf('section!.buildCommand?.length) {');
    const spawnIdx = src.indexOf('const [cmd, ...args] = section!.command!;');
    if (buildIdx !== -1 && lockCallIdx > buildIdx) {
      violations.push(`${rel}: pgDataDirLockedBy check runs AFTER buildCommand — must run before to actually fail fast`);
    }
    if (spawnIdx !== -1 && lockCallIdx > spawnIdx) {
      violations.push(`${rel}: pgDataDirLockedBy check runs AFTER the sidecar spawn — must run before to actually fail fast`);
    }
  }
  return violations;
}

/**
 * Exact behavioral mirror of the `pgDataDirLockedBy` function shipped in
 * every `templates/*​/checks/boot-e2e.test.ts` (kept in lockstep by
 * `findMissingPgLockGuard`'s structural presence check above, and by the
 * verbatim-content assertion in the coherence test below). Duplicated
 * rather than imported because the portable checks are deliberately
 * dependency-free of this package.
 */
function pgDataDirLockedBy(dataDir: string): number | null {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (!existsSync(pidFile)) return null;
  let raw: string;
  try {
    raw = readFileSync(pidFile, 'utf8');
  } catch {
    return null;
  }
  const pid = Number((raw.split('\n')[0] ?? '').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

describe('boot-e2e-pg-lock-guard', () => {
  it('every shipped boot-e2e check gates spawn on a locked boot.pgDataDir, ahead of build/spawn', () => {
    expect(existsSync(TEMPLATES_DIR), `no templates dir at ${TEMPLATES_DIR}`).toBe(true);
    expect(listBootChecks(TEMPLATES_DIR).length).toBeGreaterThan(0);
    expect(findMissingPgLockGuard(TEMPLATES_DIR)).toEqual([]);
  });

  it('every shipped check carries the exact same pgDataDirLockedBy body (drift guard)', () => {
    const checks = listBootChecks(TEMPLATES_DIR);
    expect(checks.length).toBeGreaterThan(0);
    const bodies = checks.map((file) => {
      const src = readFileSync(file, 'utf8');
      const match = src.match(/function pgDataDirLockedBy\(dataDir: string\): number \| null \{[\s\S]*?\n\}/);
      return { file, body: match?.[0] ?? null };
    });
    for (const { file, body } of bodies) {
      expect(body, `${file}: could not locate pgDataDirLockedBy body to compare`).not.toBeNull();
    }
    const [first, ...rest] = bodies;
    for (const other of rest) {
      expect(other.body, `${other.file} pgDataDirLockedBy has drifted from ${first!.file}`).toBe(first!.body);
    }
  });

  // ── falsifiability control (repo mutation-probe table tier 2: a fixture
  // tree, never the real checkout — git-sync sweeps the shared tree on a
  // schedule and would commit a mutant) ───────────────────────────────────
  describe('falsifiability (fixture tree, never the real one)', () => {
    const fixtures: string[] = [];
    const makeTree = (bootSource: string): string => {
      const root = mkdtempSync(join(tmpdir(), 'pg-lock-guard-'));
      fixtures.push(root);
      const checks = join(root, 'papercusp-fixture-app', 'checks');
      mkdirSync(checks, { recursive: true });
      writeFileSync(join(checks, 'boot-e2e.test.ts'), bootSource, 'utf8');
      return root;
    };
    afterAll(() => {
      for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
    });

    const CLEAN = [
      'function pgDataDirLockedBy(dataDir: string): number | null { return null; }',
      'if (section!.pgDataDir) {',
      '  const lockingPid = pgDataDirLockedBy(section!.pgDataDir);',
      '  expect(lockingPid, "locked").toBeNull();',
      '}',
      'if (section!.buildCommand?.length) {',
      '  /* build */',
      '}',
      'const [cmd, ...args] = section!.command!;',
    ].join('\n');

    it('passes a tree that gates spawn on the lock check (calibration)', () => {
      expect(findMissingPgLockGuard(makeTree(CLEAN))).toEqual([]);
    });

    it('catches a file missing the function entirely (the exact pre-fix shape)', () => {
      const preFix = CLEAN.split('\n')
        .filter((l) => !l.includes('pgDataDirLockedBy') && !l.includes('lockingPid') && !l.includes('section!.pgDataDir'))
        .join('\n');
      const violations = findMissingPgLockGuard(makeTree(preFix));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('missing the pgDataDirLockedBy preflight function');
    });

    it('catches a file that defines the function but never calls it on the spawn path', () => {
      const orphaned = CLEAN.replace(
        /if \(section!\.pgDataDir\) \{[\s\S]*?\n\}\n/,
        '',
      );
      const violations = findMissingPgLockGuard(makeTree(orphaned));
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('never calls pgDataDirLockedBy');
    });

    it('catches a lock check reordered to run AFTER the expensive spawn leg', () => {
      const reordered = [
        'function pgDataDirLockedBy(dataDir: string): number | null { return null; }',
        'if (section!.buildCommand?.length) {',
        '  /* build */',
        '}',
        'const [cmd, ...args] = section!.command!;',
        'if (section!.pgDataDir) {',
        '  const lockingPid = pgDataDirLockedBy(section!.pgDataDir);',
        '  expect(lockingPid, "locked").toBeNull();',
        '}',
      ].join('\n');
      const violations = findMissingPgLockGuard(makeTree(reordered));
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((v) => v.includes('runs AFTER'))).toBe(true);
    });

    it('reports nothing for a templates dir that does not exist', () => {
      expect(findMissingPgLockGuard(join(tmpdir(), 'pg-lock-guard-absent'))).toEqual([]);
    });
  });

  // ── the actual pid-liveness algorithm, exercised for real ──────────────
  describe('pgDataDirLockedBy algorithm (real files, real pids)', () => {
    let dir: string;
    const dirs: string[] = [];
    const freshDir = (): string => {
      const d = mkdtempSync(join(tmpdir(), 'pg-data-dir-'));
      dirs.push(d);
      return d;
    };
    afterAll(() => {
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    });

    it('returns null when no postmaster.pid exists (no lock at all)', () => {
      dir = freshDir();
      expect(pgDataDirLockedBy(dir)).toBeNull();
    });

    it('returns null for an unparseable postmaster.pid (stale/corrupt lockfile)', () => {
      dir = freshDir();
      writeFileSync(join(dir, 'postmaster.pid'), 'not-a-pid\n', 'utf8');
      expect(pgDataDirLockedBy(dir)).toBeNull();
    });

    it('returns null when the recorded pid is dead (a stale lock from an unclean exit)', () => {
      dir = freshDir();
      // Spawn a real short-lived child, capture its pid, wait for it to
      // actually exit — guaranteeing this pid is genuinely dead, not merely
      // a large improbable number that happens to be unused right now.
      //
      // BOUNDED deliberately (WI-41180 ratchet): a sync spawn blocks the worker's event
      // loop, so vitest cannot time it out, and the pure lane shares ONE fork across
      // ~2,740 files — an unbounded call here wedges all of them until the batch watchdog
      // kills the task 45 minutes later. 10s is ~3 orders of magnitude over what
      // `node -e 'process.exit(0)'` needs, so it can only fire on a genuinely wedged host.
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        timeout: 10_000,
        killSignal: 'SIGKILL',
      });
      const deadPid = child.pid;
      expect(typeof deadPid).toBe('number');
      writeFileSync(join(dir, 'postmaster.pid'), `${deadPid}\n`, 'utf8');
      expect(pgDataDirLockedBy(dir)).toBeNull();
    });

    it('returns the pid when a LIVE process holds the lock — the exact collision this guard exists for', () => {
      dir = freshDir();
      // This test process itself is unambiguously alive for the duration of
      // this assertion — the same ground truth `process.kill(pid, 0)` uses.
      writeFileSync(join(dir, 'postmaster.pid'), `${process.pid}\n`, 'utf8');
      expect(pgDataDirLockedBy(dir)).toBe(process.pid);
    });
  });
});
