/**
 * P-011 — the Bluesky adapter, run against the P-003 conformance kit.
 *
 * This is the first adapter to run the kit end to end, so the file has a second
 * job beyond "does the adapter work": it must show the KIT actually grades.
 * A conformance run that passes everything is worthless if it would also pass a
 * broken adapter, so `describe('controls')` keeps deliberately-wrong adapters
 * permanently in the file and asserts the kit FAILS each one on the specific
 * check it is broken against.
 *
 * The controls are not hypothetical bugs. Each is a real failure mode named in
 * the contract: silently starting from live after a refused cursor (the
 * silent-loss bug the kit exists for), a dedupe key built from wall-clock, a
 * cursor that rewinds, a leaked credential, and an unabsorbed rate limit.
 *
 * NOTE ON THE LEAK MARKER BELOW. It is deliberately short, lowercase and NOT
 * shaped like a real app password (the lexicon's xxxx-xxxx-xxxx-xxxx form), and
 * it is not named `SECRET`. A realistic-looking fixture trips the secrets guard
 * on write and, worse, the pot-git publish guard afterwards — which refuses
 * every own-head publish FOREVER, because its baseline never advances past a
 * refused blob and editing the file later does not remove it from history
 * (EI-21230011589307899). The conformance check is a plain substring search, so
 * an obviously-fake marker proves exactly the same property.
 */
import { describe, expect, it } from 'vitest';
import {
  BlueskyAdapter,
  BlueskyXrpcError,
  type BlueskyCursorRefusal,
  type BlueskyRawEvent,
  type BlueskyReadClient,
  type BlueskyStreamPage,
  blueskyDedupeKey,
  blueskyEventName,
  blueskyGraphemeCount,
  blueskyPostRkey,
  blueskyRetryDelayMs,
  buildBlueskyPostRecord,
  isBlueskyCursor,
  normalizeBlueskyEvent,
} from './bluesky-adapter';
import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import type { SocialAdapter, SocialReconcileContext, SocialReconcileResult } from './adapter-contract';

/** Stands in for a credential: must never appear in emitted output. */
const NEVER_EMIT_MARKER = 'never-emit-me';
const SELF_DID = 'did:plc:self';

/* -------------------------------------------------------------------------- */
/* An in-memory PDS good enough to be wrong in the interesting ways            */
/* -------------------------------------------------------------------------- */

interface World {
  events: BlueskyRawEvent[];
  nextSeq: number;
  refuseNext: BlueskyCursorRefusal | null;
  rateLimitNext: boolean;
  /** How far back the REST backfill can reach — deliberately bounded. */
  backfillWindow: number;
}

function makeWorld(): World {
  return { events: [], nextSeq: 1, refuseNext: null, rateLimitNext: false, backfillWindow: 50 };
}

function publishInto(world: World, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = world.nextSeq++;
    const uri = `at://did:plc:author/app.bsky.feed.post/3k${seq}`;
    world.events.push({
      seq,
      uri,
      cid: `bafy-${seq}`,
      did: 'did:plc:author',
      text: `post number ${seq}`,
      createdAt: new Date(Date.UTC(2026, 7, 23, 0, 0, seq)).toISOString(),
      authorHandle: 'ada.bsky.social',
    });
    ids.push(uri);
  }
  return ids;
}

function makeClient(world: World): BlueskyReadClient {
  return {
    async streamSince(cursor: number | null): Promise<BlueskyStreamPage> {
      if (world.rateLimitNext) {
        world.rateLimitNext = false;
        throw new BlueskyXrpcError(429, 'RateLimitExceeded', 'slow down', 5);
      }
      if (world.refuseNext) {
        const refusal = world.refuseNext;
        world.refuseNext = null;
        return { events: [], cursor: world.nextSeq - 1, refusal };
      }
      const events = world.events.filter((e) => (cursor === null ? true : e.seq > cursor));
      return { events, cursor: world.nextSeq - 1 };
    },
    async backfill(): Promise<BlueskyRawEvent[]> {
      return world.events.slice(-world.backfillWindow);
    },
  };
}

