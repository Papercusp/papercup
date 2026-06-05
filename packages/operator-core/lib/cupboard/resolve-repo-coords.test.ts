/**
 * Repo-coords resolver for Cupboard publish (revive-cupboard-distribution P1/P2).
 * Pure parse + injected git/GitHub deps — no real git or network.
 */
import { describe, it, expect } from 'vitest';
import { parseGithubRemote, resolveRepoCoordsFromDir } from './resolve-repo-coords';

describe('parseGithubRemote', () => {
  it('parses https, ssh, .git suffix, and trailing slash', () => {
    expect(parseGithubRemote('https://github.com/acme/widget')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseGithubRemote('https://github.com/acme/widget.git')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseGithubRemote('https://github.com/acme/widget/')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseGithubRemote('git@github.com:acme/widget.git')).toEqual({ owner: 'acme', repo: 'widget' });
  });
  it('rejects non-github / malformed remotes', () => {
    expect(parseGithubRemote('https://gitlab.com/acme/widget')).toBeNull();
    expect(parseGithubRemote('not a url')).toBeNull();
    expect(parseGithubRemote('https://github.com/acme')).toBeNull();
  });
});

describe('resolveRepoCoordsFromDir', () => {
  const meta = async () => ({ id: 42, html_url: 'https://github.com/acme/widget' });

  it('resolves coords from the origin remote + GitHub repo id', async () => {
    const coords = await resolveRepoCoordsFromDir('/x', {
      getOriginUrl: async () => 'https://github.com/acme/widget.git',
      fetchRepoMeta: meta,
    });
    expect(coords).toEqual({
      github_repository_id: 42,
      github_owner: 'acme',
      github_name: 'widget',
      github_url: 'https://github.com/acme/widget',
    });
  });

  it('errors when there is no origin remote', async () => {
    const r = await resolveRepoCoordsFromDir('/x', { getOriginUrl: async () => null, fetchRepoMeta: meta });
    expect(r).toHaveProperty('error');
  });

  it('errors on a non-github origin', async () => {
    const r = await resolveRepoCoordsFromDir('/x', {
      getOriginUrl: async () => 'https://gitlab.com/acme/widget',
      fetchRepoMeta: meta,
    });
    expect(r).toHaveProperty('error');
  });

  it('errors when the GitHub repo cannot be resolved', async () => {
    const r = await resolveRepoCoordsFromDir('/x', {
      getOriginUrl: async () => 'https://github.com/acme/widget',
      fetchRepoMeta: async () => null,
    });
    expect(r).toHaveProperty('error');
  });
});
