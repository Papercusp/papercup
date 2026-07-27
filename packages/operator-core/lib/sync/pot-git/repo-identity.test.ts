/**
 * Unit tests for `canonicalRepoKey` (WI-5168 — see repo-identity.ts's module
 * header for the full bug this fixes: a device's LOCAL install `slug` for a
 * managed repo can differ from a peer's for the SAME upstream, so keying the
 * wire+store repoKey on it means G-8 fetch never rendezvouses for any two
 * devices whose install slugs differ).
 */
import { describe, expect, it } from 'vitest';
import { canonicalRepoKey, deriveRepoKey, pinRepoKey } from './repo-identity';

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

/**
 * EI-18788176839043286 — the pin. A repoKey names the bare store on disk AND
 * the repo on the wire, so deriving it fresh from MUTABLE registry fields made
 * a live repo silently re-key itself the moment those fields changed.
 */
describe('canonicalRepoKey — pinned identity (EI-18788176839043286)', () => {
  it('THE REPRO: a pot minted local-only keeps its key after it later gains a github id', () => {
    // Before: local-only pot home (ensure-papercusp-hive mints exactly this).
    const beforeBinding = { slug: 'papercusp' };
    const pinned = pinRepoKey(beforeBinding);
    expect(pinned).toBe('papercusp');

    // Later that same device acquires the upstream binding. WITHOUT the pin the
    // key jumps to gh-1223568103 — a different store path and wire key —
    // abandoning the store and orphaning every peer.
    const afterBinding = {
      slug: 'papercusp',
      github_repository_id: 1223568103,
      github_remote: 'https://github.com/Papercusp/papercup.git',
    };
    expect(deriveRepoKey(afterBinding)).toBe('gh-1223568103'); // the drift, unpinned
    expect(canonicalRepoKey({ ...afterBinding, pot_repo_key: pinned })).toBe('papercusp');
  });

  it('a pin wins over a github_repository_id that shows up later', () => {
    expect(
      canonicalRepoKey({ slug: 's', github_repository_id: 999, pot_repo_key: 'gh-111' }),
    ).toBe('gh-111');
  });

  it('a pin wins over github_remote too', () => {
    expect(
      canonicalRepoKey({
        slug: 's',
        github_remote: 'https://github.com/octocat/Hello-World.git',
        pot_repo_key: 'legacy-key',
      }),
    ).toBe('legacy-key');
  });

  it('pinRepoKey is idempotent — re-running it never re-mints an existing pin', () => {
    const entry = { slug: 's', github_repository_id: 42, pot_repo_key: 'pinned-earlier' };
    expect(pinRepoKey(entry)).toBe('pinned-earlier');
    expect(pinRepoKey({ ...entry, pot_repo_key: pinRepoKey(entry) })).toBe('pinned-earlier');
  });

  it('pinRepoKey mints from the derivation ladder when there is no pin yet', () => {
    expect(pinRepoKey({ slug: 's', github_repository_id: 1296269 })).toBe('gh-1296269');
    expect(pinRepoKey({ slug: 'local-only' })).toBe('local-only');
  });

  it('an unpinned entry behaves EXACTLY as before (no regression for existing installs)', () => {
    for (const entry of [
      { slug: 'a', github_repository_id: 1296269 },
      { slug: 'b', github_remote: 'https://github.com/octocat/Hello-World.git' },
      { slug: 'c' },
    ]) {
      expect(canonicalRepoKey(entry)).toBe(deriveRepoKey(entry));
    }
  });

  it('a MALFORMED pin is ignored (fail-soft) rather than escaping the store directory', () => {
    // These would be path-traversal / ref-injection if honoured verbatim.
    for (const bad of ['../../etc/passwd', 'a/b', '..', '.', '', 'has space', 'nul\0byte']) {
      expect(canonicalRepoKey({ slug: 'safe-slug', pot_repo_key: bad })).toBe('safe-slug');
    }
  });

  it('a non-string pin is ignored rather than thrown into the git-sync tick', () => {
    const entry = { slug: 'safe-slug', pot_repo_key: 42 as unknown as string };
    expect(() => canonicalRepoKey(entry)).not.toThrow();
    expect(canonicalRepoKey(entry)).toBe('safe-slug');
  });

  it('two devices that pinned the SAME key stay rendezvoused even as their local coords diverge', () => {
    const tower = canonicalRepoKey({
      slug: 'papercusp',
      github_repository_id: 1223568103,
      pot_repo_key: 'gh-1223568103',
    });
    const rig = canonicalRepoKey({ slug: 'papercusp', pot_repo_key: 'gh-1223568103' });
    expect(tower).toBe(rig);
  });
});
