/**
 * Unit tests for `canonicalRepoKey` (WI-5168 — see repo-identity.ts's module
 * header for the full bug this fixes: a device's LOCAL install `slug` for a
 * managed repo can differ from a peer's for the SAME upstream, so keying the
 * wire+store repoKey on it means G-8 fetch never rendezvouses for any two
 * devices whose install slugs differ).
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalRepoKey,
  deriveRepoKey,
  findSupersededRepoKey,
  isValidRepoKey,
  parseSupersededRepoKeyRefusal,
  pinRepoKey,
  repoKeyLadder,
  supersededRepoKeyRefusal,
  supersededRepoKeys,
} from './repo-identity';

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

// ─── WI-6364 (fix C): superseded stores ─────────────────────────────────────

/** The live tower entry, verbatim from harness_shared.harness_registry on
 *  2026-07-27: it gained its github id on 2026-07-20 and re-keyed, stranding
 *  the 2.5 GB `papercusp.git` store that then served week-old packs for 7 days. */
const TOWER_PAPERCUSP = { slug: 'papercusp', github_repository_id: 1223568103 };

describe('repoKeyLadder', () => {
  it('lists every rung this entry could be keyed under, BEST FIRST', () => {
    expect(
      repoKeyLadder({
        slug: 'papercusp',
        github_repository_id: 1223568103,
        github_remote: 'https://github.com/octocat/Hello-World.git',
      }),
    ).toEqual(['gh-1223568103', 'gh-octocat--hello-world', 'papercusp']);
  });

  it('deriveRepoKey IS the ladder head — they cannot drift', () => {
    // The whole point of materializing the ladder: the derivation and the
    // abandonment set must never disagree about which rung is canonical.
    for (const entry of [
      TOWER_PAPERCUSP,
      { slug: 'a', github_remote: 'git@github.com:octocat/Hello-World.git' },
      { slug: 'purely-local' },
    ]) {
      expect(deriveRepoKey(entry)).toBe(repoKeyLadder(entry)[0]);
    }
  });

  it('never returns an empty list — the local slug is always the last rung', () => {
    expect(repoKeyLadder({ slug: 'purely-local' })).toEqual(['purely-local']);
  });

  it('THE LIVE REPRO: a submodule slug yields a LEGAL path component, not a slashed key', () => {
    // Tower, 2026-08-08: every papercusp submodule is registered with a PATH as
    // its slug and no upstream coords, so it fell to the bare-slug rung and
    // derived a slashed repoKey. storage.ts's assertSafeComponent then threw on
    // every pot-git bootstrap-tick — 5569 times in 24h, i.e. every submodule's
    // federation was dead, and none of it was filed.
    expect(repoKeyLadder({ slug: 'papercusp/libs/generic/cache' })).toEqual([
      'papercusp-libs-generic-cache',
    ]);
    // The property that actually matters, asserted against the SAME predicate
    // storage.ts guards with: whatever the ladder emits must be a legal key.
    for (const slug of [
      'papercusp/libs/generic/cache',
      'papercusp/libs/papercusp',
      'a/../../etc/passwd',
      'weird\\backslash',
      'nul\0byte',
      '',
    ]) {
      for (const rung of repoKeyLadder({ slug })) {
        expect(isValidRepoKey(rung)).toBe(true);
      }
    }
  });

  it('CONTROL: a slug that is ALREADY a legal key is passed through byte-identical', () => {
    // The regression this fix must not cause. A repoKey names a cross-device
    // rendezvous AND an on-disk store path, so re-spelling a working key strands
    // the store and orphans peers (EI-18788176839043286). Sanitizing
    // unconditionally would silently re-key every one of these.
    for (const slug of ['papercusp', 'purely-local', 'gh-1223568103', 'Mixed.Case_ok', 'a-b.c_d']) {
      expect(repoKeyLadder({ slug })).toEqual([slug]);
      expect(deriveRepoKey({ slug })).toBe(slug);
    }
  });

  it('de-duplicates when two rungs coincide', () => {
    // A slug that happens to already look like its own derived key must not
    // appear twice — a duplicate would make the key its own superseded alias.
    expect(repoKeyLadder({ slug: 'gh-1223568103', github_repository_id: 1223568103 })).toEqual([
      'gh-1223568103',
    ]);
  });
});

