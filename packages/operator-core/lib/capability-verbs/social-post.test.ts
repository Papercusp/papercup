/**
 * P-006 — social:post, the create-shaped half of the social:* family.
 *
 * The properties under test are ORDERING and FAIL-CLOSED properties. Every gate
 * here can be individually present and the verb still be unsafe if they run in
 * the wrong order, so several tests assert not just THAT a call was refused but
 * HOW FAR it got before being refused — measured by counting the queries the
 * seam issued, since "the credential was never looked up" is the actual claim.
 *
 * PERMANENT CONTROLS. Three deliberately-wrong implementations live at the
 * bottom of this file and are asserted to FAIL the same properties the real
 * code passes. They exist because a guard that has never failed is a guard
 * nobody has tested, and the repo's mutation-probe discipline forbids proving
 * that by mutating the shared tree. They are the in-file tier of that rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getFlagMock = vi.hoisted(() => vi.fn());
vi.mock('@papercusp/flags/server', () => ({ getFlag: getFlagMock }));

import {
  formatSocialDestinationRef,
  getSocialWriteAdapter,
  parseSocialDestinationRef,
  postToCanonicalSocialDestination,
  registerSocialWriteAdapter,
  socialPostIdempotencyKey,
  socialReplyIdempotencyKey,
  unregisterSocialWriteAdapter,
  type SocialPostRequest,
  type SocialWriteAdapter,
} from './social';
import { AddresseeRefused } from './addressing';

/**
 * Minimal postgres stand-in that also COUNTS calls, because the ordering claims
 * below ("rail 2 ran before any credential was resolved") are only checkable as
 * a statement about how many queries had been issued at the point of refusal.
 */
function fakeSql(rowSets: unknown[][]) {
  let call = 0;
  const sql: any = () => {
    const rows = rowSets[Math.min(call, rowSets.length - 1)] ?? [];
    call += 1;
    return Promise.resolve(rows);
  };
  sql.calls = () => call;
  return sql;
}

/** classifyAddressee's single row. Absent from the vault ⇒ `unknown`. */
const STANDING_UNKNOWN = [{ asContact: false, asParticipant: false, inBody: false }];
/** Present ONLY inside stored message content — the injection signature. */
const STANDING_BODY_ONLY = [{ asContact: false, asParticipant: false, inBody: true }];
const STANDING_KNOWN_CONTACT = [{ asContact: true, asParticipant: false, inBody: true }];

const REDDIT_SOURCE = {
  id: 'src-reddit-1',
  workspaceId: 'ws',
  kind: 'reddit',
  ownerUserId: 'user-1',
  credentialRef: 'cred-reddit-1',
  status: 'connected',
  config: { installSlug: 'papercusp' },
  cursor: {},
};

const BLUESKY_SOURCE = { ...REDDIT_SOURCE, id: 'src-bsky-1', kind: 'bluesky', credentialRef: 'cred-bsky-1' };

function recordingAdapter(platform: 'reddit' | 'bluesky' | 'mastodon' = 'reddit') {
  const seen: SocialPostRequest[] = [];
  const adapter: SocialWriteAdapter = {
    platform,
    async reply() {
      throw new Error('reply not exercised by this suite');
    },
    async post(request) {
      seen.push(request);
      return { externalId: 't3_abc', ref: `${platform}:t3_abc`, url: 'https://example.test/t3_abc' };
    },
  };
  return { adapter, seen };
}

/** An adapter that implements ONLY reply — the registry says post, it cannot. */
function replyOnlyAdapter(platform: 'reddit' = 'reddit'): SocialWriteAdapter {
  return {
    platform,
    async reply() {
      return { externalId: 'x', ref: `${platform}:x` };
    },
  };
}

function post(sql: unknown, overrides: Record<string, unknown> = {}) {
  return postToCanonicalSocialDestination(sql as never, {
    workspaceId: 'ws',
    userId: 'user-1',
    destination: 'reddit:r/rust',
    text: 'hello world',
    provenance: { from: 'owner-instruction' },
    ...overrides,
  } as never);
}

