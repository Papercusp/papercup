/**
 * open-fork-pr.test.ts — operator-side composition for the non-collaborator
 * code→PR path (non-collaborator-join-fork-pr sub-project B3, operator half).
 *
 * openForkPr() composes the three already-tested primitives — ensureFork (B1),
 * an authed git push to the fork (B4 clone-url), and a cross-fork openPr (B2) —
 * into one call the orchestrator's feature-passed hook can invoke. All three
 * are injected as seams here (no real git / GitHub).
 */

import { describe, it, expect, vi } from 'vitest';
import { openForkPr, type OpenForkPrOpts } from './open-fork-pr';

function baseOpts(overrides: Partial<OpenForkPrOpts> = {}): OpenForkPrOpts {
  return {
    upstreamRemote: 'github.com/papercupai/papercup',
    upstreamOwner: 'papercupai',
    upstreamRepo: 'papercup',
    baseBranch: 'main',
    featureBranch: 'harness/F-001',
    localRepoPath: '/tmp/clone',
    title: 'F-001: do the thing',
    body: 'feature body',
    token: 'ghs_secret',
    ensureForkFn: vi.fn(async () => ({
      forkOwner: 'aviynw',
      forkFullName: 'aviynw/papercup',
      created: true,
    })),
    pushFn: vi.fn(async () => {}),
    openPrFn: vi.fn(async () => ({
      ok: true as const,
      data: { ref: { remote: 'github.com/papercupai/papercup', number: 7 }, url: 'https://github.com/papercupai/papercup/pull/7' },
    })),
    ...overrides,
  } as OpenForkPrOpts;
}

describe('openForkPr', () => {
  it('ensures a fork, pushes the feature branch to it, and opens a cross-fork PR', async () => {
    const opts = baseOpts();
    const result = await openForkPr(opts);

    expect(opts.ensureForkFn).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamOwner: 'papercupai', upstreamRepo: 'papercup' }),
    );
    // pushed to the fork (not upstream), to the feature branch
    expect(opts.pushFn).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/tmp/clone',
        forkFullName: 'aviynw/papercup',
        branch: 'harness/F-001',
        token: 'ghs_secret',
      }),
    );
    // cross-fork PR: head namespaced to fork owner, opened on the upstream remote
    expect(opts.openPrFn).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: 'github.com/papercupai/papercup',
        head_ref: 'harness/F-001',
        head_owner: 'aviynw',
        base_ref: 'main',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.forkOwner).toBe('aviynw');
      expect(result.prNumber).toBe(7);
      expect(result.prUrl).toBe('https://github.com/papercupai/papercup/pull/7');
    }
  });

  it('does NOT namespace the head when the fork owner equals the upstream owner (no fork needed)', async () => {
    const opts = baseOpts({
      ensureForkFn: vi.fn(async () => ({
        forkOwner: 'papercupai', // same as upstream owner → ensureFork short-circuited
        forkFullName: 'papercupai/papercup',
        created: false,
      })),
    });
    await openForkPr(opts);
    const prArg = vi.mocked(opts.openPrFn!).mock.calls[0]?.[0] as unknown as {
      head_owner?: string;
      head_ref: string;
    };
    // same-owner: a normal same-repo PR (no cross-fork head namespacing)
    expect(prArg.head_owner).toBeUndefined();
    expect(prArg.head_ref).toBe('harness/F-001');
  });

  it('surfaces a PR-open failure as { ok: false }', async () => {
    const opts = baseOpts({
      openPrFn: vi.fn(async () => ({
        ok: false as const,
        error: { kind: 'forbidden' as const, message: 'no access' },
      })),
    });
    const result = await openForkPr(opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no access|forbidden/i);
  });

  it('propagates a push failure (redacted) without opening a PR', async () => {
    const opts = baseOpts({
      pushFn: vi.fn(async () => {
        throw new Error("failed to push to 'https://x-access-token:ghs_secret@github.com/aviynw/papercup.git'");
      }),
    });
    const result = await openForkPr(opts);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).not.toContain('ghs_secret');
    }
    expect(opts.openPrFn).not.toHaveBeenCalled();
  });
});