describe('supersededRepoKeys', () => {
  it('THE LIVE REPRO: the bare slug is abandoned once the entry gains its github id', () => {
    expect(supersededRepoKeys(TOWER_PAPERCUSP)).toEqual(['papercusp']);
  });

  it('an unpinned local-only pot has NOTHING superseded — nothing has been abandoned yet', () => {
    // The pre-re-key state. A detector that fired here would refuse every fetch
    // against a perfectly healthy local-first pot.
    expect(supersededRepoKeys({ slug: 'papercusp' })).toEqual([]);
  });

  it('a PIN off the ladder supersedes the whole ladder — the adopted-key case', () => {
    // A joiner that adopted the owner's key holds a pin no rung of its own
    // ladder produces; every rung it could have derived is therefore stale.
    expect(
      supersededRepoKeys({
        slug: 'papercusp',
        pot_repo_key: 'gh-1223568103',
        pot_repo_key_source: 'peer',
      }),
    ).toEqual(['papercusp']);
  });

  it('the canonical key is never in its own superseded set', () => {
    for (const entry of [TOWER_PAPERCUSP, { slug: 'x' }, { slug: 'y', pot_repo_key: 'gh-9' }]) {
      expect(supersededRepoKeys(entry)).not.toContain(canonicalRepoKey(entry));
    }
  });
});

describe('findSupersededRepoKey', () => {
  // The tower's real pot: the home entry plus an unrelated member repo whose
  // store lives under the SAME potHomeSlug directory (hive-canary.git).
  const POT = [TOWER_PAPERCUSP, { slug: 'hive-canary' }];

  it('THE LIVE REPRO: a joiner asking for the abandoned key is told the canonical one', () => {
    expect(findSupersededRepoKey('papercusp', POT)).toEqual({
      requested: 'papercusp',
      canonical: 'gh-1223568103',
      entrySlug: 'papercusp',
    });
  });

  it('serves the canonical key untouched', () => {
    expect(findSupersededRepoKey('gh-1223568103', POT)).toBeNull();
  });

  it('NEVER refuses an unrelated repo living under the same pot', () => {
    // The reason the verdict is ladder-based and not "anything != the pot
    // home's canonical key": one bare store per (potHomeSlug, repoKey) means
    // many legitimate repos share the directory. This is the case a naive
    // implementation breaks, and breaking it is worse than the bug being fixed.
    expect(findSupersededRepoKey('hive-canary', POT)).toBeNull();
  });

  it('an unknown key is NOT superseded — it falls through to the existing no-such-repo gate', () => {
    expect(findSupersededRepoKey('never-heard-of-it', POT)).toBeNull();
  });

  it("GUARD 1: one entry's abandoned alias can never shadow another entry's LIVE key", () => {
    // `legacy-name` is entry A's abandoned rung AND entry B's adopted pin.
    // Order-independently, live wins: refusing here would break a healthy fetch.
    const entries = [
      { slug: 'legacy-name', github_repository_id: 42 },
      { slug: 'other', pot_repo_key: 'legacy-name', pot_repo_key_source: 'peer' as const },
    ];
    expect(findSupersededRepoKey('legacy-name', entries)).toBeNull();
    expect(findSupersededRepoKey('legacy-name', [...entries].reverse())).toBeNull();
  });

  it('an empty entry set yields no verdict (fail-open)', () => {
    expect(findSupersededRepoKey('papercusp', [])).toBeNull();
  });

  it('a malformed requested key is rejected before any lookup', () => {
    expect(findSupersededRepoKey('../../etc/passwd', POT)).toBeNull();
    expect(findSupersededRepoKey('', POT)).toBeNull();
  });
});

describe('the superseded-repo-key refusal reason', () => {
  it('round-trips through the FULL destroy-error text a requester actually holds', () => {
    // serve-wiring's handleRefuse destroys the duplex with this exact prefix,
    // and runBootstrapLeg reads `duplex.errored.message` — so the parser must
    // work on the wrapped form, not just the bare reason.
    const wire = `pot-git serve refused: ${supersededRepoKeyRefusal('gh-1223568103')}`;
    expect(parseSupersededRepoKeyRefusal(wire)).toBe('gh-1223568103');
  });

  it('ignores every other refusal reason', () => {
    for (const other of [
      'pot-git serve refused: no-such-repo',
      'pot-git serve refused: mode-legacy',
      'serve channel closed',
      '',
    ]) {
      expect(parseSupersededRepoKeyRefusal(other)).toBeNull();
    }
  });

  it('REFUSES a key that is not a safe path/ref component — it arrives from another machine', () => {
    // This value becomes a filesystem path component and a git ref component,
    // so a hostile or broken peer must not be able to steer it.
    expect(
      parseSupersededRepoKeyRefusal('pot-git serve refused: superseded-repo-key:../../etc/passwd'),
    ).toBeNull();
    expect(parseSupersededRepoKeyRefusal('pot-git serve refused: superseded-repo-key:')).toBeNull();
    expect(parseSupersededRepoKeyRefusal('pot-git serve refused: superseded-repo-key:..')).toBeNull();
  });

  it('tolerates a non-string (a destroyed duplex with no error carries undefined)', () => {
    expect(parseSupersededRepoKeyRefusal(undefined)).toBeNull();
    expect(parseSupersededRepoKeyRefusal(null)).toBeNull();
    expect(parseSupersededRepoKeyRefusal({ message: 'superseded-repo-key:gh-1' })).toBeNull();
  });
});
