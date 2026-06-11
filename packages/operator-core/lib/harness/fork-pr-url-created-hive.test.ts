/**
 * fork-pr-url-created-hive.test.ts — P-014 (unit half): the feature-passed
 * fork→PR flow fires for a URL-CREATED hive member (registry coords, no
 * shared.json) and targets the DETECTED default branch. Composes the real
 * handleFeaturePassed with deps wired exactly like orchestrator-runner's
 * realFeaturePassedDeps now are (upstream-repo-context chain), seams faked at
 * the registry/git/GitHub edges. The supervised LIVE run (real repo, real PR)
 * is the owner-gated other half of P-014.
 */
import { describe, it, expect } from 'vitest';
import { handleFeaturePassed, type FeaturePassedDeps } from './fork-pr-on-feature-pass';
import { resolveUpstreamRepoSource, upstreamGateAllows } from './upstream-repo-context';
import type { ProjectEntry } from '../harness-registry';

/** A URL-created hive member: registry coords + hive membership, NO shared.json. */
const URL_CREATED_MEMBER: ProjectEntry = {
  slug: 'shop',
  path: '/clones/shop',
  hive_slug: 'shop-hive',
  github_remote: 'https://github.com/upstream-org/shop.git',
  github_repository_id: 100,
  github_default_branch: 'develop',
};

function depsFor(
  project: ProjectEntry,
  over: Partial<FeaturePassedDeps> = {},
): { deps: FeaturePassedDeps; opened: Record<string, unknown>[] } {
  const opened: Record<string, unknown>[] = [];
  const upstreamDeps = {
    loadSharedConfig: () => null, // the URL-created case: no shared.json
    gitRemoteUrl: async () => null,
    gitOriginHead: async () => null,
  };
  const deps: FeaturePassedDeps = {
    loadSharedConfig: async () => {
      const src = await resolveUpstreamRepoSource(project, upstreamDeps);
      if (!src || !upstreamGateAllows(project, src)) return null;
      return { github_remote: src.github_remote, github_repository_id: src.github_repository_id ?? 0 };
    },
    resolveRepoContext: async () => {
      const src = await resolveUpstreamRepoSource(project, upstreamDeps);
      if (!src) return null;
      return {
        repoPath: project.path,
        baseBranch: src.default_branch ?? 'main',
        token: 't0ken',
        upstreamOwner: src.owner,
        upstreamRepo: src.repo,
      };
    },
    getPermission: async () => 'read', // non-collaborator → fork mode
    ensureFeatureBranch: async () => {},
    openForkPr: async (opts) => {
      opened.push(opts as unknown as Record<string, unknown>);
      return { ok: true, prUrl: 'https://github.com/upstream-org/shop/pull/7', prNumber: 7 };
    },
    log: () => {},
    ...over,
  };
  return { deps, opened };
}

describe('fork→PR for a URL-created hive member (P-014 unit half)', () => {
  it('fires end-to-end: gate passes on registry coords, PR targets the detected default branch', async () => {
    const { deps, opened } = depsFor(URL_CREATED_MEMBER);
    const out = await handleFeaturePassed(
      { harnessSlug: 'shop', featureId: 'F-001', workspaceId: 'ws' },
      deps,
    );
    expect(out).toMatchObject({ opened: true });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      upstreamOwner: 'upstream-org',
      upstreamRepo: 'shop',
      baseBranch: 'develop', // NOT the old hardcoded 'main'
    });
  });

  it('write permission → integration mode, no fork PR (lazy-fork rule, D-005)', async () => {
    const { deps, opened } = depsFor(URL_CREATED_MEMBER, { getPermission: async () => 'write' });
    const out = await handleFeaturePassed(
      { harnessSlug: 'shop', featureId: 'F-001', workspaceId: 'ws' },
      deps,
    );
    expect(out).toMatchObject({ opened: false, reason: 'integration_mode' });
    expect(opened).toHaveLength(0);
  });

  it('a STANDALONE url-registered harness stays gated out (no surprise PRs)', async () => {
    const standalone: ProjectEntry = { ...URL_CREATED_MEMBER, hive_slug: undefined };
    const { deps, opened } = depsFor(standalone);
    const out = await handleFeaturePassed(
      { harnessSlug: 'shop', featureId: 'F-001', workspaceId: 'ws' },
      deps,
    );
    expect(out).toMatchObject({ opened: false, reason: 'not_shared' });
    expect(opened).toHaveLength(0);
  });
});
