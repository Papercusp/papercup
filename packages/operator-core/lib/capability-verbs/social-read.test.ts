/**
 * P-007 — the READ half of the social seam.
 *
 * The property under test is narrow and load-bearing: an agent must never have
 * to ASSEMBLE a post ref. Every ref it receives is minted server-side from the
 * row its id came from, and round-trips through the seam's own parser.
 *
 * Several tests below keep a deliberately-wrong implementation permanently in
 * the file as a CONTROL. That is the repo's falsifiability discipline: a guard
 * that has never failed is a guard nobody has tested, and mutating the shared
 * tree to prove it is unsafe here (git-sync commits the whole tree on a timer).
 * The controls are the in-file tier of `scripts/mutation-probe.sh`.
 */
import { describe, expect, it } from 'vitest';
import {
  mintSocialPostRef,
  platformIdForScope,
  selectGrantedSocialScopes,
  socialVaultScopes,
  socialWriteAvailability,
  SocialSearchNotGranted,
  searchSocialPosts,
} from './social-read';
import { formatSocialPostRef, parseSocialPostRef } from './social';
import { listSocialPlatforms } from '../external-triggers/social/platform-registry';

describe('social vault scopes are derived from the registry', () => {
  it('covers every registered platform, with no hand-written list to drift', () => {
    const scopes = socialVaultScopes();
    expect(scopes).toHaveLength(listSocialPlatforms().length);
    for (const row of listSocialPlatforms()) {
      expect(scopes).toContain(`personal:${row.id}`);
    }
  });

  it('maps a scope back to its platform, and refuses a non-social one', () => {
    expect(platformIdForScope('personal:bluesky')).toBe('bluesky');
    expect(platformIdForScope('bluesky')).toBe('bluesky');
    expect(platformIdForScope('personal:gmail')).toBeNull();
    expect(platformIdForScope('personal:calendar')).toBeNull();
  });
});

describe('selectGrantedSocialScopes — the trap that would leak Gmail into social:search', () => {
  it('keeps only the social scopes out of a mixed grant', () => {
    const granted = ['personal:gmail', 'personal:bluesky', 'personal:calendar', 'personal:reddit'];
    expect(selectGrantedSocialScopes(granted)).toEqual(['personal:bluesky', 'personal:reddit']);
  });

  it('returns EMPTY for a grant with no social scope — never a silent everything', () => {
    // This is the case that matters. `authorizePersonalAccess` returns the whole
    // granted set when nothing specific was requested, and the store applies NO
    // scope filter for an empty array — so a naive implementation searching
    // "whatever came back" would span the owner's mail. Empty here forces the
    // caller into an explicit refusal instead.
    expect(selectGrantedSocialScopes(['personal:gmail', 'personal:contacts'])).toEqual([]);
  });

  it('narrows a partial grant instead of refusing it', () => {
    // An owner who connected only Bluesky must still be able to search it. The
    // rejected alternative — requesting all ten scopes up front — trips
    // `scope_not_granted` and refuses the entire call.
    expect(selectGrantedSocialScopes(['personal:bluesky'])).toEqual(['personal:bluesky']);
  });

  it('normalizes and de-duplicates, and survives a malformed grant row', () => {
    expect(selectGrantedSocialScopes(['bluesky', 'personal:bluesky', 'BLUESKY'])).toEqual([
      'personal:bluesky',
    ]);
    expect(selectGrantedSocialScopes(['  ', 'personal:bluesky', '!!!'])).toEqual(['personal:bluesky']);
  });

  it('CONTROL: a naive "pass the granted scopes straight through" leaks non-social sources', () => {
    // The deliberately-wrong implementation, kept permanently so the assertion
    // above is known to be catching something rather than restating the code.
    const naive = (granted: readonly string[]) => [...granted];
    const granted = ['personal:gmail', 'personal:bluesky'];
    expect(naive(granted)).toContain('personal:gmail');
    expect(selectGrantedSocialScopes(granted)).not.toContain('personal:gmail');
  });
});