beforeEach(() => {
  getFlagMock.mockReset();
  getFlagMock.mockResolvedValue(true);
});

afterEach(() => {
  unregisterSocialWriteAdapter('reddit');
  unregisterSocialWriteAdapter('bluesky');
  unregisterSocialWriteAdapter('mastodon');
});

/* -------------------------------------------------------------------------- */

describe('parseSocialDestinationRef — the first-colon rule (D-006)', () => {
  it('splits on the FIRST colon, leaving an AT-URI destination intact', () => {
    const ref = parseSocialDestinationRef('bluesky:at://did:plc:xyz/app.bsky.feed.post/3k');
    expect(ref.platform).toBe('bluesky');
    // The load-bearing assertion: every colon after the first belongs to the id.
    expect(ref.destination).toBe('at://did:plc:xyz/app.bsky.feed.post/3k');
    expect(formatSocialDestinationRef(ref)).toBe('bluesky:at://did:plc:xyz/app.bsky.feed.post/3k');
  });

  it('round-trips an ordinary community destination', () => {
    expect(parseSocialDestinationRef('reddit:r/rust')).toEqual({
      platform: 'reddit',
      destination: 'r/rust',
    });
  });

  it('refuses a token with no destination half, rather than defaulting one', () => {
    // The dangerous alternative is treating "reddit:" as "the owner's own
    // timeline" — an omitted destination that silently skips rail 2.
    expect(() => parseSocialDestinationRef('reddit:')).toThrow(/social_destination_ref_malformed/);
    expect(() => parseSocialDestinationRef('reddit')).toThrow(/social_destination_ref_malformed/);
    expect(() => parseSocialDestinationRef('   ')).toThrow(/social_destination_ref_required/);
    expect(() => parseSocialDestinationRef(':r/rust')).toThrow(/social_destination_ref_malformed/);
  });

  it('refuses an unknown platform with the REGISTRY reason, not a vault miss', () => {
    expect(() => parseSocialDestinationRef('friendster:r/rust')).toThrow(/friendster/);
  });
});

describe('rail 2 — a destination lifted from message content is refused', () => {
  it('refuses a body-only destination BEFORE any credential is resolved', async () => {
    const { adapter, seen } = recordingAdapter('reddit');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([STANDING_BODY_ONLY, [REDDIT_SOURCE]]);

    await expect(post(sql)).rejects.toBeInstanceOf(AddresseeRefused);

    // The ordering claim, stated as a measurement: exactly ONE query ran (the
    // standing classification). Had the credential resolution run first, this
    // would be 2 — and an injected destination would have reached a code path
    // holding the owner's identity before being refused.
    expect(sql.calls()).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it('admits a destination the owner just named that is absent from the vault', async () => {
    // `unknown` is ABSENT, not suspicious — a brand-new subreddit the owner
    // typed. Refusing it would make the verb useless for its actual purpose.
    const { adapter } = recordingAdapter('reddit');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    const result = await post(sql);
    expect(result.echo.destinationStanding).toBe('unknown');
    expect(result.published).not.toBeNull();
  });

  it('reports the standing it acted on, so the owner sees WHY it was allowed', async () => {
    const { adapter } = recordingAdapter('reddit');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([STANDING_KNOWN_CONTACT, [REDDIT_SOURCE]]);

    const result = await post(sql);
    expect(result.echo.destinationStanding).toBe('known-contact');
    expect(result.echo.destinationProvenance).toBe('owner-instruction');
    // owner-instruction is unverifiable by construction — never claim otherwise.
    expect(result.echo.destinationVerified).toBe(false);
  });
});

describe('registry write gate — runs before the adapter lookup', () => {
  it("refuses bluesky as write-unverified EVEN WITH an adapter registered", async () => {
    // The whole point of the ordering: once a Bluesky adapter exists (P-011),
    // a reversed order would let an unread lexicon reach the owner's real
    // public identity. Registering one here proves the gate does not consult it.
    const { adapter, seen } = recordingAdapter('bluesky');
    registerSocialWriteAdapter(adapter);
    expect(getSocialWriteAdapter('bluesky')).toBeDefined();
    const sql = fakeSql([STANDING_UNKNOWN, [BLUESKY_SOURCE]]);

    await expect(
      post(sql, { destination: 'bluesky:at://did:plc:xyz/app.bsky.feed.post/3k' }),
    ).rejects.toThrow(/write-unverified/);
    expect(seen).toHaveLength(0);
  });
});

describe('adapter capability — an unimplemented verb is not a platform limitation', () => {
  it('distinguishes "no adapter" from "adapter cannot post"', async () => {
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);
    await expect(post(sql)).rejects.toThrow(/social_post_adapter_missing/);

    registerSocialWriteAdapter(replyOnlyAdapter('reddit'));
    const sql2 = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);
    // A DIFFERENT error on purpose: collapsing these would send someone to
    // verify a lexicon when the real gap is an unwritten adapter method.
    await expect(post(sql2)).rejects.toThrow(/social_post_adapter_verb_missing/);
  });
});

