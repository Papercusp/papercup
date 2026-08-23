/**
 * P-012 — the Mastodon adapter, run against the P-003 conformance kit.
 *
 * TWO THINGS THIS FILE HAS TO DO THAT THE BLUESKY SUITE DID NOT.
 *
 * First, the harness PAGE SIZE is deliberately smaller than the gap the kit
 * publishes. The kit's `offline-gap-closed-exactly-once` check is what catches
 * this platform's signature bug (paging a gap with `since_id`, which returns
 * the newest page and silently drops the middle) — but only when the gap spans
 * more than one page. A harness whose page size exceeds the test gap turns that
 * check into decoration that passes a broken adapter. `PAGE_SIZE = 2` against
 * the kit's 3-status gap is what makes it grade.
 *
 * Second, the ids here are HOSTILE ON PURPOSE. Status.id is documented as
 * "String (cast from an integer but not guaranteed to be a number)", so the
 * fixture ids start at "9" — where lexicographic order disagrees with numeric
 * order ("9" > "10") — and a separate test uses snowflake-sized ids where
 * `Number()` collapses adjacent values. An adapter that orders by id passes with
 * friendly fixtures and loses events in production; these fixtures fail it here.
 *
 * The controls are permanent. Each is a real failure mode, and each must FAIL
 * the kit on a named check — a kit that passes everything grades nothing.
 *
 * NOTE ON THE LEAK MARKER. It is short, lowercase and NOT shaped like a real
 * credential. A realistic-looking fixture trips the secrets guard on write and
 * then the pot-git publish guard forever after, because the blob stays in
 * history (EI-21230011589307899). The conformance check is a substring search,
 * so an obviously-fake marker proves the identical property.
 */
import { describe, expect, it } from 'vitest';
import {
  MastodonAdapter,
  MastodonRateLimited,
  MASTODON_MAX_RATE_LIMIT_WAIT_MS,
  mastodonDedupeKey,
  mastodonEventName,
  mastodonRetryDelayMs,
  mastodonStreamingUrl,
  isMastodonCursor,
  normalizeMastodonStatus,
  type MastodonCursor,
  type MastodonPage,
  type MastodonRawStatus,
  type MastodonReadClient,
} from './mastodon-adapter';
import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import { resolveSocialReplyCoordinates } from '../../capability-verbs/social';
import type { CanonicalDocument } from '../../capability-verbs/resolve';
import type { SocialAdapter, SocialReconcileContext, SocialReconcileResult } from './adapter-contract';

const NEVER_EMIT_MARKER = 'never-emit-me';
const INSTANCE = 'mastodon.test';
/** Smaller than the kit's 3-status gap — see the file header. */
const PAGE_SIZE = 2;

/* -------------------------------------------------------------------------- */
/* An in-memory instance good enough to be wrong in the interesting ways       */
/* -------------------------------------------------------------------------- */

interface World {
  statuses: MastodonRawStatus[];
  pageSize: number;
  nextN: number;
  rateLimitNext: boolean;
}

function makeWorld(pageSize = PAGE_SIZE): World {
  return { statuses: [], pageSize, nextN: 1, rateLimitNext: false };
}

/**
 * Ids start at "9" so that the very first page boundary puts lexicographic and
 * numeric order in conflict: "9" sorts AFTER "10" as a string.
 */
function publishInto(world: World, count: number): string[] {
  const uris: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = world.nextN++;
    const id = String(n + 8);
    const uri = `https://${INSTANCE}/users/ada/statuses/${id}`;
    world.statuses.push({
      id,
      uri,
      url: uri,
      content: `<p>status number ${n}</p>`,
      createdAt: new Date(Date.UTC(2026, 7, 23, 0, 0, n)).toISOString(),
      editedAt: null,
      inReplyToId: null,
      visibility: 'public',
      accountAcct: 'ada',
      source: 'timeline',
    });
    uris.push(uri);
  }
  return uris;
}

/** A faithful `min_id` client: pages FORWARD, oldest unseen page first. */
function makeClient(world: World): MastodonReadClient {
  return {
    async fetchNewer(minId: string | null): Promise<MastodonPage> {
      if (world.rateLimitNext) {
        world.rateLimitNext = false;
        // A reset already in the past ⇒ retry immediately, so no test sleeps.
        throw new MastodonRateLimited(new Date(Date.UTC(2020, 0, 1)).toISOString());
      }
      const start = minId === null ? 0 : world.statuses.findIndex((s) => s.id === minId) + 1;
      const slice = world.statuses.slice(start, start + world.pageSize);
      return {
        // Returned NEWEST-FIRST. The timelines docs guarantee no ordering for
        // these endpoints, so handing back a reversed page proves the adapter's
        // created_at sort is doing the work rather than luck.
        statuses: [...slice].reverse(),
        nextMinId: slice.length ? slice[slice.length - 1].id : null,
        hasMore: start + slice.length < world.statuses.length,
      };
    },
  };
}

