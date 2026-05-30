/**
 * github-facts.test.ts — unit tests for the Insights ProjectCard GitHub loader.
 *
 * No live GitHub / PG / git: the pure mapper is tested directly, and
 * loadProjectCardFromGithub gets octokit / resolveRepoPath / ownerName / now
 * all injected.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  mapRepoFactsToProjectCard,
  parseGithubRemote,
  loadProjectCardFromGithub,
  mapContributorsToCommitCounts,
  loadGithubContributorCommits,
  _clearGithubFactsCacheForTests,
  type GithubRepoResponse,
} from './github-facts';

const REPO: GithubRepoResponse = {
  name: 'papercup',
  description: 'A multi-agent coding harness',
  html_url: 'https://github.com/Papercusp/papercup',
  owner: { login: 'Papercusp' },
  license: { spdx_id: 'MIT' },
  stargazers_count: 42,
  forks_count: 7,
  open_issues_count: 3,
  pushed_at: '2026-05-30T00:00:00Z',
};

describe('mapRepoFactsToProjectCard', () => {
  it('maps the core GitHub fields', () => {
    const p = mapRepoFactsToProjectCard(REPO, { TypeScript: 8000, CSS: 2000 });
    expect(p.name).toBe('papercup');
    expect(p.description).toBe('A multi-agent coding harness');
    expect(p.ownerDisplayName).toBe('Papercusp');
    expect(p.license).toBe('MIT');
    expect(p.githubUrl).toBe('https://github.com/Papercusp/papercup');
    expect(p.stars).toBe(42);
    expect(p.forks).toBe(7);
    expect(p.openIssues).toBe(3);
    expect(p.lastActivityIso).toBe('2026-05-30T00:00:00Z');
  });

  it('computes top languages with percent + linguist color', () => {
    const p = mapRepoFactsToProjectCard(REPO, { TypeScript: 7500, CSS: 2000, HTML: 500 });
    expect(p.languages).toEqual([
      { name: 'TypeScript', color: '#3178c6', percent: 75 },
      { name: 'CSS', color: '#563d7c', percent: 20 },
      { name: 'HTML', color: '#e34c26', percent: 5 },
    ]);
  });

  it('caps languages at top 3 and falls back to gray for unknown langs', () => {
    const p = mapRepoFactsToProjectCard(REPO, { A: 50, B: 30, C: 15, D: 5 });
    expect(p.languages).toHaveLength(3);
    expect(p.languages?.[0]).toEqual({ name: 'A', color: '#8b949e', percent: 50 });
  });

  it('treats NOASSERTION / missing license as null', () => {
    expect(mapRepoFactsToProjectCard({ ...REPO, license: { spdx_id: 'NOASSERTION' } }, {}).license).toBeNull();
    expect(mapRepoFactsToProjectCard({ ...REPO, license: null }, {}).license).toBeNull();
  });

  it('collapses missing name/owner/url to undefined so the slug fallback wins', () => {
    const p = mapRepoFactsToProjectCard({}, {});
    expect(p.name).toBeUndefined();
    expect(p.ownerDisplayName).toBeUndefined();
    expect(p.githubUrl).toBeUndefined();
    expect(p.description).toBe('');
    expect(p.languages).toEqual([]);
    expect(p.stars).toBeNull();
  });
});

describe('parseGithubRemote', () => {
  it('parses https, ssh, and .git suffixes', () => {
    expect(parseGithubRemote('https://github.com/Papercusp/papercup.git')).toEqual({ owner: 'Papercusp', name: 'papercup' });
    expect(parseGithubRemote('git@github.com:Papercusp/papercup.git')).toEqual({ owner: 'Papercusp', name: 'papercup' });
    expect(parseGithubRemote('https://github.com/Papercusp/papercup')).toEqual({ owner: 'Papercusp', name: 'papercup' });
  });
  it('returns null for non-GitHub remotes', () => {
    expect(parseGithubRemote('https://gitlab.com/a/b.git')).toBeNull();
    expect(parseGithubRemote('')).toBeNull();
  });
});

function fakeOctokit(getData: GithubRepoResponse, langs: Record<string, number>) {
  const get = vi.fn(async () => ({ data: getData }));
  const listLanguages = vi.fn(async () => ({ data: langs }));
  return { octokit: { rest: { repos: { get, listLanguages } } } as any, get, listLanguages };
}

describe('loadProjectCardFromGithub', () => {
  it('resolves repo path → owner/name → facts via injected octokit', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit } = fakeOctokit(REPO, { TypeScript: 100 });
    const p = await loadProjectCardFromGithub({
      workspaceId: 'ws',
      harnessSlug: 'papercup',
      octokit,
      resolveRepoPath: async () => '/repo/papercup',
      ownerName: async () => ({ owner: 'Papercusp', name: 'papercup' }),
      now: () => 1000,
    });
    expect(p?.stars).toBe(42);
    expect(p?.ownerDisplayName).toBe('Papercusp');
  });

  it('returns undefined when there is no GitHub token (octokit null)', async () => {
    _clearGithubFactsCacheForTests();
    const p = await loadProjectCardFromGithub({
      workspaceId: 'ws',
      harnessSlug: 'papercup',
      octokit: null,
      resolveRepoPath: async () => '/repo/papercup',
      ownerName: async () => ({ owner: 'Papercusp', name: 'papercup' }),
    });
    expect(p).toBeUndefined();
  });

  it('returns undefined when the repo path or remote does not resolve', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit } = fakeOctokit(REPO, {});
    expect(
      await loadProjectCardFromGithub({ workspaceId: 'ws', harnessSlug: 'x', octokit, resolveRepoPath: async () => null }),
    ).toBeUndefined();
    expect(
      await loadProjectCardFromGithub({ workspaceId: 'ws', harnessSlug: 'x', octokit, resolveRepoPath: async () => '/r', ownerName: async () => null }),
    ).toBeUndefined();
  });

  it('caches per owner/name for the TTL (octokit hit once across two calls)', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit, get } = fakeOctokit(REPO, { TypeScript: 100 });
    const base = {
      workspaceId: 'ws',
      harnessSlug: 'papercup',
      octokit,
      resolveRepoPath: async () => '/repo/papercup',
      ownerName: async () => ({ owner: 'Papercusp', name: 'papercup' }),
    };
    await loadProjectCardFromGithub({ ...base, now: () => 1000 });
    await loadProjectCardFromGithub({ ...base, now: () => 1000 + 60 * 1000 }); // within 1h
    expect(get).toHaveBeenCalledTimes(1);
    // After the TTL, it re-fetches.
    await loadProjectCardFromGithub({ ...base, now: () => 1000 + 2 * 60 * 60 * 1000 });
    expect(get).toHaveBeenCalledTimes(2);
  });
});

function fakeContribOctokit(
  list: Array<{ login?: string | null; contributions?: number }>,
) {
  const listContributors = vi.fn(async () => ({ data: list }));
  return {
    octokit: { rest: { repos: { listContributors } } } as any,
    listContributors,
  };
}

describe('mapContributorsToCommitCounts', () => {
  it('keys by lowercased login with contribution counts', () => {
    expect(
      mapContributorsToCommitCounts([
        { login: 'Alice', contributions: 120 },
        { login: 'bob', contributions: 5 },
      ]),
    ).toEqual({ alice: 120, bob: 5 });
  });
  it('skips anon/loginless entries and defaults missing counts to 0', () => {
    expect(
      mapContributorsToCommitCounts([
        { login: null, contributions: 99 },
        { login: 'carol' },
      ]),
    ).toEqual({ carol: 0 });
  });
});

describe('loadGithubContributorCommits', () => {
  it('returns per-login commit counts via injected octokit', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit } = fakeContribOctokit([{ login: 'Alice', contributions: 7 }]);
    const r = await loadGithubContributorCommits({
      workspaceId: 'ws',
      harnessSlug: 'papercup',
      octokit,
      resolveRepoPath: async () => '/r',
      ownerName: async () => ({ owner: 'O', name: 'R' }),
      now: () => 1000,
    });
    expect(r).toEqual({ alice: 7 });
  });
  it('returns undefined with no token, and caches per repo', async () => {
    _clearGithubFactsCacheForTests();
    expect(
      await loadGithubContributorCommits({
        workspaceId: 'ws',
        harnessSlug: 'x',
        octokit: null,
        resolveRepoPath: async () => '/r',
        ownerName: async () => ({ owner: 'O', name: 'R' }),
      }),
    ).toBeUndefined();
    const { octokit, listContributors } = fakeContribOctokit([
      { login: 'a', contributions: 1 },
    ]);
    const base = {
      workspaceId: 'ws',
      harnessSlug: 'x',
      octokit,
      resolveRepoPath: async () => '/r',
      ownerName: async () => ({ owner: 'O', name: 'R' }),
    };
    await loadGithubContributorCommits({ ...base, now: () => 1000 });
    await loadGithubContributorCommits({ ...base, now: () => 1000 + 60_000 });
    expect(listContributors).toHaveBeenCalledTimes(1);
  });
});