describe('mintSocialPostRef — refs are minted, never assembled', () => {
  it('mints a ref that round-trips through the seam parser', () => {
    const minted = mintSocialPostRef('reddit', 't3_abc123');
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.postId).toBe('reddit:t3_abc123');
    expect(parseSocialPostRef(minted.postId)).toEqual({ platform: 'reddit', externalId: 't3_abc123' });
  });

  it('mints an AT-URI id intact — the colons inside it survive', () => {
    // The reason the split is first-colon-only. A last-colon or split-every
    // implementation truncates this into something that still looks like a
    // valid id and resolves to nothing.
    const uri = 'at://did:plc:xyz/app.bsky.feed.post/3k';
    const minted = mintSocialPostRef('bluesky', uri);
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    expect(minted.postId).toBe(`bluesky:${uri}`);
    expect(parseSocialPostRef(minted.postId).externalId).toBe(uri);
  });

  it('REFUSES a non-social vault source rather than minting a plausible ref for an email', () => {
    const minted = mintSocialPostRef('gmail', '18f2a1b9c');
    expect(minted.ok).toBe(false);
    if (minted.ok) return;
    expect(minted.reason).toBe('not-a-social-platform');
    expect(minted.detail).toContain('gmail');
  });

  it('REFUSES a row with no external id instead of minting "<platform>:"', () => {
    for (const value of [null, '', '   ']) {
      const minted = mintSocialPostRef('reddit', value);
      expect(minted.ok).toBe(false);
      if (minted.ok) continue;
      expect(minted.reason).toBe('external-id-missing');
    }
  });

  it('REFUSES an id that would address a different post after parsing', () => {
    // The parser trims the tail, so a stored id with leading whitespace would
    // mint a token that resolves to a DIFFERENT id than the row holds. A length
    // or emptiness check cannot see this; the round-trip can.
    const minted = mintSocialPostRef('reddit', '  t3_abc123');
    expect(minted.ok).toBe(false);
    if (minted.ok) return;
    expect(minted.reason).toBe('ref-does-not-round-trip');
  });

  it('REFUSES an unverified platform with the registry reason, at mint time', () => {
    // Wave B/C rows are unverified or owner-blocked. Surfacing that here means
    // an agent is told before it drafts, not after.
    const unverified = listSocialPlatforms().find((row) => row.verifiedAt === null);
    expect(unverified, 'registry should still carry an unverified row').toBeTruthy();
    if (!unverified) return;
    const minted = mintSocialPostRef(unverified.id, 'some-id');
    expect(minted.ok).toBe(false);
    if (minted.ok) return;
    expect(minted.reason).toBe('platform-unusable');
  });

  it('CONTROL: hand-assembly accepts every input the mint refuses', () => {
    // This IS the P-007 finding, expressed as a test. `${source}:${id}` is what
    // a caller reading personal:search's two separate fields would write, and it
    // happily produces refs for an email, for an id-less row, and for one that
    // parses back as something else.
    const assemble = (source: string, externalId: string | null) => `${source}:${externalId ?? ''}`;
    const cases: Array<[string, string | null]> = [
      ['gmail', '18f2a1b9c'],
      ['reddit', null],
      ['reddit', '  t3_abc123'],
    ];
    for (const [source, id] of cases) {
      expect(typeof assemble(source, id)).toBe('string');
      expect(mintSocialPostRef(source, id).ok).toBe(false);
    }
  });

  it('CONTROL: a transposed hand-assembly parses cleanly and addresses the wrong platform', () => {
    // The specific hand-assembly failure D-006 forbids: the platform half
    // disagreeing with the id half. Nothing downstream can detect it, because
    // the token is perfectly well-formed — which is why the mint has to be the
    // only source of refs.
    const transposed = 'mastodon:t3_abc123'; // a Reddit fullname under Mastodon
    expect(() => parseSocialPostRef(transposed)).not.toThrow();
    expect(parseSocialPostRef(transposed).platform).toBe('mastodon');
    // The mint cannot produce this: it builds the platform half from the same
    // row the id came from.
    const minted = mintSocialPostRef('reddit', 't3_abc123');
    expect(minted.ok && minted.postId).toBe('reddit:t3_abc123');
  });

  it('every verified platform mints and round-trips — a registry-wide sweep', () => {
    for (const row of listSocialPlatforms()) {
      const minted = mintSocialPostRef(row.id, 'sample-id-1');
      if (row.verifiedAt === null || row.blockedOn) {
        expect(minted.ok, `${row.id} is not usable and must refuse`).toBe(false);
        continue;
      }
      expect(minted.ok, `${row.id} is verified and must mint`).toBe(true);
      if (!minted.ok) continue;
      expect(parseSocialPostRef(minted.postId)).toEqual({ platform: row.id, externalId: 'sample-id-1' });
      expect(formatSocialPostRef(minted.ref)).toBe(minted.postId);
    }
  });
});

describe('socialWriteAvailability — read verified, write refused, told at read time', () => {
  it('reports Bluesky as readable but NOT replyable, with the registry reason', () => {
    // The read/write split is the whole point of the separate gate: Bluesky's
    // event stream is specified (mintable above) while its write path is not.
    const minted = mintSocialPostRef('bluesky', 'at://did:plc:x/app.bsky.feed.post/1');
    expect(minted.ok).toBe(true);
    const availability = socialWriteAvailability('bluesky', 'reply');
    expect(availability.allowed).toBe(false);
    expect(availability.reason).toBe('write-unverified');
  });

  it('never throws for a registered platform — it is a report, not a gate', () => {
    for (const row of listSocialPlatforms()) {
      expect(() => socialWriteAvailability(row.id, 'reply')).not.toThrow();
    }
  });

  it('CONTROL: a hardcoded "replyable: true" would advertise a reply the write path refuses', () => {
    const naive = () => ({ allowed: true });
    expect(naive().allowed).toBe(true);
    expect(socialWriteAvailability('bluesky', 'reply').allowed).toBe(false);
  });
});

describe('searchSocialPosts — scoping and minting under a real grant shape', () => {
  const workspaceId = 'ws-test';
  const userId = '00000000-0000-0000-0000-000000000001';

  /** A stand-in for the store call, so the scoping contract is testable without a database. */
  function fakeSql(rows: unknown[]) {
    const calls: unknown[][] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      return Promise.resolve(rows);
    }) as unknown as import('postgres').Sql;
    return { sql, calls };
  }

  it('REFUSES when the grant covers no social scope, instead of searching everything', async () => {
    const { sql } = fakeSql([]);
    await expect(
      searchSocialPosts(sql, {
        workspaceId,
        userId,
        query: 'anything',
        grantedScopes: ['personal:gmail', 'personal:calendar'],
      }),
    ).rejects.toBeInstanceOf(SocialSearchNotGranted);
  });

  it('REFUSES a platform filter that reaches outside the grant', async () => {
    const { sql } = fakeSql([]);
    await expect(
      searchSocialPosts(sql, {
        workspaceId,
        userId,
        query: 'anything',
        grantedScopes: ['personal:bluesky'],
        platforms: ['mastodon'],
      }),
    ).rejects.toBeInstanceOf(SocialSearchNotGranted);
  });
});
