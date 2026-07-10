/**
 * pot-git-gate-quarantine-guard.test.ts — recurrence guard for
 * p2p-git-live-activation-2026-07-09 P-502 (regression rails).
 *
 * WI-3210 (2026-07-06) deliberately quarantined the BROAD p2p/shared-hive/
 * federation test lane (`lib/**\/*p2p*.test.ts`, `lib/**\/*federation*.test.ts`,
 * `lib/sync/hyperbee/**`, `lib/shared-hive-loop/**`, ...) out of the v1
 * green-checkpoint verdict — an explicit owner scope decision, NOT a gap.
 *
 * `lib/sync/pot-git/**` (the p2p GIT plane this activation plan is landing)
 * and `lib/harness/git-sync/**` (its one production caller) are DELIBERATELY
 * OUTSIDE that quarantine — pot-git is meant to gate for v1, unlike the
 * general federation/hyperbee substrate. Nothing currently quarantines them
 * (verified against the live root `quarantine.txt` below), but nothing STOPS
 * a future edit from widening a pattern (e.g. `lib/sync/**` "tidying up") or
 * adding a bare `lib/sync/pot-git/**` line and silently un-gating this whole
 * subsystem with no test failure to catch it.
 *
 * This test reads the REAL root `quarantine.txt` and exercises PRODUCTION's
 * own `parseTestQuarantine` / `isQuarantinedTestFile` (green-checkpoint.ts) —
 * the exact matcher the release gate runs — against every real pot-git /
 * git-sync test file on disk. It fails loudly, naming the offending file(s),
 * the moment either becomes quarantined.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTestQuarantine, isQuarantinedTestFile, type FailingFile } from './green-checkpoint';

const OPERATOR_CORE_WORKSPACE = '@papercusp/operator-core';

function resolveRepoRoot(from: string): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`resolveRepoRoot: no .git found walking up from ${from}`);
    dir = parent;
  }
}

function listTestFilesRecursive(absDir: string): string[] {
  const out: string[] = [];
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(absDir, e.name);
    if (e.isDirectory()) {
      out.push(...listTestFilesRecursive(full));
    } else if (e.isFile() && /\.test\.tsx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveRepoRoot(__dirname);
const OPERATOR_CORE_ROOT = join(REPO_ROOT, 'packages/operator-core');

const GUARDED_DIRS = [
  // The p2p git plane (serve/announce/integrator/worktree-bridge/gc/github-bridge).
  'lib/sync/pot-git',
  // Its one production wiring seam (git-sync-action.ts + the mode seam).
  'lib/harness/git-sync',
];

describe('pot-git gate quarantine guard (P-502)', () => {
  it('quarantine.txt exists and is parseable', () => {
    const quarantinePath = join(REPO_ROOT, 'quarantine.txt');
    expect(existsSync(quarantinePath)).toBe(true);
    const entries = parseTestQuarantine(readFileSync(quarantinePath, 'utf8'));
    expect(Array.isArray(entries)).toBe(true);
  });

  for (const guardedDir of GUARDED_DIRS) {
    it(`no test under ${guardedDir}/ is quarantined for ${OPERATOR_CORE_WORKSPACE}`, () => {
      const quarantinePath = join(REPO_ROOT, 'quarantine.txt');
      const entries = existsSync(quarantinePath) ? parseTestQuarantine(readFileSync(quarantinePath, 'utf8')) : [];

      const absDir = join(OPERATOR_CORE_ROOT, guardedDir);
      const files = listTestFilesRecursive(absDir);
      // Guard the guard: if this ever comes back empty the directory moved/was
      // renamed and this test would silently pass on nothing — fail loudly.
      expect(files.length).toBeGreaterThan(0);

      const offenders: string[] = [];
      for (const abs of files) {
        const workspaceRelative = relative(OPERATOR_CORE_ROOT, abs).split('\\').join('/');
        const failingFile: FailingFile = { workspace: OPERATOR_CORE_WORKSPACE, file: workspaceRelative };
        if (isQuarantinedTestFile(failingFile, entries)) offenders.push(workspaceRelative);
      }

      expect(
        offenders,
        `${offenders.length} pot-git/git-sync test file(s) are now matched by a quarantine.txt ` +
          `pattern and would silently stop gating the v1 green-checkpoint verdict: ${offenders.join(', ')}. ` +
          `pot-git is IN SCOPE for v1 (p2p-git-live-activation-2026-07-09) — unlike the general ` +
          `p2p/federation lane WI-3210 deliberately deferred to v2. If this is intentional, it needs an ` +
          `explicit owner decision + a filed de-quarantine follow-up (WI-3210's own pattern), not a silent glob widen.`,
      ).toEqual([]);
    });
  }

  it('the operator-core workspace itself is not blanket-quarantined', () => {
    const quarantinePath = join(REPO_ROOT, 'quarantine.txt');
    const entries = existsSync(quarantinePath) ? parseTestQuarantine(readFileSync(quarantinePath, 'utf8')) : [];
    const blanket = entries.find((e) => e.workspace === OPERATOR_CORE_WORKSPACE && e.pattern === null);
    expect(
      blanket,
      `${OPERATOR_CORE_WORKSPACE} has a bare (no ::pattern) quarantine.txt entry — that excludes the ` +
        `WHOLE workspace (including pot-git) from the affected-test run, not just a glob of files.`,
    ).toBeUndefined();
  });
});
