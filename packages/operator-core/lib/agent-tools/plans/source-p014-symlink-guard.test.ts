/**
 * P-014 runtime guard — checkout identity normalization (WI-1341,
 * EI-22682015531897411).
 *
 * resolveHarnessPlansDir()'s P-014 guard compared `project.path` (the registry
 * path) against the detected repo root with STRING-ONLY `path.resolve`. The
 * canonical checkout is reachable via a `papercup` → `papercusp` SYMLINK, so two
 * strings naming the SAME directory compared unequal and the guard threw
 * "registry is out of sync" — breaking fleet:launch-on-plan and every launch
 * path that resolves the home harness. The fix normalizes both sides with
 * `fs.realpathSync` (falling back to path.resolve for a not-yet-existing path).
 *
 * These tests pin the CONTRACT: a symlinked or linked-worktree path PASSES the
 * guard, while a genuinely different path STILL throws (the guard keeps its
 * intent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = 'papercusp';

// Mutable knobs the mocks read at call time (set per-test).
const M = vi.hoisted(() => ({
  detected: '' as string | null,
  projectPath: '' as string,
}));

vi.mock('../../harness-registry', async (orig) => {
  const actual = await orig<typeof import('../../harness-registry')>();
  return {
    ...actual,
    loadHarnessRegistry: vi.fn(async () => ({
      projects: [{ slug: HOME, path: M.projectPath }],
    })),
  };
});

vi.mock('../../harness-core', async (orig) => {
  const actual = await orig<typeof import('../../harness-core')>();
  return {
    ...actual,
    resolveProject: vi.fn(async () => ({ slug: HOME, path: M.projectPath })),
  };
});

vi.mock('../../harness/register-papercusp', async (orig) => {
  const actual = await orig<typeof import('../../harness/register-papercusp')>();
  return {
    ...actual,
    detectPapercupRoot: vi.fn(() => M.detected),
  };
});

import { resolveHarnessPlansDir } from './source';

const SAVED_HOME_ENV = process.env.PAPERCUSP_POT_HOME_SLUG;
const tmpDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  // The two papercup markers detectPapercupRoot() looks for — harmless here
  // (detection is mocked) but keeps the fixture a faithful repo root.
  mkdirSync(join(dir, 'apps', 'operator'), { recursive: true });
  mkdirSync(join(dir, 'libs', 'papercusp'), { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.PAPERCUSP_POT_HOME_SLUG = HOME;
});

afterEach(() => {
  if (SAVED_HOME_ENV === undefined) delete process.env.PAPERCUSP_POT_HOME_SLUG;
  else process.env.PAPERCUSP_POT_HOME_SLUG = SAVED_HOME_ENV;
  for (const d of tmpDirs.splice(0)) {
    rmSync(`${d}-link`, { recursive: true, force: true }); // any leftover symlink
    rmSync(d, { recursive: true, force: true });
  }
});

describe('resolveHarnessPlansDir — P-014 guard symlink normalization', () => {
  it('does NOT throw when the registry path is a SYMLINK to the detected repo root (the bug)', async () => {
    const realRoot = makeRepoRoot('p014-real-');
    const link = `${realRoot}-link`;
    symlinkSync(realRoot, link); // a second path that points at the SAME checkout
    // registry stores the symlink path; detection returns the real path.
    M.projectPath = link;
    M.detected = realRoot;

    const res = await resolveHarnessPlansDir(HOME);
    expect(res.harnessSlug).toBe(HOME);
    // plansRelFor() also realpath-normalizes, so the home harness still gets the
    // papercup plans rel (apps/operator/docs/plans), NOT the default docs/plans.
    expect(res.plans.endsWith(join('apps', 'operator', 'docs', 'plans'))).toBe(true);

    rmSync(link, { recursive: true, force: true });
  });

  it('does NOT throw when detection returns the SYMLINK and the registry has the real path (reverse)', async () => {
    const realRoot = makeRepoRoot('p014-rev-');
    const link = `${realRoot}-link`;
    symlinkSync(realRoot, link);
    M.projectPath = realRoot;
    M.detected = link;

    await expect(resolveHarnessPlansDir(HOME)).resolves.toMatchObject({ harnessSlug: HOME });

    rmSync(link, { recursive: true, force: true });
  });

  it('does NOT throw when detection returns a linked staging worktree of the registry checkout', async () => {
    const canonicalRoot = makeRepoRoot('p014-canonical-');
    const stagingRoot = makeRepoRoot('p014-staging-');
    const worktreeGitDir = join(canonicalRoot, '.git', 'worktrees', 'staging');
    mkdirSync(worktreeGitDir, { recursive: true });
    // Match Git's linked-worktree metadata: the checkout points to its private
    // gitdir, whose commondir resolves back to the canonical .git directory.
    writeFileSync(join(stagingRoot, '.git'), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n');
    M.projectPath = canonicalRoot;
    M.detected = stagingRoot;

    const res = await resolveHarnessPlansDir(HOME);
    expect(res.harnessSlug).toBe(HOME);
    expect(res.plans.endsWith(join('apps', 'operator', 'docs', 'plans'))).toBe(true);
  });

  it('STILL throws P-014 on a genuine path mismatch (guard intent preserved)', async () => {
    const realRoot = makeRepoRoot('p014-mismatch-a-');
    const otherRoot = makeRepoRoot('p014-mismatch-b-');
    M.projectPath = realRoot;
    M.detected = otherRoot; // two DIFFERENT checkouts — a real registry desync

    await expect(resolveHarnessPlansDir(HOME)).rejects.toThrow(/P-014 runtime guard/);
  });

  it('does NOT throw when detection returns null (no repo root detected)', async () => {
    const realRoot = makeRepoRoot('p014-null-');
    M.projectPath = realRoot;
    M.detected = null; // packaged install / non-repo cwd — guard is skipped

    await expect(resolveHarnessPlansDir(HOME)).resolves.toMatchObject({ harnessSlug: HOME });
  });
});