describe('D-004(b) — the flag withholds the OUTBOUND CALL only', () => {
  it('with publishing un-ratified, returns the real resolution and sends nothing', async () => {
    getFlagMock.mockResolvedValue(false);
    const { adapter, seen } = recordingAdapter('reddit');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    const result = await post(sql);

    expect(result.published).toBeNull();
    expect(result.withheld?.reason).toBe('publish-flag-off');
    expect(seen).toHaveLength(0);

    // The echo is the whole answer in this branch, so it must be the REAL
    // resolution rather than a prediction of one: the account it names is the
    // account that would actually have spoken.
    expect(result.echo.account).toEqual({
      sourceId: 'src-reddit-1',
      kind: 'reddit',
      credentialRef: 'cred-reddit-1',
    });
    expect(result.echo.destinationRef).toBe('reddit:r/rust');
    expect(result.echo.visibility).toBe('public');
    expect(result.echo.characters).toBe('hello world'.length);
    expect(result.echo.idempotencyKey).toMatch(/^pc-social-post-/);
  });

  it('reads the flag itself rather than trusting a caller-supplied boolean', async () => {
    getFlagMock.mockResolvedValue(false);
    const { adapter, seen } = recordingAdapter('reddit');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    // There is deliberately NO `publish: true` parameter to pass. If one is
    // ever added, this test should be the thing that fails.
    const result = await post(sql, { publish: true, allowPublish: true, force: true });
    expect(result.published).toBeNull();
    expect(seen).toHaveLength(0);
    expect(getFlagMock).toHaveBeenCalledWith('papercusp-social-auto-publish', 'social-post:ws');
  });

  it('publishes once, with a derived key, when the owner has ratified it', async () => {
    getFlagMock.mockResolvedValue(true);
    const { adapter, seen } = recordingAdapter('reddit');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);

    const result = await post(sql);

    expect(result.withheld).toBeNull();
    expect(result.published).toEqual({
      externalId: 't3_abc',
      ref: 'reddit:t3_abc',
      url: 'https://example.test/t3_abc',
      platform: 'reddit',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.destination).toBe('r/rust');
    expect(seen[0]!.idempotencyKey).toBe(result.echo.idempotencyKey);
  });
});

describe('visibility on a create — no parent to inherit, so no widening rail', () => {
  async function visibilityOf(value: unknown) {
    const { adapter } = recordingAdapter('reddit');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);
    const result = await post(sql, { visibility: value });
    unregisterSocialWriteAdapter('reddit');
    return result.echo.visibility;
  }

  it('defaults an absent audience to public — "post" means public everywhere in the registry', async () => {
    expect(await visibilityOf(undefined)).toBe('public');
    expect(await visibilityOf(null)).toBe('public');
  });

  it('honours an explicit narrower audience', async () => {
    expect(await visibilityOf('followers')).toBe('followers');
    expect(await visibilityOf('direct')).toBe('direct');
  });

  it('FAILS CLOSED on a malformed audience rather than reaching the public default', async () => {
    // The bug D-006's sub-ruling records: routing through string() coerced a
    // non-string to '' and so made corrupt data indistinguishable from an
    // absent field, landing it on `public` — the one guess that can leak.
    expect(await visibilityOf(42)).toBe('direct');
    expect(await visibilityOf({})).toBe('direct');
    expect(await visibilityOf('a-future-platforms-label')).toBe('direct');
  });
});

