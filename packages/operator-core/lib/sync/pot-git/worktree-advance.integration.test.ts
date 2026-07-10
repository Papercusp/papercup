/**
 * worktree-advance.integration.test.ts — G-7c ff-only advance + the G-7b
 * dirty-safety invariant against a REAL temp worktree (P-040 + P-036).
 * Acceptance pinned here (lane C brief):
 *   - a ff-advance updates the worktree; a divergent one is refused + surfaced;
 *   - a dirty file blocks the advance that would touch it; a clean (or
 *     disjointly-dirty) tree advances and local edits are PRESERVED;
 *   - the module never rewinds and never resets.
 *
 * The fixture rewinds ITS OWN throwaway temp repo with `reset --hard` between
 * cases — that is test plumbing on a private tmpdir, NEVER the shared-tree
 * pattern (the module under test itself never resets; that is the invariant).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/worktree-advance.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunGit } from './storage';
import { advanceWorktree } from './worktree-advance';

async function git(args: string[], cwd: string): Promise<string> {
  const r = await defaultRunGit(args, cwd);
  expect(r.code, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

async function initWorktree(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(['init', '-q', '-b', 'main'], dir);
  await git(['config', 'user.name', 't'], dir);
  await git(['config', 'user.email', 't@t'], dir);
}

describe('worktree-advance (G-7c/G-7b against a real worktree)', () => {
  let root: string;
  let wt: string;
  let shaA = '';
  /** Child of A: f.txt v1→v2, adds new-in-b.txt. */
  let shaB = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgwtadv-'));
    wt = join(root, 'wt');
    await initWorktree(wt);
    await writeFile(join(wt, 'f.txt'), 'v1\n');
    await writeFile(join(wt, 'g.txt'), 'g1\n');
    await git(['add', '.'], wt);
    await git(['commit', '-q', '-m', 'A'], wt);
    shaA = await git(['rev-parse', 'HEAD'], wt);
    await writeFile(join(wt, 'f.txt'), 'v2\n');
    await writeFile(join(wt, 'new-in-b.txt'), 'b\n');
    await git(['add', '.'], wt);
    await git(['commit', '-q', '-m', 'B'], wt);
    shaB = await git(['rev-parse', 'HEAD'], wt);
    // Keep B reachable while main rewinds between cases (fixture bookkeeping).
    await git(['branch', 'keep-b', shaB], wt);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** FIXTURE-ONLY rewind of the private temp repo between cases. */
  async function rewindTo(sha: string): Promise<void> {
    await git(['reset', '--hard', '-q', sha], wt);
    await git(['clean', '-fdq'], wt);
  }

  it('a clean fast-forward advances the worktree to the target', async () => {
    await rewindTo(shaA);
    const res = await advanceWorktree(wt, shaB);
    expect(res).toMatchObject({ outcome: 'advanced', from: shaA, to: shaB });
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(shaB);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v2\n');
    expect(await readFile(join(wt, 'new-in-b.txt'), 'utf8')).toBe('b\n');
  });

  it('advancing to the current head is a noop (identical)', async () => {
    const res = await advanceWorktree(wt, shaB); // HEAD is at B from the previous case
    expect(res.outcome).toBe('noop');
    expect(res.detail).toBe('identical');
  });

  it('NEVER rewinds: a target the local head already contains is a noop (local-ahead)', async () => {
    const res = await advanceWorktree(wt, shaA); // HEAD at B, target its parent A
    expect(res.outcome).toBe('noop');
    expect(res.detail).toBe('local-ahead');
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(shaB);
  });

  it('a divergent target is refused + surfaced; the worktree is untouched', async () => {
    // A sibling of B: same tree as A, parent A — minted with plumbing so the
    // worktree (at B) never moves.
    const divergent = await git(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', `${shaA}^{tree}`, '-p', shaA, '-m', 'divergent'],
      wt,
    );
    const res = await advanceWorktree(wt, divergent);
    expect(res.outcome).toBe('diverged-manual');
    expect(res.detail).toMatch(/manual|fast-forward/i);
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(shaB);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v2\n');
  });

  it('G-7b: a dirty file the advance would overwrite DEFERS the advance and is preserved', async () => {
    await rewindTo(shaA);
    await writeFile(join(wt, 'f.txt'), 'precious local edit\n'); // B touches f.txt
    const res = await advanceWorktree(wt, shaB);
    expect(res.outcome).toBe('deferred-dirty');
    expect(res.dirtyOverlap).toContain('f.txt');
    // NOTHING moved, NOTHING clobbered.
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(shaA);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('precious local edit\n');
  });

  it('G-7b: dirty files DISJOINT from the incoming change do not block — and survive the advance', async () => {
    await rewindTo(shaA);
    await writeFile(join(wt, 'g.txt'), 'local g edit\n'); // B does NOT touch g.txt
    await writeFile(join(wt, 'untracked.txt'), 'scratch\n'); // untracked, not in B
    const res = await advanceWorktree(wt, shaB);
    expect(res.outcome).toBe('advanced');
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(shaB);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v2\n'); // advanced
    expect(await readFile(join(wt, 'g.txt'), 'utf8')).toBe('local g edit\n'); // preserved
    expect(await readFile(join(wt, 'untracked.txt'), 'utf8')).toBe('scratch\n'); // preserved
  });

  it('an unborn HEAD seeds from the target (fresh joiner)', async () => {
    const wt2 = join(root, 'wt2');
    await initWorktree(wt2);
    await git(['fetch', '-q', wt, `+refs/heads/keep-b:refs/hive/staging`], wt2);
    const res = await advanceWorktree(wt2, shaB);
    expect(res.outcome, res.detail).toBe('advanced');
    expect(res.from).toBeNull();
    expect(await git(['rev-parse', 'HEAD'], wt2)).toBe(shaB);
    expect(await readFile(join(wt2, 'f.txt'), 'utf8')).toBe('v2\n');
  });

  it('an unborn HEAD with an untracked file in the way DEFERS (nothing clobbered)', async () => {
    const wt3 = join(root, 'wt3');
    await initWorktree(wt3);
    await git(['fetch', '-q', wt, `+refs/heads/keep-b:refs/hive/staging`], wt3);
    await writeFile(join(wt3, 'f.txt'), 'pre-existing\n'); // in the target tree
    const res = await advanceWorktree(wt3, shaB);
    expect(res.outcome).toBe('deferred-dirty');
    expect(res.dirtyOverlap).toContain('f.txt');
    expect(await readFile(join(wt3, 'f.txt'), 'utf8')).toBe('pre-existing\n');
  });

  it('a target missing from the ODB is an error (fetch-before-advance contract)', async () => {
    const res = await advanceWorktree(wt, 'c'.repeat(40));
    expect(res.outcome).toBe('error');
    expect(res.detail).toMatch(/not present/i);
  });

  it('a non-worktree path is an error, not a throw', async () => {
    const notRepo = join(root, 'not-a-repo');
    await mkdir(notRepo, { recursive: true });
    const res = await advanceWorktree(notRepo, shaB);
    expect(res.outcome).toBe('error');
  });
});