function harness(): SocialConformanceHarness<World> {
  return {
    async create() {
      const world = makeWorld();
      return {
        world,
        adapter: new BlueskyAdapter({
          client: makeClient(world),
          selfDid: SELF_DID,
          sleep: async () => {},
        }),
      };
    },
    async publish(world, count) {
      return publishInto(world, count);
    },
    async expireCursor(world) {
      world.refuseNext = 'cursor-too-old';
    },
    async rateLimitOnce(world) {
      world.rateLimitNext = true;
    },
    secret: NEVER_EMIT_MARKER,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
  };
}

/* -------------------------------------------------------------------------- */

describe('BlueskyAdapter — P-003 conformance', () => {
  it('passes every check the kit can run for this platform', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.platformId).toBe('bluesky');
  });

  it('runs the two checks that are SKIPPED for weaker platforms', async () => {
    // Bluesky is the only Wave A platform that can refuse a cursor, so it is the
    // only one where these two checks are not skipped. If they ever appear in
    // checksSkipped, the harness stopped exercising the case the kit exists for
    // and a green report would mean much less than it looks like it means.
    const report = await runSocialAdapterConformance(harness());
    expect(report.checksRun).toContain('cursor-unusable-falls-back-to-backfill');
    expect(report.checksRun).toContain('rate-limit-is-absorbed');
    expect(report.checksSkipped).toEqual([]);
  });
});

describe('BlueskyAdapter — reconcile paths are declared honestly', () => {
  async function drain(adapter: SocialAdapter, cursor: unknown | null) {
    const events: Parameters<SocialReconcileContext['emit']>[0][] = [];
    const result: SocialReconcileResult = await adapter.reconcile({
      cursor,
      async emit(event) {
        events.push(event);
      },
    });
    return { result, events };
  }

  it('reports cold-start, then cursor-replay, then live-only', async () => {
    const world = makeWorld();
    const adapter = new BlueskyAdapter({ client: makeClient(world), selfDid: SELF_DID, sleep: async () => {} });

    publishInto(world, 2);
    const cold = await drain(adapter, null);
    expect(cold.result.path).toBe('cold-start');
    expect(cold.events).toHaveLength(2);

    publishInto(world, 3);
    const replay = await drain(adapter, cold.result.cursor);
    expect(replay.result.path).toBe('cursor-replay');
    expect(replay.events).toHaveLength(3);

    const idle = await drain(adapter, replay.result.cursor);
    expect(idle.result.path).toBe('live-only');
    expect(idle.events).toHaveLength(0);
  });

  it('maps a refused cursor to the RIGHT backfill reason', async () => {
    // The two refusals mean different things and a single 'backfill' label would
    // hide the difference: too-old is normal operation after a long sleep, while
    // a future cursor means our stored state disagrees with the server and is a
    // signal worth surfacing.
    for (const [refusal, expected] of [
      ['cursor-too-old', 'cursor-expired'],
      ['future-cursor', 'cursor-rejected'],
    ] as const) {
      const world = makeWorld();
      const adapter = new BlueskyAdapter({ client: makeClient(world), selfDid: SELF_DID, sleep: async () => {} });
      publishInto(world, 2);
      const first = await drain(adapter, null);
      publishInto(world, 3);
      world.refuseNext = refusal;
      const second = await drain(adapter, first.result.cursor);
      expect(second.result.path).toBe('backfill');
      expect(second.result.backfillReason).toBe(expected);
    }
  });

  it('never rewinds the cursor, even if the provider reports a lower position', async () => {
    // A rewind re-delivers everything after it. This is asserted directly
    // because it is invisible in a single pass — it only shows up as duplicate
    // deliveries on the NEXT one.
    const world = makeWorld();
    const adapter = new BlueskyAdapter({ client: makeClient(world), selfDid: SELF_DID, sleep: async () => {} });
    publishInto(world, 5);
    const first = await drain(adapter, null);
    expect(isBlueskyCursor(first.result.cursor)).toBe(true);

    world.events = [];
    world.nextSeq = 1; // provider appears to have gone backwards
    const second = await drain(adapter, first.result.cursor);
    expect((second.result.cursor as { seq: number }).seq).toBeGreaterThanOrEqual(5);
    expect(second.events).toHaveLength(0);
  });
});

