/**
 * Unit tests for `canonicalRepoKey` (WI-5168 — see repo-identity.ts's module
 * header for the full bug this fixes: a device's LOCAL install `slug` for a
 * managed repo can differ from a peer's for the SAME upstream, so keying the
 * wire+store repoKey on it means G-8 fetch never rendezvouses for any two
 * devices whose install slugs differ).
 */
import { describe, expect, it } from 'vitest';
import { canonicalRepoKey } from './repo-identity';

describe('canonicalRepoKey', () => {
  it('prefers github_repository_id, formatted gh-<id>', () => {
    expect(
      canonicalRepoKey({ slug: 'hello-world-3', github_repository_id: 1296269, github_remote: 'https://github.com/octocat/Hello-World.git' }),
    ).toBe('gh-1296269');
  });

  it('two entries with different slugs but the SAME github_repository_id resolve identically (the WI-5168 repro)', () => {
    const tower = canonicalRepoKey({ slug: 'hello-world-3', github_repository_id: 1296269 });
    const vm = canonicalRepoKey({ slug: 'hello-world', github_repository_id: 1296269 });
    expect(tower).toBe(vm);
    expect(tower).toBe('gh-1296269');
  });

  it('falls back to owner/repo (sanitized, lowercased) from github_remote when no id is known', () => {
    expect(
      canonicalRepoKey({ slug: 'anything', github_remote: 'https://github.com/octocat/Hello-World.git' }),
    ).toBe('gh-octocat--hello-world');
  });

  it('SSH-form github_remote also resolves', () => {
    expect(
      canonicalRepoKey({ slug: 'anything', github_remote: 'git@github.com:octocat/Hello-World.git' }),
    ).toBe('gh-octocat--hello-world');
  });

  it('falls back to the local slug when neither id nor remote is known (pre-existing limitation, not a regression)', () => {
    expect(canonicalRepoKey({ slug: 'purely-local-repo' })).toBe('purely-local-repo');
  });

  it('falls back to the local slug when github_remote does not parse as a GitHub URL', () => {
    expect(canonicalRepoKey({ slug: 'my-slug', github_remote: 'not a url' })).toBe('my-slug');
  });

  it('ignores a non-finite / non-positive github_repository_id and falls through', () => {
    expect(canonicalRepoKey({ slug: 'my-slug', github_repository_id: 0 })).toBe('my-slug');
    expect(canonicalRepoKey({ slug: 'my-slug', github_repository_id: -1 })).toBe('my-slug');
    expect(canonicalRepoKey({ slug: 'my-slug', github_repository_id: Number.NaN })).toBe('my-slug');
  });

  it('the returned key is always a safe single path/ref component (no "/", "\\\\", "..", NUL)', () => {
    const key = canonicalRepoKey({ slug: 'x', github_remote: 'https://github.com/some.owner/some.repo.git' });
    expect(key).not.toMatch(/[/\\]|\.\.|\0/);
  });
});
