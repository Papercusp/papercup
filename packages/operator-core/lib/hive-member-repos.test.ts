/**
 * hive-member-repos.test.ts — derivation of a Hive's member-repo refs + the
 * repo→Hive match (hive-from-github-url-2026-06-11 P-003/P-005). IO seams
 * injected (registry + shared-config) — no PG, no filesystem.
 */
import { describe, it, expect } from 'vitest';
import { deriveHiveMemberRepoRefs, hiveMatchesRepo } from './hive-member-repos';
import {
  encodeMemberRepoRef,
  parseMemberRepoRef,
} from './sync/hyperbee/hive-announce';
import type { HarnessRegistry } from './harness-registry';

function regWith(projects: HarnessRegistry['projects']): () => Promise<HarnessRegistry> {
  return () => Promise.resolve({ projects });
}

describe('encodeMemberRepoRef / parseMemberRepoRef', () => {
  it('round-trips with and without a repo id', () => {
    expect(parseMemberRepoRef(encodeMemberRepoRef({ owner: 'a', repo: 'b', githubRepositoryId: 99 }))).toEqual({
      owner: 'a',
      repo: 'b',
      githubRepositoryId: 99,
    });
    expect(parseMemberRepoRef(encodeMemberRepoRef({ owner: 'a', repo: 'b' }))).toEqual({
      owner: 'a',
      repo: 'b',
    });
  });

  it('parses dotted/hyphenated names and rejects malformed refs', () => {
    expect(parseMemberRepoRef('dot.owner/dot.repo#5')).toEqual({
      owner: 'dot.owner',
      repo: 'dot.repo',
      githubRepositoryId: 5,
    });
    expect(parseMemberRepoRef('no-slash')).toBeNull();
    expect(parseMemberRepoRef('/leading')).toBeNull();
    expect(parseMemberRepoRef('trailing/')).toBeNull();
    expect(parseMemberRepoRef('a/b/c')).toBeNull();
    expect(parseMemberRepoRef('a/b#notdigits')).toBeNull();
    expect(parseMemberRepoRef('')).toBeNull();
  });
});

describe('deriveHiveMemberRepoRefs', () => {
  it('derives from registry P-002 coords for the home + hive_slug members', async () => {
    const refs = await deriveHiveMemberRepoRefs('ws', 'myhive', {
      loadRegistry: regWith([
        {
          slug: 'myhive',
          path: '/h/home',
          harness_kind: 'hive',
          github_remote: 'https://github.com/acme/home.git',
          github_repository_id: 11,
        },
        {
          slug: 'member-a',
          path: '/h/a',
          hive_slug: 'myhive',
          github_remote: 'https://github.com/acme/repo-a.git',
        },
        { slug: 'unrelated', path: '/h/u', github_remote: 'https://github.com/x/y.git' },
      ]),
      loadSharedConfig: () => null,
    });
    expect(refs.sort()).toEqual(['acme/home#11', 'acme/repo-a'].sort());
  });

  it('falls back to a member shared.json when registry coords are absent', async () => {
    const refs = await deriveHiveMemberRepoRefs('ws', 'myhive', {
      loadRegistry: regWith([
        { slug: 'member-b', path: '/h/b', hive_slug: 'myhive' },
      ]),
      loadSharedConfig: (dir) =>
        dir === '/h/b'
          ? { github_remote: 'https://github.com/acme/repo-b', github_repository_id: 22 }
          : null,
    });
    expect(refs).toEqual(['acme/repo-b#22']);
  });

  it('skips members with no known upstream; dedupes with id-bearing refs winning', async () => {
    const refs = await deriveHiveMemberRepoRefs('ws', 'myhive', {
      loadRegistry: regWith([
        { slug: 'myhive', path: '/h/home', harness_kind: 'hive' },
        {
          slug: 'm1',
          path: '/h/1',
          hive_slug: 'myhive',
          github_remote: 'https://github.com/acme/same.git',
        },
        {
          slug: 'm2',
          path: '/h/2',
          hive_slug: 'myhive',
          github_remote: 'https://github.com/ACME/same.git',
          github_repository_id: 7,
        },
        { slug: 'm3', path: '/h/3', hive_slug: 'myhive' },
      ]),
      loadSharedConfig: () => null,
    });
    expect(refs).toEqual(['ACME/same#7']);
  });
});

describe('hiveMatchesRepo', () => {
  const repos = ['acme/shop#100', 'acme/docs'];

  it('matches by immutable id when both sides carry one', () => {
    expect(hiveMatchesRepo(repos, { githubRepositoryId: 100 })).toBe(true);
    expect(hiveMatchesRepo(repos, { githubRepositoryId: 999 })).toBe(false);
  });

  it('id mismatch is authoritative even when owner/repo would match (rename aliasing)', () => {
    expect(
      hiveMatchesRepo(['acme/shop#100'], { githubRepositoryId: 999, owner: 'acme', repo: 'shop' }),
    ).toBe(false);
  });

  it('falls back to case-insensitive owner/repo when an id is missing on either side', () => {
    expect(hiveMatchesRepo(repos, { owner: 'ACME', repo: 'Docs' })).toBe(true);
    expect(hiveMatchesRepo(repos, { githubRepositoryId: 55, owner: 'acme', repo: 'docs' })).toBe(true);
    expect(hiveMatchesRepo(repos, { owner: 'acme', repo: 'nope' })).toBe(false);
  });

  it('empty/undefined member sets never match', () => {
    expect(hiveMatchesRepo(undefined, { githubRepositoryId: 100 })).toBe(false);
    expect(hiveMatchesRepo([], { owner: 'a', repo: 'b' })).toBe(false);
  });
});
