/**
 * fork-pr-on-feature-pass.test.ts — the operator handler wired to the DBOS
 * pipeline's feature-passed hook (non-collaborator-join-fork-pr B3 / P-002).
 *
 * In fork mode (the local identity lacks upstream write) it creates a per-feature
 * branch at HEAD and opens a cross-fork PR via openForkPr. In owner/integration
 * mode (write/admin/maintain) it is a no-op. It is best-effort: it NEVER throws,
 * so a failure can't fail the already-successful pipeline. All seams injected.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleFeaturePassed, type FeaturePassedDeps } from './fork-pr-on-feature-pass';
import { AGENT_COAUTHOR_TRAILER } from './agent-trailer';

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
      authorGithubUserId: 4242,
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

describe('handleFeaturePassed', () => {
  it('fork mode (read permission): creates harness/<fid> branch and opens a cross-fork PR', async () => {
    const deps = baseDeps();
    const out = await handleFeaturePassed(INPUT, deps);
    expect(deps.ensureFeatureBranch).toHaveBeenCalledWith({
      repoPath: '/tmp/clone',
      featureBranch: 'harness/F-001',
    });
    expect(deps.openForkPr).toHaveBeenCalledWith(
      expect.objectContaining({
        upstreamOwner: 'papercupai',
        upstreamRepo: 'papercup',
        baseBranch: 'main',
        featureBranch: 'harness/F-001',
        localRepoPath: '/tmp/clone',
        token: 'ghs_secret',
      }),
    );
    expect(out).toEqual({ opened: true, prUrl: 'https://github.com/papercupai/papercup/pull/7', forkOwner: 'aviynw' });
  });

  it('fork mode (no permission/"none"): still opens a cross-fork PR', async () => {
    const deps = baseDeps({ getPermission: vi.fn(async () => 'none' as const) });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(deps.openForkPr).toHaveBeenCalled();
    expect(out.opened).toBe(true);
  });

  it('integration mode (write permission): no branch, no PR', async () => {
    const deps = baseDeps({ getPermission: vi.fn(async () => 'write' as const) });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(deps.ensureFeatureBranch).not.toHaveBeenCalled();
    expect(deps.openForkPr).not.toHaveBeenCalled();
    expect(out).toEqual({ opened: false, reason: 'integration_mode' });
  });

  it('integration mode (admin / maintain): no PR', async () => {
    for (const perm of ['admin', 'maintain'] as const) {
      const deps = baseDeps({ getPermission: vi.fn(async () => perm) });
      const out = await handleFeaturePassed(INPUT, deps);
      expect(deps.openForkPr).not.toHaveBeenCalled();
      expect(out).toEqual({ opened: false, reason: 'integration_mode' });
    }
  });

  it('not shared (no shared.json): no-op', async () => {
    const deps = baseDeps({ loadSharedConfig: vi.fn(async () => null) });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(deps.getPermission).not.toHaveBeenCalled();
    expect(deps.openForkPr).not.toHaveBeenCalled();
    expect(out).toEqual({ opened: false, reason: 'not_shared' });
  });

  it('no repo context: no-op', async () => {
    const deps = baseDeps({ resolveRepoContext: vi.fn(async () => null) });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(deps.openForkPr).not.toHaveBeenCalled();
    expect(out).toEqual({ opened: false, reason: 'no_repo_context' });
  });

  it('PR failure: reports pr_failed, does not throw', async () => {
    const deps = baseDeps({
      openForkPr: vi.fn(async () => ({ ok: false as const, error: 'no access' })),
    });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(out).toEqual({ opened: false, reason: 'pr_failed', detail: 'no access' });
  });

  it('best-effort: a thrown dep never propagates (returns {opened:false, reason:"error"})', async () => {
    const deps = baseDeps({
      resolveRepoContext: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(out.opened).toBe(false);
    if (!out.opened) expect(out.reason).toBe('error');
  });
});

describe('handleFeaturePassed — PR-4 (WI↔PR producer + agent trailer + identity)', () => {
  it('records the WI→PR row attributed to the human operator when a PR opens', async () => {
    const recordFeaturePrOpened = vi.fn(async () => {});
    const deps = baseDeps({ recordFeaturePrOpened });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(out.opened).toBe(true);
    expect(recordFeaturePrOpened).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      harnessSlug: 'papercup',
      featureId: 'F-001',
      prUrl: 'https://github.com/papercupai/papercup/pull/7',
      authorGithubUserId: 4242, // the resolved gh operator id from the repo context
    });
  });

  it('marks the PR body agent-authored (Co-authored-by: papercusp-bee trailer)', async () => {
    const deps = baseDeps();
    await handleFeaturePassed(INPUT, deps);
    expect(deps.openForkPr).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(AGENT_COAUTHOR_TRAILER) }),
    );
  });

  it('a producer write failure does NOT flip a successful open to opened:false', async () => {
    const recordFeaturePrOpened = vi.fn(async () => {
      throw new Error('pg down');
    });
    const deps = baseDeps({ recordFeaturePrOpened });
    const out = await handleFeaturePassed(INPUT, deps);
    expect(out).toEqual({ opened: true, prUrl: 'https://github.com/papercupai/papercup/pull/7', forkOwner: 'aviynw' });
  });

  it('records NO row when not in fork mode (integration) or the PR fails', async () => {
    const recIntegration = vi.fn(async () => {});
    await handleFeaturePassed(
      INPUT,
      baseDeps({ getPermission: vi.fn(async () => 'write' as const), recordFeaturePrOpened: recIntegration }),
    );
    expect(recIntegration).not.toHaveBeenCalled();

    const recFailed = vi.fn(async () => {});
    await handleFeaturePassed(
      INPUT,
      baseDeps({
        openForkPr: vi.fn(async () => ({ ok: false as const, error: 'no access' })),
        recordFeaturePrOpened: recFailed,
      }),
    );
    expect(recFailed).not.toHaveBeenCalled();
  });

  it('records author=null when the operator identity could not be resolved', async () => {
    const recordFeaturePrOpened = vi.fn(async () => {});
    const deps = baseDeps({
      recordFeaturePrOpened,
      resolveRepoContext: vi.fn(async () => ({
        repoPath: '/tmp/clone',
        baseBranch: 'main',
        token: 'ghs_secret',
        upstreamOwner: 'papercupai',
        upstreamRepo: 'papercup',
        // authorGithubUserId omitted (unresolved)
      })),
    });
    await handleFeaturePassed(INPUT, deps);
    expect(recordFeaturePrOpened).toHaveBeenCalledWith(
      expect.objectContaining({ authorGithubUserId: null }),
    );
  });
});
