/**
 * resolveCanonicalRoots (getPlansDir / getArchiveDir) — DEFAULT-path regression
 * guard (EI-89).
 *
 * 2026-06-06 incident: resolveCanonicalRoots used a runtime `require('node:fs')`
 * inside a try/catch. Under the tsx/ESM host `require` is undefined, so EVERY
 * `existsSync` candidate check silently threw — the catch swallowed it, every
 * candidate (the detected papercup root AND the cwd fallback) was skipped, and
 * the function fell through to its final `candidates[0] ?? cwd` return. That
 * mis-rooted the plan-markdown mirror into a nested
 * `apps/operator/apps/operator/docs/plans/` (316 stray files, caught minutes
 * before git-sync would have committed them).
 *
 * The plan that shipped this bug said BUILT+VERIFIED because its live-verify
 * called `planMarkdownRenderTick({ repoRoot })` — passing the OVERRIDE path,
 * which bypasses this candidate-search entirely. It never exercised the
 * DEFAULT path (no `repoRoot` — what the armed host actually calls in
 * production). This test pins exactly that default path: `getPlansDir({})` /
 * `getArchiveDir({})` with no override, so a regression (e.g. a future runtime
 * `require` swapped back in, or any other candidate-loop change that silently
 * skips every real candidate) fails LOUDLY here instead of shipping "verified"
 * again on the override-only path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const M = vi.hoisted(() => ({ detected: null as string | null }));

vi.mock('../../harness/register-papercusp', async (orig) => {
  const actual = await orig<typeof import('../../harness/register-papercusp')>();
  return { ...actual, detectPapercupRoot: vi.fn(() => M.detected) };
});

import { getPlansDir, getArchiveDir, PLANS_DIR_REL, ARCHIVE_DIR_REL } from './source';

const tmpDirs: string[] = [];
function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  M.detected = null;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('resolveCanonicalRoots — DEFAULT path (no repoRoot override), EI-89', () => {
  it('resolves to the DETECTED papercup root\'s plans/archive dirs when the marker dir exists there', () => {
    const root = makeRoot('ei89-detected-');
    mkdirSync(join(root, PLANS_DIR_REL), { recursive: true });
    M.detected = root;

    // No repoRoot passed — this is the exact "default resolution the armed
    // host actually uses" the incident's live-verify never exercised.
    expect(getPlansDir({})).toBe(join(root, PLANS_DIR_REL));
    expect(getArchiveDir({})).toBe(join(root, ARCHIVE_DIR_REL));

    // Never the mis-rooted nested-duplicate shape the silent-throw bug produced.
    expect(getPlansDir({})).not.toContain(join('apps', 'operator', 'apps', 'operator'));
  });

  it('falls back to a real existsSync candidate (cwd) when detection returns null, without throwing', () => {
    // detectPapercupRoot() returning null (e.g. packaged / non-repo host) must
    // not itself trip the bug class — the remaining candidate (cwd) still has
    // to be checked with a WORKING existsSync, not a silently-throwing one.
    const cwdRoot = makeRoot('ei89-cwd-');
    mkdirSync(join(cwdRoot, PLANS_DIR_REL), { recursive: true });
    M.detected = null;
    const priorCwd = process.cwd();
    process.chdir(cwdRoot);
    try {
      expect(() => getPlansDir({})).not.toThrow();
      expect(getPlansDir({})).toBe(join(cwdRoot, PLANS_DIR_REL));
    } finally {
      process.chdir(priorCwd);
    }
  });
});
