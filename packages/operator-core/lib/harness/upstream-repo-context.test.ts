/**
 * upstream-repo-context.test.ts — the fork-PR context source chain + gate
 * (hive-from-github-url P-013 / D-005). All seams injected.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveUpstreamRepoSource,
  upstreamGateAllows,
  type UpstreamRepoDeps,
} from './upstream-repo-context';

const noGit: Pick<UpstreamRepoDeps, 'gitRemoteUrl' | 'gitOriginHead'> = {
  gitRemoteUrl: async () => null,
  gitOriginHead: async () => null,
};

describe('resolveUpstreamRepoSource (P-013)', () => {
  it('shared.json wins over registry coords (legacy precedence preserved)', async () => {
    const src = await resolveUpstreamRepoSource(
      {
        path: '/p',
        github_remote: 'https://github.com/registry/other.git',
        github_repository_id: 2,
      },
      {
        loadSharedConfig: () => ({
          github_remote: 'https://github.com/shared/repo',
          github_repository_id: 1,
        }),
        ...noGit,
      },
    );
    expect(src).toMatchObject({
      source: 'shared-config',
      owner: 'shared',
      repo: 'repo',
      github_repository_id: 1,
    });
  });

  it('falls back to registry coords (the URL-created harness case) incl. default branch', async () => {
    const src = await resolveUpstreamRepoSource(
      {
        path: '/p',
        github_remote: 'https://github.com/acme/shop.git',
        github_repository_id: 100,
        github_default_branch: 'develop',
      },
      { loadSharedConfig: () => null, ...noGit },
    );
    expect(src).toMatchObject({
      source: 'registry',
      owner: 'acme',
      repo: 'shop',
      github_repository_id: 100,
      default_branch: 'develop',
    });
  });

  it('falls back to git remote origin as the last source', async () => {
    const src = await resolveUpstreamRepoSource(
      { path: '/p' },
      {
        loadSharedConfig: () => null,
        gitRemoteUrl: async () => 'git@github.com:acme/legacy.git',
        gitOriginHead: async () => 'origin/master',
      },
    );
    expect(src).toMatchObject({
      source: 'git-remote',
      owner: 'acme',
      repo: 'legacy',
      default_branch: 'master',
    });
  });

  it('origin/HEAD supplies the default branch when the registry has none', async () => {
    const src = await resolveUpstreamRepoSource(
      { path: '/p', github_remote: 'https://github.com/acme/shop' },
      { loadSharedConfig: () => null, gitRemoteUrl: async () => null, gitOriginHead: async () => 'origin/trunk' },
    );
    expect(src?.default_branch).toBe('trunk');
  });

  it('no known upstream anywhere → null (fork-PR correctly no-ops)', async () => {
    const src = await resolveUpstreamRepoSource(
      { path: '/p' },
      { loadSharedConfig: () => null, ...noGit },
    );
    expect(src).toBeNull();
  });

  it('a non-GitHub remote → null (only GitHub upstreams fork-PR)', async () => {
    const src = await resolveUpstreamRepoSource(
      { path: '/p' },
      {
        loadSharedConfig: () => null,
        gitRemoteUrl: async () => 'https://gitlab.com/a/b.git',
        gitOriginHead: async () => null,
      },
    );
    expect(src).toBeNull();
  });
});

describe('upstreamGateAllows (P-013 gate)', () => {
  const sharedSrc = { source: 'shared-config' } as never;
  const registrySrc = { source: 'registry' } as never;

  it('shared.json always passes (legacy behavior)', () => {
    expect(upstreamGateAllows({ }, sharedSrc)).toBe(true);
  });

  it('registry coords pass only for hive members / hive homes', () => {
    expect(upstreamGateAllows({ hive_slug: 'myhive' }, registrySrc)).toBe(true);
    expect(upstreamGateAllows({ harness_kind: 'hive' }, registrySrc)).toBe(true);
    // standalone private harness with coords: feature-pass must NOT
    // side-effect PRs onto someone's repo
    expect(upstreamGateAllows({ github_remote: 'https://github.com/a/b' }, registrySrc)).toBe(false);
  });
});