function harness(client: (world: World) => MastodonReadClient = makeClient): SocialConformanceHarness<World> {
  return {
    async create() {
      const world = makeWorld();
      return { world, adapter: new MastodonAdapter({ client: client(world), instanceHost: INSTANCE }) };
    },
    async publish(world, count) {
      return publishInto(world, count);
    },
    // NO expireCursor: this platform's stream carries no cursor, so it cannot
    // refuse one. The kit skips that check and SAYS it did — asserted below.
    async rateLimitOnce(world) {
      world.rateLimitNext = true;
    },
    secret: NEVER_EMIT_MARKER,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
  };
}

/* -------------------------------------------------------------------------- */

describe('MastodonAdapter — P-003 conformance', () => {
  it('passes every check the kit can run for this platform', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.platformId).toBe('mastodon');
  });

  it('SKIPS the cursor-refusal check, and says why', async () => {
    // Unlike Bluesky, where an empty skip list was the assertion. Mastodon
    // genuinely cannot refuse a cursor, so the honest outcome is a STATED skip
    // rather than a silent pass — the kit reporting "8 checks passed" while one
    // of them never ran is exactly the ambiguity this asserts away.
    const report = await runSocialAdapterConformance(harness());
    const skipped = report.checksSkipped.map((s) => s.check);
    expect(skipped).toEqual(['cursor-unusable-falls-back-to-backfill']);
    expect(report.checksSkipped[0].why).toMatch(/cannot refuse a cursor/);
    expect(report.checksRun).toContain('rate-limit-is-absorbed');
    expect(report.checksRun).toContain('offline-gap-closed-exactly-once');
  });
});

/* -------------------------------------------------------------------------- */

