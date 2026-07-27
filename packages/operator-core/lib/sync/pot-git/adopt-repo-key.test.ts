/**
 * A3 — federating the pin (EI-18788176839043286).
 *
 * `pinRepoKey` alone makes a key STABLE; it does not make two devices agree on
 * the SAME key. These tests pin down the rule that does: the pot owner mints the
 * key, every other device adopts it, and a locally-DERIVED pin never outranks an
 * announced one.
 */
import { describe, it, expect } from 'vitest';
import {
  adoptRepoKey,
  canonicalRepoKey,
  isValidRepoKey,
  type RepoIdentityEntry,
} from './repo-identity';

const entry = (over: Partial<RepoIdentityEntry> = {}): RepoIdentityEntry => ({
  slug: 'papercusp',
  ...over,
});

describe('adoptRepoKey — the owner mints, peers adopt', () => {
  it("takes the owner's announced key verbatim over its own derivation", () => {
    // The joiner WOULD derive gh-1223568103 from its own coords; the owner says
    // the store is actually named `papercusp`. The owner wins.
    const e = entry({ github_repository_id: 1223568103 });
    expect(canonicalRepoKey(e)).toBe('gh-1223568103');

    const got = adoptRepoKey(e, 'papercusp');
    expect(got).toEqual({ key: 'papercusp', source: 'peer' });
  });

  it('OVERRIDES a locally-derived pin — this is what repairs an already-diverged pot', () => {
    // The exact live shape: the rig pinned the bare slug from its own registry
    // (no upstream coords), while the tower's store is gh-1223568103. If a local
    // pin could outrank the announce, the boot backfill would cement the split
    // forever and A3 could never repair anything.
    const rig = entry({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' });

    const got = adoptRepoKey(rig, 'gh-1223568103');

    expect(got.key).toBe('gh-1223568103');
    expect(got.source).toBe('peer');
    // The re-key is surfaced: the store at the old key is abandoned.
    expect(got.rekeyedFrom).toBe('papercusp');
  });

  it('treats an unstamped legacy pin as local, so pre-A3 installs are repairable too', () => {
    // Entries pinned before `pot_repo_key_source` existed carry no stamp. They
    // are derivations, so they must NOT block the owner's key.
    const legacy = entry({ pot_repo_key: 'papercusp' });
    expect(legacy.pot_repo_key_source).toBeUndefined();

    expect(adoptRepoKey(legacy, 'gh-1223568103').key).toBe('gh-1223568103');
  });

  it('does not report a re-key when the announced key matches what is already pinned', () => {
    const e = entry({ pot_repo_key: 'gh-1', pot_repo_key_source: 'local' });
    const got = adoptRepoKey(e, 'gh-1');
    expect(got).toEqual({ key: 'gh-1', source: 'peer' });
    expect(got.rekeyedFrom).toBeUndefined();
  });

  it('KEEPS an adopted key when no announce is available — losing the announce never regresses a device', () => {
    // An owner on a pre-A3 build (or simply an offline re-join) emits no
    // repo_key. A device that already adopted must not fall back to deriving,
    // or it would re-diverge the moment the announce is missing.
    const joined = entry({
      github_repository_id: 1223568103,
      pot_repo_key: 'papercusp',
      pot_repo_key_source: 'peer',
    });

    expect(adoptRepoKey(joined, undefined)).toEqual({ key: 'papercusp', source: 'peer' });
  });

  it('falls back to the local pin/derivation when nothing is announced (pre-A3 behaviour)', () => {
    expect(adoptRepoKey(entry({ github_repository_id: 7 }), undefined)).toEqual({
      key: 'gh-7',
      source: 'local',
    });
    expect(adoptRepoKey(entry(), undefined)).toEqual({ key: 'papercusp', source: 'local' });
    expect(
      adoptRepoKey(entry({ pot_repo_key: 'kept', pot_repo_key_source: 'local' }), undefined),
    ).toEqual({ key: 'kept', source: 'local' });
  });

  it('IGNORES a malformed announced key rather than adopting it into a path/ref', () => {
    // A repoKey is used verbatim as a filesystem path component and a git ref
    // component, so a traversal or junk value must never be adopted.
    for (const bad of ['../../etc/passwd', '..', '.', '', 'has/slash', 'has space', null, 42]) {
      const got = adoptRepoKey(entry({ github_repository_id: 9 }), bad);
      expect(got).toEqual({ key: 'gh-9', source: 'local' });
    }
  });

  it('is idempotent once adopted: re-running with the same announce is a no-op', () => {
    const e = entry({ pot_repo_key: 'papercusp', pot_repo_key_source: 'local' });
    const first = adoptRepoKey(e, 'gh-1223568103');
    const settled = entry({
      pot_repo_key: first.key,
      pot_repo_key_source: first.source,
    });
    const second = adoptRepoKey(settled, 'gh-1223568103');

    expect(second.key).toBe(first.key);
    expect(second.rekeyedFrom).toBeUndefined();
  });

  it('canonicalRepoKey honours an adopted key, so the store path and wire key follow it', () => {
    // The whole point: adoption is worthless unless the hot path reads it.
    const adopted = adoptRepoKey(entry({ github_repository_id: 1223568103 }), 'papercusp');
    expect(canonicalRepoKey(entry({ pot_repo_key: adopted.key }))).toBe('papercusp');
  });
});

describe('isValidRepoKey', () => {
  it('accepts safe path/ref components and rejects everything else', () => {
    expect(isValidRepoKey('gh-1223568103')).toBe(true);
    expect(isValidRepoKey('papercusp')).toBe(true);
    expect(isValidRepoKey('gh-acme--shop.js_1')).toBe(true);

    expect(isValidRepoKey('.')).toBe(false);
    expect(isValidRepoKey('..')).toBe(false);
    expect(isValidRepoKey('a/b')).toBe(false);
    expect(isValidRepoKey('a b')).toBe(false);
    expect(isValidRepoKey('')).toBe(false);
    expect(isValidRepoKey('x'.repeat(201))).toBe(false);
    expect(isValidRepoKey(undefined)).toBe(false);
  });
});
