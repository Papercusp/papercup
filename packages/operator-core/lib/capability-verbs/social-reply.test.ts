/**
 * P-005 — social:reply.
 *
 * The properties under test are ORDERING properties, which is what makes them
 * worth a suite of their own: every gate here can be individually present and
 * the verb still be unsafe if they run in the wrong order. In particular the
 * registry write gate must fire BEFORE the adapter lookup, because "an adapter
 * exists" is not evidence that we know how to call the API correctly — and once
 * a Bluesky adapter lands in P-011, a reversed order would let an unverified
 * lexicon reach the owner's real public identity.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerSocialWriteAdapter,
  replyToCanonicalSocialPost,
  socialReplyIdempotencyKey,
  unregisterSocialWriteAdapter,
  type SocialReplyRequest,
  type SocialWriteAdapter,
} from './social';
import { SocialVisibilityWidened } from './social';
import { anUnverifiedPlatformId } from '../external-triggers/social/platform-exemplars.fixture';

/**
 * Minimal postgres stand-in. `resolveCanonicalDocument` and
 * `listOwnedExternalTriggerSources` both issue tagged-template queries; this
 * returns a canned row set for each in call order.
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

const MASTODON_DOC = {
  id: 'doc-1',
  source: 'mastodon',
  kind: 'social-post',
  externalId: '109999',
  occurredAt: '2026-08-23T00:00:00.000Z',
  participants: ['alice@mastodon.social'],
  title: '',
  text: 'parent post',
  metadata: {
    statusId: '109999',
    instanceHost: 'mastodon.social',
    visibility: 'private',
    authorHandle: 'alice',
  },
};

const OWNED_SOURCE = {
  id: 'src-1',
  workspaceId: 'ws',
  kind: 'mastodon',
  ownerUserId: 'user-1',
  credentialRef: 'cred-1',
  status: 'connected',
  config: { installSlug: 'papercusp' },
  cursor: {},
};

function recordingAdapter(platform: 'mastodon' | 'bluesky' | 'linkedin' = 'mastodon') {
  const seen: SocialReplyRequest[] = [];
  const adapter: SocialWriteAdapter = {
    platform,
    async reply(request) {
      seen.push(request);
      return { externalId: '110000', ref: `${platform}:110000`, url: 'https://example.test/110000' };
    },
  };
  return { adapter, seen };
}

afterEach(() => {
  unregisterSocialWriteAdapter('mastodon');
  unregisterSocialWriteAdapter('bluesky');
  unregisterSocialWriteAdapter('linkedin');
  vi.restoreAllMocks();
});

const BASE = { workspaceId: 'ws', userId: 'user-1', agentOwnerId: null };

describe('social:reply — rail 1', () => {
  it('sends text to the server-resolved destination and echoes where it went', async () => {
    const { adapter, seen } = recordingAdapter();
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    const result = await replyToCanonicalSocialPost(sql, {
      ...BASE,
      ref: 'mastodon:109999',
      text: '  thanks!  ',
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].target).toEqual({
      platform: 'mastodon',
      inReplyToId: '109999',
      instanceHost: 'mastodon.social',
    });
    expect(seen[0].text).toBe('thanks!');
    expect(result.inReplyTo).toBe('mastodon:109999');
    expect(result.ref).toBe('mastodon:110000');
    expect(result.label).toContain('mastodon.social');
  });

  it('INHERITS the parent audience when none is requested', async () => {
    const { adapter, seen } = recordingAdapter();
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    const result = await replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: 'ok' });

    // The parent is Mastodon `private`, which is followers-only on the ladder.
    expect(seen[0].visibility).toBe('followers');
    expect(result.visibility).toBe('followers');
  });

  it('REFUSES a reply that would widen the parent audience — and writes nothing', async () => {
    const { adapter, seen } = recordingAdapter();
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    await expect(
      replyToCanonicalSocialPost(sql, {
        ...BASE,
        ref: 'mastodon:109999',
        text: 'ok',
        visibility: 'public',
      }),
    ).rejects.toBeInstanceOf(SocialVisibilityWidened);

    // The refusal must happen BEFORE the write, not be reported after it.
    expect(seen).toHaveLength(0);
  });

  it('permits narrowing', async () => {
    const { adapter, seen } = recordingAdapter();
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);

    await replyToCanonicalSocialPost(sql, {
      ...BASE,
      ref: 'mastodon:109999',
      text: 'ok',
      visibility: 'direct',
    });
    expect(seen[0].visibility).toBe('direct');
  });

  it('rejects empty or oversized text before touching the database', async () => {
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);
    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: '   ' }),
    ).rejects.toThrow(/text_required/);
    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: 'x'.repeat(10_001) }),
    ).rejects.toThrow(/too_long/);
    expect(sql.calls()).toBe(0);
  });
});

describe('social:reply — gate ORDER', () => {
  it('refuses a registry-refused platform even when an adapter is registered', async () => {
    // The ordering property: registering an adapter is never evidence that the
    // platform may be written to, so a refused platform must not reach it.
    //
    // This was asserted against Bluesky while its write path was unread. P-011
    // verified that path, so the subject moved to a platform the registry still
    // refuses (LinkedIn is `blockedOn` an owner-side app review). Note the
    // refusal now arrives from the USABILITY gate inside coordinate resolution
    // rather than the write-verified gate — earlier, not later, so the property
    // this test protects is strictly stronger, not weaker. If it ever fails, an
    // unusable platform can reach a real public identity.
    const { adapter, seen } = recordingAdapter('linkedin');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([
      [
        {
          ...MASTODON_DOC,
          source: 'linkedin',
          externalId: 'urn:li:share:123',
          metadata: { uri: 'urn:li:share:123' },
        },
      ],
      [{ ...OWNED_SOURCE, kind: 'linkedin' }],
    ]);

    await expect(
      replyToCanonicalSocialPost(sql, {
        ...BASE,
        ref: 'linkedin:urn:li:share:123',
        text: 'hello',
      }),
    // LinkedIn is VERIFIED as of P-021, so it no longer demonstrates
    // "unverified" — it now demonstrates something sharper: a usable platform
    // whose grant covers posting but not commenting. The gate still refuses
    // before the registered adapter is consulted, which is what this asserts.
    ).rejects.toThrow(/social_platform_unusable:linkedin:write-verb-unsupported/);

    expect(seen, 'a refused platform must not reach its adapter').toHaveLength(0);
  });

  it('now lets a Bluesky reply REACH the adapter — write path verified 2026-08-23 (P-011)', async () => {
    // The state change, asserted so it cannot silently regress. The strong ref
    // (uri AND cid) is what atproto requires for both parent and root, and is
    // exactly what the verified lexicon pinned.
    const { adapter, seen } = recordingAdapter('bluesky');
    registerSocialWriteAdapter(adapter);
    const sql = fakeSql([
      [
        {
          ...MASTODON_DOC,
          source: 'bluesky',
          externalId: 'at://did:plc:abc/app.bsky.feed.post/3k',
          metadata: { uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'bafy-1' },
        },
      ],
      [{ ...OWNED_SOURCE, kind: 'bluesky' }],
    ]);

    await replyToCanonicalSocialPost(sql, {
      ...BASE,
      ref: 'bluesky:at://did:plc:abc/app.bsky.feed.post/3k',
      text: 'hello',
    });

    expect(seen, 'a verified platform must now reach its adapter').toHaveLength(1);
  });

  it('reports a missing adapter distinctly from an unverified write path', async () => {
    // Two different failures that must not be conflated: "we do not know how to
    // call this API" vs "we know, but nobody wrote the code yet". Mastodon is
    // write-verified, so with no adapter registered it must report the latter.
    const sql = fakeSql([[MASTODON_DOC], [OWNED_SOURCE]]);
    await expect(
      replyToCanonicalSocialPost(sql, { ...BASE, ref: 'mastodon:109999', text: 'ok' }),
    ).rejects.toThrow(/adapter_missing/);
  });

  it('refuses an unverified platform before any credential lookup', async () => {
    const sql = fakeSql([[], []]);
    await expect(
      replyToCanonicalSocialPost(sql, {
        ...BASE,
        // DERIVED — see platform-exemplars.fixture; this exemplar has already
        // moved three times as each named platform got verified.
        ref: `${anUnverifiedPlatformId()}:123`,
        text: 'ok',
      }),
    ).rejects.toThrow(/unverified/);
    expect(sql.calls()).toBe(0);
  });
});

describe('idempotency key', () => {
  it('is stable across retries of the same logical reply', () => {
    const ref = { platform: 'mastodon' as const, externalId: '109999' };
    expect(socialReplyIdempotencyKey(ref, 'hello')).toBe(socialReplyIdempotencyKey(ref, 'hello'));
    // Whitespace-only differences are the same logical reply.
    expect(socialReplyIdempotencyKey(ref, ' hello ')).toBe(socialReplyIdempotencyKey(ref, 'hello'));
  });

  it('differs by parent and by text', () => {
    const a = { platform: 'mastodon' as const, externalId: '1' };
    const b = { platform: 'mastodon' as const, externalId: '2' };
    expect(socialReplyIdempotencyKey(a, 'hi')).not.toBe(socialReplyIdempotencyKey(b, 'hi'));
    expect(socialReplyIdempotencyKey(a, 'hi')).not.toBe(socialReplyIdempotencyKey(a, 'ho'));
  });

  it('CONTROL: a time-seeded key would defeat its own purpose', () => {
    // Reddit documents no idempotency mechanism, so its adapter has nothing but
    // this key to dedupe on. Mixing in a clock makes every retry unique, which
    // IS the double-post the key exists to prevent.
    const broken = (text: string) => `${text}-${Date.now()}-${Math.random()}`;
    expect(broken('hi')).not.toBe(broken('hi'));
    const ref = { platform: 'reddit' as const, externalId: 't3_abc' };
    expect(socialReplyIdempotencyKey(ref, 'hi')).toBe(socialReplyIdempotencyKey(ref, 'hi'));
  });
});