describe('normalization — event naming and payload shape', () => {
  const base: BlueskyRawEvent = {
    seq: 1,
    uri: 'at://did:plc:author/app.bsky.feed.post/3kabc',
    cid: 'bafy-1',
    did: 'did:plc:author',
    text: 'hello world',
    createdAt: '2026-08-23T00:00:00.000Z',
    authorHandle: 'ada.bsky.social',
  };

  it('names a plain post, a reply and a mention differently', () => {
    expect(blueskyEventName(base, SELF_DID)).toBe('post');
    expect(blueskyEventName({ ...base, mentions: [SELF_DID] }, SELF_DID)).toBe('mention');
    expect(
      blueskyEventName(
        { ...base, reply: { root: { uri: 'at://r', cid: 'c1' }, parent: { uri: 'at://p', cid: 'c2' } } },
        SELF_DID,
      ),
    ).toBe('reply');
  });

  it('a reply that also mentions us is a REPLY, not a mention', () => {
    // Ordering matters: replies and mentions route to different bindings, and a
    // reply to our own post almost always mentions us, so mention-first would
    // reclassify most replies.
    const replyWithMention: BlueskyRawEvent = {
      ...base,
      mentions: [SELF_DID],
      reply: { root: { uri: 'at://r', cid: 'c1' }, parent: { uri: 'at://p', cid: 'c2' } },
    };
    expect(blueskyEventName(replyWithMention, SELF_DID)).toBe('reply');
  });

  it('carries the strong ref onto a reply payload — both uri AND cid', () => {
    // The write path needs a full strongRef for BOTH root and parent, so a read
    // that drops the cid produces a post that cannot be replied to.
    const normalized = normalizeBlueskyEvent(
      { ...base, reply: { root: { uri: 'at://root', cid: 'cid-root' }, parent: { uri: 'at://par', cid: 'cid-par' } } },
      SELF_DID,
    );
    expect(normalized.payload.replyToId).toBe('at://par');
    expect(normalized.payload.rootUri).toBe('at://root');
    expect(normalized.payload.rootCid).toBe('cid-root');
    expect(normalized.payload.cid).toBe('bafy-1');
  });

  it('derives the dedupe key from uri AND cid, so an edit re-delivers', () => {
    const first = blueskyDedupeKey(base);
    expect(blueskyDedupeKey({ ...base })).toBe(first);
    expect(blueskyDedupeKey({ ...base, cid: 'bafy-2' })).not.toBe(first);
  });

  it('omits the web URL rather than guessing one without a handle', () => {
    expect(normalizeBlueskyEvent(base, SELF_DID).payload.url).toContain('ada.bsky.social');
    expect(normalizeBlueskyEvent({ ...base, authorHandle: null }, SELF_DID).payload.url).toBeUndefined();
  });
});

describe('retry policy — the spec, not a generic 5xx loop', () => {
  it('does NOT retry a 501, which a status>=500 rule would', () => {
    // The spec states 501 must not be retried. This is the single most likely
    // place to write a plausible generic rule that is wrong.
    expect(blueskyRetryDelayMs(new BlueskyXrpcError(501, 'MethodNotImplemented'), 0)).toBeNull();
  });

  it('retries 429, 500 and 502-504', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(blueskyRetryDelayMs(new BlueskyXrpcError(status, 'X'), 0)).toBeGreaterThan(0);
    }
  });

  it('does not retry a 4xx that is not a rate limit', () => {
    for (const status of [400, 401, 403, 413]) {
      expect(blueskyRetryDelayMs(new BlueskyXrpcError(status, 'X'), 0)).toBeNull();
    }
  });

  it('honours Retry-After over its own backoff', () => {
    expect(blueskyRetryDelayMs(new BlueskyXrpcError(429, 'RateLimitExceeded', undefined, 1234), 3)).toBe(1234);
  });

  it('backs off exponentially and stays capped', () => {
    const first = blueskyRetryDelayMs(new BlueskyXrpcError(500, 'X'), 0)!;
    const later = blueskyRetryDelayMs(new BlueskyXrpcError(500, 'X'), 4)!;
    expect(later).toBeGreaterThan(first);
    expect(blueskyRetryDelayMs(new BlueskyXrpcError(500, 'X'), 50)).toBeLessThanOrEqual(30_000);
  });

  it('ignores a non-XRPC error rather than retrying blindly', () => {
    expect(blueskyRetryDelayMs(new Error('socket hang up'), 0)).toBeNull();
  });
});

