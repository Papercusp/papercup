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
  decodeGithubReadme,
  loadRepoReadme,
  mapMergedPrsToActivityEvents,
  loadGithubMergedPrEvents,
  prDedupKey,
  _clearGithubFactsCacheForTests,
  type GithubRepoResponse,
  type GithubReleaseResponse,
  type GithubPullEntry,
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

  it('maps repo topics (cleaned + clamped to 8) and the latest release', () => {
    const p = mapRepoFactsToProjectCard(
      { ...REPO, topics: ['p2p', 'agents', '', 'typescript'] },
      { TypeScript: 100 },
      {
        tag_name: 'v1.2.0',
        published_at: '2026-05-29T00:00:00Z',
        html_url: 'https://github.com/Papercusp/papercup/releases/tag/v1.2.0',
      },
    );
    expect(p.topics).toEqual(['p2p', 'agents', 'typescript']);
    expect(p.latestRelease).toEqual({
      tag: 'v1.2.0',
      publishedAtIso: '2026-05-29T00:00:00Z',
      url: 'https://github.com/Papercusp/papercup/releases/tag/v1.2.0',
    });
  });

  it('defaults topics to [] and latestRelease to undefined when absent', () => {
    const p = mapRepoFactsToProjectCard(REPO, {});
    expect(p.topics).toEqual([]);
    expect(p.latestRelease).toBeUndefined();
  });

  it('falls back to release `name` when tag_name is empty, else undefined', () => {
    expect(
      mapRepoFactsToProjectCard(REPO, {}, { name: 'Nightly', published_at: null }).latestRelease,
    ).toEqual({ tag: 'Nightly', publishedAtIso: null, url: null });
    expect(
      mapRepoFactsToProjectCard(REPO, {}, { tag_name: '', name: '' }).latestRelease,
    ).toBeUndefined();
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

function fakeOctokit(
  getData: GithubRepoResponse,
  langs: Record<string, number>,
  release: GithubReleaseResponse | null = null,
) {
  const get = vi.fn(async () => ({ data: getData }));
  const listLanguages = vi.fn(async () => ({ data: langs }));
  const getLatestRelease = vi.fn(async () => ({ data: release }));
  return {
    octokit: { rest: { repos: { get, listLanguages, getLatestRelease } } } as any,
    get,
    listLanguages,
    getLatestRelease,
  };
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

function fakeReadmeOctokit(content: string | null, encoding = 'base64') {
  const getReadme = vi.fn(async () => {
    if (content === null) throw new Error('404'); // repo with no README
    return { data: { content, encoding } };
  });
  return { octokit: { rest: { repos: { getReadme } } } as any, getReadme };
}

describe('decodeGithubReadme', () => {
  it('decodes base64 content to utf8 markdown', () => {
    const b64 = Buffer.from('# Hello\n\nworld', 'utf8').toString('base64');
    expect(decodeGithubReadme({ content: b64, encoding: 'base64' })).toBe('# Hello\n\nworld');
  });
  it('returns null for empty / missing / whitespace-only content', () => {
    expect(decodeGithubReadme(null)).toBeNull();
    expect(decodeGithubReadme({ content: '' })).toBeNull();
    expect(decodeGithubReadme({})).toBeNull();
    const blank = Buffer.from('   \n', 'utf8').toString('base64');
    expect(decodeGithubReadme({ content: blank, encoding: 'base64' })).toBeNull();
  });
});

describe('loadRepoReadme', () => {
  it('returns decoded README via injected octokit', async () => {
    _clearGithubFactsCacheForTests();
    const b64 = Buffer.from('# Papercup', 'utf8').toString('base64');
    const { octokit } = fakeReadmeOctokit(b64);
    const md = await loadRepoReadme({
      workspaceId: 'ws',
      harnessSlug: 'papercup',
      octokit,
      resolveRepoPath: async () => '/r',
      ownerName: async () => ({ owner: 'O', name: 'R' }),
      now: () => 1000,
    });
    expect(md).toBe('# Papercup');
  });

  it('returns undefined when the repo has no README (getReadme 404s)', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit } = fakeReadmeOctokit(null);
    const md = await loadRepoReadme({
      workspaceId: 'ws',
      harnessSlug: 'x',
      octokit,
      resolveRepoPath: async () => '/r',
      ownerName: async () => ({ owner: 'O', name: 'R' }),
      now: () => 1000,
    });
    expect(md).toBeUndefined();
  });

  it('returns undefined with no token, and caches per repo', async () => {
    _clearGithubFactsCacheForTests();
    expect(
      await loadRepoReadme({
        workspaceId: 'ws',
        harnessSlug: 'x',
        octokit: null,
        resolveRepoPath: async () => '/r',
        ownerName: async () => ({ owner: 'O', name: 'R' }),
      }),
    ).toBeUndefined();
    const b64 = Buffer.from('readme body', 'utf8').toString('base64');
    const { octokit, getReadme } = fakeReadmeOctokit(b64);
    const base = {
      workspaceId: 'ws',
      harnessSlug: 'x',
      octokit,
      resolveRepoPath: async () => '/r',
      ownerName: async () => ({ owner: 'O', name: 'R' }),
    };
    await loadRepoReadme({ ...base, now: () => 1000 });
    await loadRepoReadme({ ...base, now: () => 1000 + 60_000 });
    expect(getReadme).toHaveBeenCalledTimes(1);
  });
});

// ── Merged-PR activity events (tier-A, P-003) ───────────────────────

const NOW = Date.parse('2026-06-01T00:00:00Z');

const MERGED_PR: GithubPullEntry = {
  number: 123,
  title: 'Wire the activity feed',
  html_url: 'https://github.com/Papercusp/papercup/pull/123',
  merged_at: '2026-05-31T23:59:00Z', // 1m before NOW
  merge_commit_sha: 'abcdef1234567890',
  user: { login: 'Alice' },
};

describe('mapMergedPrsToActivityEvents', () => {
  it('maps a merged PR to a tier-A pr_merged event with sha + dedupKey + tsEpoch', () => {
    const [e] = mapMergedPrsToActivityEvents([MERGED_PR], { now: () => NOW });
    expect(e?.kind).toBe('pr_merged');
    expect(e?.id).toBe('pr-gh-123');
    expect(e?.text).toContain('#123');
    expect(e?.text).toContain('Wire the activity feed');
    expect(e?.text).toContain('abcdef1'); // 7-char short sha
    expect(e?.actorLogin).toBe('Alice');
    expect(e?.href).toBe('https://github.com/Papercusp/papercup/pull/123');
    expect(e?.whenLabel).toBe('1m ago');
    expect(e?.tsEpoch).toBe(Date.parse('2026-05-31T23:59:00Z'));
    expect(e?.dedupKey).toBe(prDedupKey(123));
    expect(e?.dedupKey).toBe('pr:123');
  });

  it('drops closed-but-not-merged PRs (merged_at null/absent)', () => {
    const events = mapMergedPrsToActivityEvents(
      [
        MERGED_PR,
        { number: 200, title: 'closed not merged', merged_at: null },
        { number: 201, title: 'just closed' }, // no merged_at
        { number: undefined as unknown as number, merged_at: '2026-05-30T00:00:00Z' },
      ],
      { now: () => NOW },
    );
    expect(events.map((e) => e.id)).toEqual(['pr-gh-123']);
  });

  it('sorts merged PRs most-recent-first and clamps to limit', () => {
    const events = mapMergedPrsToActivityEvents(
      [
        { number: 1, merged_at: '2026-05-20T00:00:00Z', user: { login: 'a' } },
        { number: 2, merged_at: '2026-05-31T00:00:00Z', user: { login: 'b' } },
        { number: 3, merged_at: '2026-05-25T00:00:00Z', user: { login: 'c' } },
      ],
      { now: () => NOW, limit: 2 },
    );
    expect(events.map((e) => e.id)).toEqual(['pr-gh-2', 'pr-gh-3']);
  });

  it('falls back to buildHref then null when html_url is absent', () => {
    const withBuild = mapMergedPrsToActivityEvents(
      [{ number: 9, merged_at: '2026-05-30T00:00:00Z' }],
      { now: () => NOW, buildHref: (n) => `/pr/${n}` },
    );
    expect(withBuild[0]?.href).toBe('/pr/9');
    const noBuild = mapMergedPrsToActivityEvents(
      [{ number: 9, merged_at: '2026-05-30T00:00:00Z' }],
      { now: () => NOW },
    );
    expect(noBuild[0]?.href).toBeNull();
  });

  it('returns [] for empty / null input', () => {
    expect(mapMergedPrsToActivityEvents([])).toEqual([]);
    expect(mapMergedPrsToActivityEvents(null)).toEqual([]);
    expect(mapMergedPrsToActivityEvents(undefined)).toEqual([]);
  });
});

function fakePullsOctokit(list: GithubPullEntry[]) {
  const pullsList = vi.fn(async () => ({ data: list }));
  return { octokit: { rest: { pulls: { list: pullsList } } } as any, pullsList };
}

describe('loadGithubMergedPrEvents', () => {
  it('returns tier-A merged-PR events via injected octokit', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit } = fakePullsOctokit([
      MERGED_PR,
      { number: 99, merged_at: null }, // un-merged, dropped
    ]);
    const events = await loadGithubMergedPrEvents({
      workspaceId: 'ws',
      harnessSlug: 'papercup',
      octokit,
      resolveRepoPath: async () => '/r',
      ownerName: async () => ({ owner: 'O', name: 'R' }),
      now: () => NOW,
    });
    expect(events).toHaveLength(1);
    expect(events?.[0]?.kind).toBe('pr_merged');
    expect(events?.[0]?.dedupKey).toBe('pr:123');
  });

  it('returns undefined with no token (degrade to PG-only feed)', async () => {
    _clearGithubFactsCacheForTests();
    expect(
      await loadGithubMergedPrEvents({
        workspaceId: 'ws',
        harnessSlug: 'x',
        octokit: null,
        resolveRepoPath: async () => '/r',
        ownerName: async () => ({ owner: 'O', name: 'R' }),
      }),
    ).toBeUndefined();
  });

  it('returns undefined when no repo/remote resolves', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit } = fakePullsOctokit([MERGED_PR]);
    expect(
      await loadGithubMergedPrEvents({
        workspaceId: 'ws',
        harnessSlug: 'x',
        octokit,
        resolveRepoPath: async () => null,
      }),
    ).toBeUndefined();
    expect(
      await loadGithubMergedPrEvents({
        workspaceId: 'ws',
        harnessSlug: 'x',
        octokit,
        resolveRepoPath: async () => '/r',
        ownerName: async () => null,
      }),
    ).toBeUndefined();
  });

  it('returns undefined when no PRs are merged', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit } = fakePullsOctokit([{ number: 1, merged_at: null }]);
    expect(
      await loadGithubMergedPrEvents({
        workspaceId: 'ws',
        harnessSlug: 'x',
        octokit,
        resolveRepoPath: async () => '/r',
        ownerName: async () => ({ owner: 'O', name: 'R' }),
        now: () => NOW,
      }),
    ).toBeUndefined();
  });

  it('caches the PR list per repo for the TTL', async () => {
    _clearGithubFactsCacheForTests();
    const { octokit, pullsList } = fakePullsOctokit([MERGED_PR]);
    const base = {
      workspaceId: 'ws',
      harnessSlug: 'papercup',
      octokit,
      resolveRepoPath: async () => '/r',
      ownerName: async () => ({ owner: 'O', name: 'R' }),
    };
    await loadGithubMergedPrEvents({ ...base, now: () => NOW });
    await loadGithubMergedPrEvents({ ...base, now: () => NOW + 60_000 }); // within 1h
    expect(pullsList).toHaveBeenCalledTimes(1);
    await loadGithubMergedPrEvents({ ...base, now: () => NOW + 2 * 60 * 60 * 1000 });
    expect(pullsList).toHaveBeenCalledTimes(2);
  });
});
