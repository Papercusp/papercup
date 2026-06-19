/**
 * fork-pr-contrib.test.ts — EN-4 P-CONTRIB wired into the fork→PR handler.
 *  - an editable-path policy REJECTS opening a PR whose changes are out of bounds
 *    (openForkPr never called) — the S0 "editable-path rule rejects an
 *    out-of-bounds change";
 *  - an in-bounds PR opens and carries the auto-merge verdict;
 *  - a `requireReview` policy opens the PR but marks auto-merge BLOCKED — the S0
 *    "require-review blocks auto-merge of a fork-PR".
 */

import { describe, it, expect, vi } from 'vitest';
import { handleFeaturePassed, type FeaturePassedDeps } from './fork-pr-on-feature-pass';
import type { ContribPolicy } from './contrib-policy';

const INPUT = { harnessSlug: 'papercup', featureId: 'F-001', workspaceId: 'ws1' };

function baseDeps(over: Partial<FeaturePassedDeps> = {}): FeaturePassedDeps {
  return {
    loadSharedConfig: vi.fn(async () => ({
      github_remote: 'https://github.com/papercupai/papercup',
      github_repository_id: 42,
    })),
    resolveRepoContext: vi.fn(async () => ({
      repoPath: '/tmp/clone',
      baseBranch: 'main',
      token: 'ghs_secret',
      upstreamOwner: 'papercupai',
      upstreamRepo: 'papercup',
    })),
    getPermission: vi.fn(async () => 'read' as const),
    ensureFeatureBranch: vi.fn(async () => {}),
    openForkPr: vi.fn(async () => ({
      ok: true as const,
      forkOwner: 'aviynw',
      forkFullName: 'aviynw/papercup',
      created: true,
      prNumber: 7,
      prUrl: 'https://github.com/papercupai/papercup/pull/7',
    })),
    ...over,
  };
}

describe('handleFeaturePassed — P-CONTRIB', () => {
  it('REJECTS opening a PR that touches an out-of-bounds path', async () => {
    const policy: ContribPolicy = { editablePaths: ['docs/**'] };
    const deps = baseDeps({
      loadContribPolicy: vi.fn(async () => policy),
      getChangedFiles: vi.fn(async () => ['docs/a.md', 'packages/core/secret.ts']),
    });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(out.opened).toBe(false);
    if (!out.opened) {
      expect(out.reason).toBe('contrib_path_denied');
      expect(out.detail).toContain('packages/core/secret.ts');
    }
    expect(deps.openForkPr).not.toHaveBeenCalled();
  });

  it('opens an in-bounds PR and carries the auto-merge verdict', async () => {
    const policy: ContribPolicy = { editablePaths: ['docs/**'], requireReview: false };
    const deps = baseDeps({
      loadContribPolicy: vi.fn(async () => policy),
      getChangedFiles: vi.fn(async () => ['docs/guide.md']),
    });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(out.opened).toBe(true);
    if (out.opened) {
      expect(out.contrib?.pathsAllowed).toBe(true);
      expect(out.contrib?.autoMergeAllowed).toBe(true);
    }
    expect(deps.openForkPr).toHaveBeenCalled();
  });

  it('require-review opens the PR but BLOCKS auto-merge', async () => {
    const policy: ContribPolicy = { requireReview: true };
    const deps = baseDeps({ loadContribPolicy: vi.fn(async () => policy) });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(out.opened).toBe(true);
    if (out.opened) {
      expect(out.contrib?.autoMergeAllowed).toBe(false);
      expect(out.contrib?.autoMergeBlockedBy).toContain('requireReview');
    }
  });

  it('no contrib policy ⇒ unchanged fork-PR flow (no contrib key)', async () => {
    const deps = baseDeps(); // no loadContribPolicy
    const out = await handleFeaturePassed(INPUT, deps);
    expect(out).toEqual({
      opened: true,
      prUrl: 'https://github.com/papercupai/papercup/pull/7',
      forkOwner: 'aviynw',
    });
  });
});