describe('write side — the record shape the lexicon actually declares', () => {
  const CREATED = '2026-08-23T00:00:00.000Z';

  it('builds a minimal post with the required fields only', () => {
    const record = buildBlueskyPostRecord({ text: 'hello', createdAt: CREATED });
    expect(record).toEqual({ $type: 'app.bsky.feed.post', text: 'hello', createdAt: CREATED });
  });

  it('a reply carries BOTH root and parent as full strong refs', () => {
    // Sending parent alone is the common mistake and yields an unthreaded reply.
    const record = buildBlueskyPostRecord({
      text: 'replying',
      createdAt: CREATED,
      replyTo: { root: { uri: 'at://root', cid: 'cid-root' }, parent: { uri: 'at://par', cid: 'cid-par' } },
    });
    expect(record.reply).toEqual({
      root: { uri: 'at://root', cid: 'cid-root' },
      parent: { uri: 'at://par', cid: 'cid-par' },
    });
  });

  it('counts a ZWJ emoji sequence as ONE grapheme, not several', () => {
    // The reason Intl.Segmenter is used instead of [...text].length: a naive
    // spread counts this family as 7, which would reject posts the platform
    // accepts.
    expect(blueskyGraphemeCount('👨‍👩‍👧‍👦')).toBe(1);
    expect([...'👨‍👩‍👧‍👦'].length).toBeGreaterThan(1);
  });

  it('enforces the grapheme bound INDEPENDENTLY of the character bound', () => {
    // The subject must exceed 300 graphemes while staying UNDER 3000 chars, or
    // the character check would fire first and this would not be testing the
    // grapheme bound at all. A combining accent is 2 UTF-16 units per grapheme,
    // so 301 of them is 602 chars — comfortably inside the character limit.
    const accented = 'é'.repeat(301);
    expect(blueskyGraphemeCount(accented)).toBe(301);
    expect(accented.length).toBeLessThan(3000);
    expect(() => buildBlueskyPostRecord({ text: accented, createdAt: CREATED })).toThrow(/graphemes/);
  });

  it('enforces the 3000-character bound', () => {
    expect(() => buildBlueskyPostRecord({ text: 'a'.repeat(3001), createdAt: CREATED })).toThrow(/chars/);
  });

  it('refuses empty text for a new post', () => {
    expect(() => buildBlueskyPostRecord({ text: '   ', createdAt: CREATED })).toThrow(/text_required/);
  });

  it('takes createdAt as a PARAMETER so a retry reproduces the same record', () => {
    // If createdAt were minted inside, the retry would differ from the original
    // and the rkey guard below could not make them collapse.
    const a = buildBlueskyPostRecord({ text: 'same', createdAt: CREATED });
    const b = buildBlueskyPostRecord({ text: 'same', createdAt: CREATED });
    expect(a).toEqual(b);
  });
});

describe('write side — rkey is the ONLY double-post guard this platform offers', () => {
  it('is stable for identical content, so a retry lands on the same record', () => {
    // atproto documents no idempotency mechanism, so an ambiguous timeout plus a
    // retry would otherwise publish twice to a real public identity.
    expect(blueskyPostRkey({ text: 'hello' })).toBe(blueskyPostRkey({ text: 'hello' }));
  });

  it('differs by text and by parent', () => {
    expect(blueskyPostRkey({ text: 'a' })).not.toBe(blueskyPostRkey({ text: 'b' }));
    expect(blueskyPostRkey({ text: 'a' })).not.toBe(
      blueskyPostRkey({ text: 'a', replyTo: { uri: 'at://p', cid: 'c' } }),
    );
  });

  it('produces a key within the lexicon rkey bound', () => {
    expect(blueskyPostRkey({ text: 'x'.repeat(5000) }).length).toBeLessThanOrEqual(512);
  });
});

/* -------------------------------------------------------------------------- */
/* Controls — deliberately WRONG adapters, kept permanently                    */
/* -------------------------------------------------------------------------- */