describe('idempotency key', () => {
  const ref = { platform: 'reddit' as const, destination: 'r/rust' };

  it('is stable across retries and insensitive to surrounding whitespace', () => {
    expect(socialPostIdempotencyKey(ref, 'hi')).toBe(socialPostIdempotencyKey(ref, 'hi'));
    expect(socialPostIdempotencyKey(ref, ' hi ')).toBe(socialPostIdempotencyKey(ref, 'hi'));
  });

  it('separates different destinations and different text', () => {
    expect(socialPostIdempotencyKey(ref, 'hi')).not.toBe(
      socialPostIdempotencyKey({ ...ref, destination: 'r/go' }, 'hi'),
    );
    expect(socialPostIdempotencyKey(ref, 'hi')).not.toBe(socialPostIdempotencyKey(ref, 'ho'));
  });

  it('cannot collide with a REPLY key addressed to the same-looking token', () => {
    // Both refs render as "reddit:r/rust". A shared key space would let an
    // adapter deduping on it silently drop the second, genuinely different,
    // write.
    const replyKey = socialReplyIdempotencyKey({ platform: 'reddit', externalId: 'r/rust' }, 'hi');
    expect(socialPostIdempotencyKey(ref, 'hi')).not.toBe(replyKey);
  });
});

/* -------------------------------------------------------------------------- */
/* PERMANENT CONTROLS — deliberately-wrong implementations, asserted to fail.  */
/* -------------------------------------------------------------------------- */

describe('controls — each asserts the property above is FALSIFIABLE', () => {
  /** WRONG: splits on the LAST colon, the classic AT-URI truncation. */
  function lastColonSplit(raw: string) {
    const at = raw.lastIndexOf(':');
    return { platform: raw.slice(0, at), destination: raw.slice(at + 1) };
  }

  it('a last-colon split truncates an AT-URI into a plausible-looking wrong id', () => {
    const uri = 'bluesky:at://did:plc:xyz/app.bsky.feed.post/3k';
    const wrong = lastColonSplit(uri);
    expect(wrong.destination).not.toBe('at://did:plc:xyz/app.bsky.feed.post/3k');
    // And note WHY this is dangerous rather than merely broken: the truncated
    // value is still a non-empty, syntactically fine-looking id.
    expect(wrong.destination.length).toBeGreaterThan(0);
    expect(parseSocialDestinationRef(uri).destination).not.toBe(wrong.destination);
  });

  /** WRONG: treats an empty destination half as "the owner's own timeline". */
  function permissiveParse(raw: string) {
    const at = raw.indexOf(':');
    return { platform: raw.slice(0, at), destination: raw.slice(at + 1) };
  }

  it('a permissive parse admits "reddit:" — an omitted destination that skips rail 2', () => {
    expect(permissiveParse('reddit:').destination).toBe('');
    // The real parser refuses it, which is the only reason rail 2 always has
    // something to judge.
    expect(() => parseSocialDestinationRef('reddit:')).toThrow();
  });

  /** WRONG: a caller-supplied publish boolean, the fail-open shape. */
  async function callerControlledPublish(
    publish: boolean,
    send: () => Promise<string>,
  ): Promise<string | null> {
    return publish ? await send() : null;
  }

  it('a caller-supplied publish boolean publishes with the flag OFF', async () => {
    getFlagMock.mockResolvedValue(false);
    const wrong = await callerControlledPublish(true, async () => 'sent');
    expect(wrong).toBe('sent'); // the control fails the property...

    // ...while the real seam, handed the same intent, still sends nothing.
    const { adapter, seen } = recordingAdapter('reddit');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([STANDING_UNKNOWN, [REDDIT_SOURCE]]);
    const result = await post(sql, { publish: true });
    expect(result.published).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