describe('reconcile paths are declared honestly', () => {
  async function drain(adapter: SocialAdapter, cursor: unknown) {
    const events: { externalId: string }[] = [];
    const result = await adapter.reconcile({
      cursor,
      async emit(event) {
        events.push({ externalId: event.externalId });
      },
    });
    return { result, events };
  }

  it('reports cold-start on the first connect', async () => {
    const world = makeWorld();
    publishInto(world, 3);
    const adapter = new MastodonAdapter({ client: makeClient(world), instanceHost: INSTANCE });
    const { result, events } = await drain(adapter, null);
    expect(result.path).toBe('cold-start');
    expect(result.backfillReason).toBeUndefined();
    expect(events).toHaveLength(3);
  });

  it('reports backfill/no-replay-supported once a marker exists — INCLUDING on a no-op pass', async () => {
    const world = makeWorld();
    publishInto(world, 2);
    const adapter = new MastodonAdapter({ client: makeClient(world), instanceHost: INSTANCE });
    const first = await drain(adapter, null);
    const second = await drain(adapter, first.result.cursor);

    expect(second.events).toHaveLength(0);
    // NOT 'live-only'. That would assert the stream replayed and had nothing
    // for us — a capability this platform does not have. See declarePath.
    expect(second.result.path).toBe('backfill');
    expect(second.result.backfillReason).toBe('no-replay-supported');
  });

  it('never reports a cursor-refusal reason, because a cursor cannot be refused here', async () => {
    const world = makeWorld();
    publishInto(world, 5);
    const adapter = new MastodonAdapter({ client: makeClient(world), instanceHost: INSTANCE });
    let cursor: unknown = null;
    for (let i = 0; i < 3; i += 1) {
      const { result } = await drain(adapter, cursor);
      cursor = result.cursor;
      expect(result.backfillReason).not.toBe('cursor-expired');
      expect(result.backfillReason).not.toBe('cursor-rejected');
    }
  });

  it('emits in created_at order even though the provider returns pages newest-first', async () => {
    const world = makeWorld();
    publishInto(world, 4);
    const adapter = new MastodonAdapter({ client: makeClient(world), instanceHost: INSTANCE });
    const { events } = await drain(adapter, null);
    expect(events.map((e) => e.externalId)).toEqual([
      `https://${INSTANCE}/users/ada/statuses/9`,
      `https://${INSTANCE}/users/ada/statuses/10`,
      `https://${INSTANCE}/users/ada/statuses/11`,
      `https://${INSTANCE}/users/ada/statuses/12`,
    ]);
  });

  it('a bounded page walk closes a large gap over several passes without losing its middle', async () => {
    const world = makeWorld();
    publishInto(world, 9);
    // maxPages 2 × pageSize 2 = at most 4 statuses per reconcile.
    const adapter = new MastodonAdapter({ client: makeClient(world), instanceHost: INSTANCE, maxPages: 2 });

    const seen: string[] = [];
    let cursor: unknown = null;
    for (let pass = 0; pass < 6; pass += 1) {
      const { result, events } = await drain(adapter, cursor);
      seen.push(...events.map((e) => e.externalId));
      cursor = result.cursor;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });
});

/* -------------------------------------------------------------------------- */

describe('ids are opaque — never compared, numerically or lexicographically', () => {
  it('handles ids where lexicographic order contradicts numeric order', async () => {
    const world = makeWorld();
    const uris = publishInto(world, 3); // ids "9", "10", "11"
    expect('9' > '10').toBe(true); // the trap, stated
    const adapter = new MastodonAdapter({ client: makeClient(world), instanceHost: INSTANCE });
    const events: string[] = [];
    await adapter.reconcile({ cursor: null, async emit(e) { events.push(e.externalId); } });
    expect(events).toEqual(uris);
  });

  it('handles snowflake ids where Number() collapses adjacent values', () => {
    const a = '109252268000000001';
    const b = '109252268000000002';
    // The trap, stated: these are DIFFERENT statuses that Number() cannot tell apart.
    expect(Number(a)).toBe(Number(b));
    expect(a).not.toBe(b);
    // The dedupe key is built from the id as a STRING, so the two remain distinct.
    const base = { createdAt: '2026-08-23T00:00:01.000Z', editedAt: null };
    expect(mastodonDedupeKey({ id: a, ...base })).not.toBe(mastodonDedupeKey({ id: b, ...base }));
  });
});

/* -------------------------------------------------------------------------- */

describe('normalization', () => {
  function status(overrides: Partial<MastodonRawStatus> = {}): MastodonRawStatus {
    return {
      id: '109252268000000001',
      uri: `https://${INSTANCE}/users/ada/statuses/109252268000000001`,
      url: `https://${INSTANCE}/@ada/109252268000000001`,
      content: '<p>hello <a href="https://example.test">world</a> &amp; goodbye</p>',
      createdAt: '2026-08-23T00:00:01.000Z',
      editedAt: null,
      inReplyToId: null,
      visibility: 'unlisted',
      accountAcct: 'ada@mastodon.test',
      source: 'timeline',
      ...overrides,
    };
  }

  it('reduces the HTML content to text', () => {
    expect(normalizeMastodonStatus(status(), INSTANCE).payload.text).toBe('hello world & goodbye');
  });

  it('names the event from the endpoint and the reply marker', () => {
    expect(mastodonEventName(status())).toBe('post');
    expect(mastodonEventName(status({ inReplyToId: '108' }))).toBe('reply');
    expect(mastodonEventName(status({ source: 'notification-mention' }))).toBe('mention');
  });

  it('carries visibility VERBATIM so the neutral mapping is not pre-guessed', () => {
    expect(normalizeMastodonStatus(status({ visibility: 'private' }), INSTANCE).payload.visibility).toBe('private');
  });

  it('keys on the version, so an edit re-delivers and a replay does not', () => {
    const original = status();
    const replayed = status();
    const edited = status({ editedAt: '2026-08-23T09:00:00.000Z' });
    expect(mastodonDedupeKey(original)).toBe(mastodonDedupeKey(replayed));
    expect(mastodonDedupeKey(edited)).not.toBe(mastodonDedupeKey(original));
  });

  it('a status delivered by BOTH the stream and the REST re-read collapses to one key', () => {
    // This is not a nicety on this platform. The stream cannot replay, so every
    // connect must re-read REST over a window that necessarily overlaps what the
    // stream already delivered. The key is the only thing that collapses it.
    const fromStream = status({ source: 'timeline' });
    const fromRest = status({ source: 'timeline' });
    expect(mastodonDedupeKey(fromStream)).toBe(mastodonDedupeKey(fromRest));
  });

  it('THE READ→REPLY SEAM: the emitted payload satisfies the real coordinate derivation', () => {
    // `resolveSocialReplyCoordinates` reads `statusId` and `instanceHost` off
    // the stored document and THROWS without them. Omitting either would not
    // fail at ingestion — it would fail later, at every attempt to reply, on a
    // document that looked perfectly healthy. Nothing else in either suite
    // crosses this seam, so this is the only place that failure is visible.
    const event = normalizeMastodonStatus(status({ visibility: 'private' }), INSTANCE);
    const doc: CanonicalDocument = {
      id: 'doc-1',
      source: 'mastodon',
      kind: 'social-post',
      externalId: event.externalId,
      occurredAt: event.occurredAt ?? null,
      participants: [],
      title: '',
      text: String(event.payload.text),
      payload: event.payload,
    };
    const coordinates = resolveSocialReplyCoordinates(doc);
    expect(coordinates.target).toEqual({
      platform: 'mastodon',
      inReplyToId: '109252268000000001',
      instanceHost: INSTANCE,
    });
    // 'private' is Mastodon's followers-only. It must arrive on the neutral
    // ladder as `followers`, NOT as `direct` and emphatically not as `public`.
    expect(coordinates.parentVisibility).toBe('followers');
  });
});

/* -------------------------------------------------------------------------- */

describe('rate limiting — the reset TIMESTAMP, because that is what is published', () => {
  const now = Date.UTC(2026, 7, 23, 12, 0, 0);

  it('waits until the server-published reset', () => {
    const resetAt = new Date(now + 5_000).toISOString();
    expect(mastodonRetryDelayMs(new MastodonRateLimited(resetAt), 0, now)).toBe(5_000);
  });

  it('retries immediately when the reset is already past', () => {
    const resetAt = new Date(now - 5_000).toISOString();
    expect(mastodonRetryDelayMs(new MastodonRateLimited(resetAt), 0, now)).toBe(0);
  });

  it('PROPAGATES rather than blocking when the reset is far out', () => {
    // The status-deletion budget is 30 per 30 minutes, so a reset really can be
    // half an hour away. Absorbing that would look like a hang.
    const resetAt = new Date(now + MASTODON_MAX_RATE_LIMIT_WAIT_MS + 1_000).toISOString();
    expect(mastodonRetryDelayMs(new MastodonRateLimited(resetAt), 0, now)).toBeNull();
  });

  it('falls back to bounded backoff when no reset header was sent', () => {
    expect(mastodonRetryDelayMs(new MastodonRateLimited(null), 0, now)).toBe(1_000);
    expect(mastodonRetryDelayMs(new MastodonRateLimited('not-a-date'), 2, now)).toBe(4_000);
  });

  it('does not retry an error that is not a rate limit', () => {
    expect(mastodonRetryDelayMs(new Error('boom'), 0, now)).toBeNull();
  });
});

describe('instance discovery — the streaming host is not derivable from the API host', () => {
  const HOST = 'mastodon.test';
  const advertising = (streaming: unknown) => ({ configuration: { urls: { streaming } } });

  it('reads configuration.urls.streaming', () => {
    expect(mastodonStreamingUrl(advertising('wss://stream.mastodon.test'), HOST)).toBe(
      'wss://stream.mastodon.test',
    );
  });

  it('accepts a streaming host that IS the instance host', () => {
    expect(mastodonStreamingUrl(advertising('wss://mastodon.test/api/v1/streaming'), HOST)).toBe(
      'wss://mastodon.test/api/v1/streaming',
    );
  });

  it('returns null rather than guessing when it is absent or malformed', () => {
    // A guessed streaming URL fails at connect time against a different host —
    // a far worse place to discover the mistake than here.
    expect(mastodonStreamingUrl({ configuration: { urls: {} } }, HOST)).toBeNull();
    expect(mastodonStreamingUrl({ configuration: {} }, HOST)).toBeNull();
    expect(mastodonStreamingUrl({}, HOST)).toBeNull();
    expect(mastodonStreamingUrl(null, HOST)).toBeNull();
    expect(mastodonStreamingUrl(advertising('   '), HOST)).toBeNull();
  });

  // ── P-024: the value is supplied by the remote instance ─────────────────────
  // These four are the whole reason the parameter is required. Each is a legal
  // string an instance is free to put in its own configuration, and each would
  // otherwise be obeyed with the user's token attached.
  it('REFUSES a streaming host outside the instance, and says so instead of returning null', () => {
    expect(() => mastodonStreamingUrl(advertising('wss://collector.example/'), HOST)).toThrow(
      /social_egress_denied:mastodon:host-not-declared/,
    );
  });

  it('REFUSES a sibling host that merely shares a suffix', () => {
    // 'evil-mastodon.test' ends with 'mastodon.test' as a STRING but is a
    // different domain; only a label boundary makes it a subdomain.
    expect(() => mastodonStreamingUrl(advertising('wss://evil-mastodon.test/'), HOST)).toThrow(
      /host-not-declared/,
    );
  });

  it('REFUSES a plaintext downgrade of a legitimate host', () => {
    expect(() => mastodonStreamingUrl(advertising('ws://stream.mastodon.test'), HOST)).toThrow(
      /forbidden-scheme/,
    );
  });

  it('REFUSES userinfo smuggling the instance host into the credential slot', () => {
    expect(() => mastodonStreamingUrl(advertising('wss://mastodon.test@evil.example/'), HOST)).toThrow(
      /embedded-credentials/,
    );
  });
});

describe('cursor validity', () => {
  it('accepts a stored marker and rejects everything else', () => {
    expect(isMastodonCursor({ minId: '9' })).toBe(true);
    expect(isMastodonCursor({ minId: '' })).toBe(false);
    expect(isMastodonCursor({ seq: 12 })).toBe(false);
    expect(isMastodonCursor(null)).toBe(false);
    expect(isMastodonCursor('9')).toBe(false);
  });

  it('refuses to construct without an instance host', () => {
    const world = makeWorld();
    expect(() => new MastodonAdapter({ client: makeClient(world), instanceHost: '  ' })).toThrow(
      /requires_instance_host/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Controls — the kit must FAIL each broken adapter on its named check         */
/* -------------------------------------------------------------------------- */

describe('controls — the kit must FAIL a broken adapter', () => {
  async function failuresFor(h: SocialConformanceHarness<World>): Promise<string[]> {
    const report = await runSocialAdapterConformance(h);
    return report.failures.map((f) => f.check);
  }

  it('THE SIGNATURE BUG: paging a gap with since_id loses its middle', async () => {
    // A `since_id` read sets a lower bound and returns the NEWEST page. With a
    // gap of 3 and a page size of 2 that is the newest 2 — the oldest one is
    // gone permanently, and the adapter's cursor sails past it.
    //
    // What makes this the dangerous one: it emits a full page of real events and
    // reports a healthy count. There is no zero-events tell, no error, no
    // refusal. Only the kit's identity check on WHICH events arrived can see it.
    const sinceIdClient = (world: World): MastodonReadClient => ({
      async fetchNewer(minId: string | null): Promise<MastodonPage> {
        const start = minId === null ? 0 : world.statuses.findIndex((s) => s.id === minId) + 1;
        const matching = world.statuses.slice(start);
        const newest = matching.slice(-world.pageSize); // ← the bug, in one line
        return {
          statuses: [...newest].reverse(),
          nextMinId: newest.length ? newest[newest.length - 1].id : null,
          hasMore: false,
        };
      },
    });
    expect(await failuresFor(harness(sinceIdClient))).toContain('offline-gap-closed-exactly-once');
  });

  it('an adapter that filters by lexicographic id comparison loses events', async () => {
    class LexicographicAdapter implements SocialAdapter {
      readonly platformId = 'mastodon' as const;
      constructor(private readonly world: World) {}
      async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
        const stored = isMastodonCursor(ctx.cursor) ? (ctx.cursor as MastodonCursor) : null;
        // The plausible-looking mistake: treat the id as sortable text.
        const fresh = this.world.statuses.filter((s) => (stored ? s.id > stored.minId : true));
        for (const s of fresh) await ctx.emit(normalizeMastodonStatus(s, INSTANCE));
        const last = this.world.statuses[this.world.statuses.length - 1];
        return {
          cursor: last ? { minId: last.id } : null,
          emitted: fresh.length,
          path: 'backfill',
          backfillReason: 'no-replay-supported',
        };
      }
    }
    const h = harness();
    const broken: SocialConformanceHarness<World> = {
      ...h,
      async create() {
        const world = makeWorld();
        return { world, adapter: new LexicographicAdapter(world) };
      },
    };
    // MEASURED, not predicted. The failure is RE-EMISSION, not loss: with ids
    // "9" and "10" the marker lands on "10", and `"9" > "10"` is true as text —
    // so the OLDEST status looks permanently newer than the cursor and is
    // re-emitted on every single pass, re-firing every binding forever.
    //
    // Worth stating because the first draft of this control asserted the gap
    // check and was wrong. Which check catches a bug is a property of the code,
    // not something to reason out from the bug's description.
    expect(await failuresFor(broken)).toEqual([
      'no-op-reconcile-emits-nothing',
      'no-op-reconcile-emits-nothing',
      'unreadable-cursor-falls-back-to-backfill',
    ]);
  });

  it('a cursor that does not advance past the final page re-emits it forever', async () => {
    // The port-contract bug that `hasMore` exists to prevent: advancing the
    // marker only while more pages remain leaves it behind the last page.
    const conflatingClient = (world: World): MastodonReadClient => ({
      async fetchNewer(minId: string | null): Promise<MastodonPage> {
        const start = minId === null ? 0 : world.statuses.findIndex((s) => s.id === minId) + 1;
        const slice = world.statuses.slice(start, start + world.pageSize);
        const more = start + slice.length < world.statuses.length;
        return {
          statuses: [...slice].reverse(),
          // The bug: withhold the marker on the final page.
          nextMinId: more && slice.length ? slice[slice.length - 1].id : null,
          hasMore: more,
        };
      },
    });
    expect(await failuresFor(harness(conflatingClient))).toContain('no-op-reconcile-emits-nothing');
  });

  it('a dedupe key built from wall-clock defeats replay dedupe', async () => {
    class ClockKeyAdapter implements SocialAdapter {
      readonly platformId = 'mastodon' as const;
      constructor(private readonly world: World) {}
      async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
        for (const s of this.world.statuses) {
          const event = normalizeMastodonStatus(s, INSTANCE);
          await ctx.emit({ ...event, dedupeKey: `${s.id}@${Date.now()}${Math.random()}` });
        }
        return { cursor: null, emitted: this.world.statuses.length, path: 'cold-start' };
      }
    }
    const h = harness();
    const broken: SocialConformanceHarness<World> = {
      ...h,
      async create() {
        const world = makeWorld();
        return { world, adapter: new ClockKeyAdapter(world) };
      },
    };
    expect(await failuresFor(broken)).toContain('dedupe-keys-unique-and-stable');
  });

  it('an adapter that leaks the credential into a payload is caught', async () => {
    class LeakyAdapter implements SocialAdapter {
      readonly platformId = 'mastodon' as const;
      constructor(private readonly world: World) {}
      async reconcile(ctx: SocialReconcileContext): Promise<SocialReconcileResult> {
        for (const s of this.world.statuses) {
          const event = normalizeMastodonStatus(s, INSTANCE);
          await ctx.emit({ ...event, payload: { ...event.payload, token: NEVER_EMIT_MARKER } });
        }
        return { cursor: null, emitted: this.world.statuses.length, path: 'cold-start' };
      }
    }
    const h = harness();
    const broken: SocialConformanceHarness<World> = {
      ...h,
      async create() {
        const world = makeWorld();
        return { world, adapter: new LeakyAdapter(world) };
      },
    };
    expect(await failuresFor(broken)).toContain('credential-never-emitted');
  });

  it('an adapter that propagates a rate limit drops the page', async () => {
    const brittleClient = (world: World): MastodonReadClient => ({
      async fetchNewer(minId: string | null): Promise<MastodonPage> {
        if (world.rateLimitNext) {
          world.rateLimitNext = false;
          throw new MastodonRateLimited(new Date(Date.UTC(2020, 0, 1)).toISOString());
        }
        const start = minId === null ? 0 : world.statuses.findIndex((s) => s.id === minId) + 1;
        const slice = world.statuses.slice(start, start + world.pageSize);
        return {
          statuses: [...slice].reverse(),
          nextMinId: slice.length ? slice[slice.length - 1].id : null,
          hasMore: start + slice.length < world.statuses.length,
        };
      },
    });
    const h = harness(brittleClient);
    const broken: SocialConformanceHarness<World> = {
      ...h,
      async create() {
        const world = makeWorld();
        return {
          world,
          // maxRetries 0 — absorb nothing.
          adapter: new MastodonAdapter({
            client: brittleClient(world),
            instanceHost: INSTANCE,
            maxRetries: 0,
          }),
        };
      },
    };
    expect(await failuresFor(broken)).toContain('rate-limit-is-absorbed');
  });
});