describe('controls — the kit must FAIL a broken adapter', () => {
  /** Runs the kit against an adapter built by `build`, returning the failed checks. */
  async function failedChecks(build: (world: World) => SocialAdapter): Promise<string[]> {
    const base = harness();
    const report = await runSocialAdapterConformance({
      ...base,
      async create() {
        const world = makeWorld();
        return { world, adapter: build(world) };
      },
    });
    return [...new Set(report.failures.map((f) => f.check))];
  }

  it('CONTROL: an adapter that starts from live after a refused cursor is caught', async () => {
    // THE silent-loss bug. It emits zero events and returns a coherent-looking
    // result, so nothing but this check distinguishes it from "nothing happened
    // while we were away". If this control ever passes, the kit has stopped
    // protecting the property it was built for.
    const failed = await failedChecks((world) => {
      const client = makeClient(world);
      const real = new BlueskyAdapter({ client, selfDid: SELF_DID, sleep: async () => {} });
      return {
        platformId: 'bluesky',
        async reconcile(ctx) {
          const page = await client.streamSince(isBlueskyCursor(ctx.cursor) ? ctx.cursor.seq : null);
          if (page.refusal) {
            // Shrug and resume from live — the wrong behaviour, stated plainly.
            return { cursor: { seq: page.cursor ?? 0 }, emitted: 0, path: 'live-only' };
          }
          return real.reconcile(ctx);
        },
      };
    });
    expect(failed).toContain('cursor-unusable-falls-back-to-backfill');
  });

  it('CONTROL: a dedupe key built from wall-clock is caught', async () => {
    const failed = await failedChecks((world) => {
      const real = new BlueskyAdapter({ client: makeClient(world), selfDid: SELF_DID, sleep: async () => {} });
      return {
        platformId: 'bluesky',
        async reconcile(ctx) {
          return real.reconcile({
            ...ctx,
            async emit(event) {
              await ctx.emit({ ...event, dedupeKey: `${event.externalId}@${Date.now()}${Math.random()}` });
            },
          });
        },
      };
    });
    expect(failed).toContain('dedupe-keys-unique-and-stable');
  });

  it('CONTROL: an adapter that re-emits everything every pass is caught', async () => {
    // "Loses nothing" and "is correct" are different claims: this one re-fires
    // every binding on every reconnect.
    const failed = await failedChecks((world) => {
      const client = makeClient(world);
      return {
        platformId: 'bluesky',
        async reconcile(ctx) {
          const page = await client.streamSince(null);
          for (const event of page.events) await ctx.emit(normalizeBlueskyEvent(event, SELF_DID));
          return { cursor: { seq: page.cursor ?? 0 }, emitted: page.events.length, path: 'cursor-replay' };
        },
      };
    });
    expect(failed).toContain('no-op-reconcile-emits-nothing');
  });

  it('CONTROL: an adapter that leaks the credential into the payload is caught', async () => {
    const failed = await failedChecks((world) => {
      const real = new BlueskyAdapter({ client: makeClient(world), selfDid: SELF_DID, sleep: async () => {} });
      return {
        platformId: 'bluesky',
        async reconcile(ctx) {
          return real.reconcile({
            ...ctx,
            async emit(event) {
              await ctx.emit({ ...event, payload: { ...event.payload, debugAuth: NEVER_EMIT_MARKER } });
            },
          });
        },
      };
    });
    expect(failed).toContain('credential-never-emitted');
  });

  it('CONTROL: an adapter that propagates a rate limit instead of absorbing it is caught', async () => {
    const failed = await failedChecks((world) => {
      const client = makeClient(world);
      return {
        platformId: 'bluesky',
        async reconcile(ctx) {
          // No retry at all: the 429 escapes as a source failure and the page is lost.
          const page = await client.streamSince(isBlueskyCursor(ctx.cursor) ? ctx.cursor.seq : null);
          for (const event of page.events) await ctx.emit(normalizeBlueskyEvent(event, SELF_DID));
          return { cursor: { seq: page.cursor ?? 0 }, emitted: page.events.length, path: 'cold-start' };
        },
      };
    });
    expect(failed).toContain('rate-limit-is-absorbed');
  });
});
