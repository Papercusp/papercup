/**
 * resolve-repo-coords-edges.test.ts — the parseGithubRemote rejection edges +
 * the github_url synthesized-fallback that resolve-repo-coords.test.ts leaves open.
 *
 * Why these matter: every Cupboard listing is GitHub-repo-backed, and the
 * publisher's origin URL is what decides owner/repo. A loosened regex would
 * silently WIDEN what's publishable (a non-canonical URL, a sub-path, a
 * different host), so the rejections below are a guard on the publish surface,
 * not cosmetic. (Cupboard audit gaps #6/#7, BRIEF-test-coverage.)
 */
import { describe, expect, it } from 'vitest';
import { parseGithubRemote, resolveRepoCoordsFromDir } from './resolve-repo-coords';

describe('parseGithubRemote — accepted canonical forms', () => {
  it('trims surrounding whitespace before matching', () => {
    expect(parseGithubRemote('  https://github.com/acme/widget  ')).toEqual({ owner: 'acme', repo: 'widget' });
    expect(parseGithubRemote('\tgit@github.com:acme/widget.git\n')).toEqual({ owner: 'acme', repo: 'widget' });
  });
});

describe('parseGithubRemote — rejected edges (publish-surface guard)', () => {
  it('rejects a URL carrying extra path segments (tree/blob/…)', () => {
    // owner/repo only — a repo capture cannot contain `/`, so any sub-path fails.
    expect(parseGithubRemote('https://github.com/acme/widget/tree/main')).toBeNull();
    expect(parseGithubRemote('https://github.com/acme/widget/blob/main/README.md')).toBeNull();
    expect(parseGithubRemote('git@github.com:acme/widget/extra')).toBeNull();
  });

  it('rejects a non-canonical host (case-sensitive github.com only)', () => {
    expect(parseGithubRemote('https://GitHub.com/acme/widget')).toBeNull();
    expect(parseGithubRemote('https://www.github.com/acme/widget')).toBeNull();
    expect(parseGithubRemote('https://github.com.evil.com/acme/widget')).toBeNull();
    expect(parseGithubRemote('http://github.com/acme/widget')).toBeNull(); // http, not https
  });

  it('rejects an empty owner or empty repo', () => {
    expect(parseGithubRemote('https://github.com/acme/')).toBeNull(); // trailing slash, no repo
    expect(parseGithubRemote('https://github.com//widget')).toBeNull(); // empty owner
    expect(parseGithubRemote('https://github.com/')).toBeNull();
  });

  it('rejects a leading-dot owner or repo (traversal-shaped names)', () => {
    // The first char of each segment must be alphanumeric, so a `.`/`-`-leading
    // segment — the shape a path-traversal attempt would take — never parses.
    expect(parseGithubRemote('https://github.com/acme/.evil')).toBeNull();
    expect(parseGithubRemote('https://github.com/.evil/widget')).toBeNull();
    expect(parseGithubRemote('https://github.com/acme/..')).toBeNull();
  });

  it('rejects a query string or fragment appended to the repo', () => {
    expect(parseGithubRemote('https://github.com/acme/widget?foo=1')).toBeNull();
    expect(parseGithubRemote('https://github.com/acme/widget#frag')).toBeNull();
  });
});

describe('resolveRepoCoordsFromDir — github_url fallback (#7)', () => {
  it('synthesizes github_url from owner/repo when the API html_url is empty', async () => {
    const r = await resolveRepoCoordsFromDir('/x', {
      getOriginUrl: async () => 'git@github.com:acme/widget.git',
      // GitHub API returned an id but an empty html_url.
      fetchRepoMeta: async () => ({ id: 7, html_url: '' }),
    });
    expect('error' in r).toBe(false);
    expect(r).toMatchObject({
      github_repository_id: 7,
      github_owner: 'acme',
      github_name: 'widget',
      github_url: 'https://github.com/acme/widget', // synthesized, not the empty API value
    });
  });

  it('uses the API html_url verbatim when present (no synthesis)', async () => {
    const r = await resolveRepoCoordsFromDir('/x', {
      getOriginUrl: async () => 'https://github.com/acme/widget',
      fetchRepoMeta: async () => ({ id: 9, html_url: 'https://github.com/AcMe/Widget' }),
    });
    expect(r).toMatchObject({ github_url: 'https://github.com/AcMe/Widget' });
  });
});
