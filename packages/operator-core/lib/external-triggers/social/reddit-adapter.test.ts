/**
 * Reddit adapter tests — P-013.
 *
 * THE PAGE SIZE IS THE POINT (D-013, binding). The conformance kit's gap check
 * publishes THREE items into the offline window. A harness whose page size is
 * >= 3 closes that gap in a single request, so `offline-gap-closed-exactly-once`
 * would pass without the multi-page walk ever executing — the check would be
 * decoration that a broken paginator sails through. PAGE_SIZE is therefore 2,
 * and `walks more than one page to close the kit's gap` asserts the request
 * COUNT rather than trusting the constant to stay small.
 *
 * The controls at the bottom are permanent. Each is a real failure mode, and
 * each must FAIL the kit — a conformance kit nobody has watched fail is a kit
 * that proves nothing.
 */
import { describe, expect, it } from 'vitest';

import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import { resolveSocialReplyCoordinates } from '../../capability-verbs/social';
import type { SocialAdapter, SocialNormalizedEvent } from './adapter-contract';
import {
  assertRedditUserAgent,
  clampRedditLimit,
  isRedditCursor,
  normalizeRedditThing,
  redditDedupeKey,
  redditEditedMarker,
  redditEventName,
  redditRetryDelayMs,
  RedditAdapter,
  RedditRateLimited,
  REDDIT_LIMIT_DEFAULT,
  REDDIT_LIMIT_MAX,
  REDDIT_MAX_RATE_LIMIT_WAIT_MS,
  type RedditCursor,
  type RedditListingPage,
  type RedditRawThing,
  type RedditReadClient,
} from './reddit-adapter';

/** Smaller than the kit's 3-item gap, so the gap check must paginate. D-013. */
const PAGE_SIZE = 2;

const USER_AGENT = 'linux:ai.papercusp.operator:v0.1.0 (by /u/papercusp_bot)';

/**
 * The value the kit scans emitted output for. Deliberately low-entropy and
 * named for its ROLE, matching the Bluesky and Mastodon suites: a realistic
 * credential-shaped fixture trips the secrets guard on write and, worse, the
 * pot-git publish guard forever after — the blob stays in history, so editing
 * the file afterwards does not clear it (EI-21230011589307899).
 */
const NEVER_EMIT_MARKER = 'never-emit-me';

/* -------------------------------------------------------------------------- */
/* A fake reddit                                                              */
/* -------------------------------------------------------------------------- */

interface FakeWorld {
  /** Newest-first, exactly as reddit serves a listing. */
  listing: RedditRawThing[];
  requests: { after: string | null; limit: number }[];
  rateLimitNext: boolean;
  seq: number;
  /**
   * The newest thing ever served from the TOP of the listing — which is exactly
   * what the adapter will have stored as its marker. Tracked so `expireCursor`
   * can delete the post the marker names without being told the cursor, which
   * the kit's harness interface deliberately does not hand it.
   */
  newestServed: string | null;
}

function makeWorld(): FakeWorld {
  return { listing: [], requests: [], rateLimitNext: false, seq: 0, newestServed: null };
}

function makeThing(world: FakeWorld, over: Partial<RedditRawThing> = {}): RedditRawThing {
  world.seq += 1;
  const id = `abc${world.seq}`;
  return {
    kind: 't3',
    name: `t3_${id}`,
    id,
    author: 'someone',
    subreddit: 'papercusp',
    createdUtc: 1_700_000_000 + world.seq,
    edited: false,
    title: `post ${world.seq}`,
    text: `body ${world.seq}`,
    permalink: `/r/papercusp/comments/${id}/post_${world.seq}/`,
    ...over,
  };
}

function fakeClient(world: FakeWorld): RedditReadClient {
  return {
    async fetchPage({ after, limit }): Promise<RedditListingPage> {
      world.requests.push({ after, limit });
      if (world.rateLimitNext) {
        world.rateLimitNext = false;
        throw new RedditRateLimited('429 too many requests', 0);
      }
      let start = 0;
      if (after !== null) {
        const at = world.listing.findIndex((t) => t.name === after);
        // A dropped anchor behaves as reddit does: the listing is served from
        // the top as though no anchor had been supplied.
        start = at === -1 ? 0 : at + 1;
      }
      const children = world.listing.slice(start, start + limit);
      if (after === null && children[0]) world.newestServed = children[0].name;
      const tail = children[children.length - 1];
      return { children, after: children.length === limit && tail ? tail.name : null };
    },
  };
}

function newAdapter(world: FakeWorld, over: Partial<ConstructorParameters<typeof RedditAdapter>[0]> = {}) {
  return new RedditAdapter({ client: fakeClient(world), userAgent: USER_AGENT, pageSize: PAGE_SIZE, ...over });
}

function harness(over: Partial<SocialConformanceHarness<FakeWorld>> = {}): SocialConformanceHarness<FakeWorld> {
  return {
    async create() {
      const world = makeWorld();
      return { adapter: newAdapter(world), world };
    },
    async publish(world, count) {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const thing = makeThing(world);
        world.listing.unshift(thing); // newest-first
        ids.push(thing.name);
      }
      return ids; // oldest first
    },
    async expireCursor(world) {
      // The realistic way a Reddit marker becomes unusable: the post it names is
      // deleted, so its fullname is no longer anywhere in the listing. There is
      // deliberately no synthetic "provider refuses the cursor" here, because
      // reddit has no such response — this walk never sends the marker at all.
      //
      // It must delete the post the MARKER names, not merely the oldest post:
      // the first draft deleted the oldest, the marker stayed findable, and the
      // check passed against an adapter that had never taken the backfill path.
      const marker = world.newestServed;
      if (!marker) throw new Error('expireCursor called before anything was served — the fake cannot know the marker');
      world.listing = world.listing.filter((t) => t.name !== marker);
    },
    async rateLimitOnce(world) {
      world.rateLimitNext = true;
    },
    secret: NEVER_EMIT_MARKER,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
    ...over,
  };
}

async function drain(adapter: SocialAdapter, cursor: unknown | null) {
  const events: SocialNormalizedEvent[] = [];
  const result = await adapter.reconcile({
    cursor,
    async emit(event) {
      events.push(event);
    },
  });
  return { result, events };
}

/* -------------------------------------------------------------------------- */

describe('RedditAdapter — P-003 conformance', () => {
  it('passes every check the kit can run', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.platformId).toBe('reddit');
  });

  it('runs the cursor-unusable check rather than skipping it', async () => {
    // Reddit has no cursor a provider can refuse, so the temptation is to omit
    // expireCursor and let the kit skip. The check still MEANS something here —
    // "the marker is no longer in the listing" is the same hazard by another
    // mechanism — and skipping it would leave this adapter's single most likely
    // real-world failure untested.
    const report = await runSocialAdapterConformance(harness());
    expect(report.checksRun).toContain('cursor-unusable-falls-back-to-backfill');
    expect(report.checksSkipped.map((s) => s.check)).not.toContain('cursor-unusable-falls-back-to-backfill');
  });

  it('walks more than one page to close the kit’s gap', async () => {
    // D-013 is only satisfied if the walk actually happens. Asserting the
    // REQUEST COUNT rather than the constant means raising PAGE_SIZE later
    // fails here, instead of silently hollowing out the gap check.
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 2);
    const first = await drain(adapter, null);

    world.requests.length = 0;
    const missed = await h.publish(world, 3);
    const second = await drain(adapter, first.result.cursor);

    expect(world.requests.length).toBeGreaterThan(1);
    expect(second.events.map((e) => e.externalId).sort()).toEqual([...missed].sort());
  });
});

describe('the walk anchors on the top of the listing, never on the stored marker', () => {
  it('never sends the stored marker to the provider', async () => {
    // The rejected design passes the marker as `before`. Reddit drops an
    // unresolvable anchor silently and serves page 1, which would make `path` a
    // guess. This asserts the marker never leaves the process.
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 2);
    const first = await drain(adapter, null);
    const marker = (first.result.cursor as RedditCursor).newestFullname;

    world.requests.length = 0;
    await h.publish(world, 3);
    await drain(adapter, first.result.cursor);

    expect(world.requests.map((r) => r.after)).not.toContain(marker);
    expect(world.requests[0]!.after).toBeNull(); // the walk starts at the top
  });

  it('reports backfill/cursor-expired when the marker has left the listing', async () => {
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 1);
    const first = await drain(adapter, null);

    world.listing = world.listing.filter(
      (t) => t.name !== (first.result.cursor as RedditCursor).newestFullname,
    );
    const missed = await h.publish(world, 3);

    const second = await drain(adapter, first.result.cursor);
    expect(second.result.path).toBe('backfill');
    expect(second.result.backfillReason).toBe('cursor-expired');
    for (const id of missed) expect(second.events.map((e) => e.externalId)).toContain(id);
  });

  it('never reports cursor-rejected, because the marker is never sent', async () => {
    // 'cursor-rejected' means the PROVIDER refused the cursor. This walk gives
    // reddit no cursor to refuse, so emitting that reason would send whoever
    // reads it hunting for a provider error that was never produced.
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 4);
    const first = await drain(adapter, null);
    world.listing = [];
    const second = await drain(adapter, first.result.cursor);
    expect(second.result.backfillReason).not.toBe('cursor-rejected');
  });

  it('stops at maxPages rather than walking a listing forever', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world, { maxPages: 3 });
    for (let i = 0; i < 50; i += 1) world.listing.unshift(makeThing(world));
    const { result } = await drain(adapter, null);
    expect(world.requests.length).toBe(3);
    expect(result.emitted).toBe(3 * PAGE_SIZE);
  });
});

describe('reconcile paths are declared honestly', () => {
  it('cold-start when there is no stored cursor', async () => {
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 2);
    const { result } = await drain(adapter, null);
    expect(result.path).toBe('cold-start');
    expect(result.backfillReason).toBeUndefined();
  });

  it('live-only when the marker is already the newest thing', async () => {
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 2);
    const first = await drain(adapter, null);
    const second = await drain(adapter, first.result.cursor);
    expect(second.result.path).toBe('live-only');
    expect(second.result.emitted).toBe(0);
  });

  it('cursor-replay when the marker is found with newer items above it', async () => {
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 2);
    const first = await drain(adapter, null);
    await h.publish(world, 1);
    const second = await drain(adapter, first.result.cursor);
    expect(second.result.path).toBe('cursor-replay');
    expect(second.result.emitted).toBe(1);
  });

  it('keeps the stored cursor when a pass reads nothing new', async () => {
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 2);
    const first = await drain(adapter, null);
    const second = await drain(adapter, first.result.cursor);
    expect(second.result.cursor).toEqual(first.result.cursor);
  });
});

describe('the cursor carries one meaning, not two', () => {
  it('the marker is the newest EMITTED thing, not the last page boundary', async () => {
    // The P-012 defect this guards: one field doing double duty as both "where
    // to resume" and "keep walking". They agree on every page but the last.
    const h = harness();
    const { adapter, world } = await h.create();
    const ids = await h.publish(world, 5); // oldest-first
    const { result } = await drain(adapter, null);
    expect((result.cursor as RedditCursor).newestFullname).toBe(ids[ids.length - 1]);
  });

  it('rejects a malformed stored cursor instead of trusting it', () => {
    expect(isRedditCursor({ newestFullname: 't3_abc1' })).toBe(true);
    expect(isRedditCursor({ newestFullname: 'abc1' })).toBe(false);
    expect(isRedditCursor({ newestFullname: 42 })).toBe(false);
    expect(isRedditCursor(null)).toBe(false);
    expect(isRedditCursor('t3_abc1')).toBe(false);
  });

  it('treats an unrecognised cursor as rejected state rather than a cold start or throw', async () => {
    const h = harness();
    const { adapter, world } = await h.create();
    await h.publish(world, 2);
    const { result, events } = await drain(adapter, { minId: 'a-mastodon-cursor' });
    expect(result.path).toBe('backfill');
    expect(result.backfillReason).toBe('cursor-rejected');
    expect(events.length).toBe(2);
  });
});

describe('emission order and within-pass dedupe', () => {
  it('emits oldest-first even though the listing is newest-first', async () => {
    const h = harness();
    const { adapter, world } = await h.create();
    const ids = await h.publish(world, 3);
    const { events } = await drain(adapter, null);
    expect(events.map((e) => e.externalId)).toEqual(ids);
  });

  it('collapses an item re-served when the listing shifts mid-walk', async () => {
    // A new post arriving between page 1 and page 2 shifts every boundary down
    // by one, so the item at the old boundary is served twice. Without the
    // within-pass dedupe that is a duplicate emission inside ONE reconcile,
    // which the kit's gap check would catch only by luck of timing.
    const world = makeWorld();
    const inner = fakeClient(world);
    const shifting: RedditReadClient = {
      async fetchPage(params) {
        const page = await inner.fetchPage(params);
        if (world.requests.length === 1) world.listing.unshift(makeThing(world));
        return page;
      },
    };
    const adapter = new RedditAdapter({ client: shifting, userAgent: USER_AGENT, pageSize: PAGE_SIZE });
    for (let i = 0; i < 4; i += 1) world.listing.unshift(makeThing(world));

    const { events } = await drain(adapter, null);
    const ids = events.map((e) => e.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('`edited` is a three-valued field, not a boolean', () => {
  it('distinguishes never-edited, edited-with-a-date, and the legacy `true`', () => {
    expect(redditEditedMarker(false, 100)).toBe('c100');
    expect(redditEditedMarker(1_700_000_500, 100)).toBe('e1700000500');
    expect(redditEditedMarker(true, 100)).toBe('e-legacy');
  });

  it('gives an edit a different dedupe key, so the edit is re-delivered', () => {
    const base = { name: 't3_abc1', createdUtc: 100 };
    const before = redditDedupeKey({ ...base, edited: false });
    const after = redditDedupeKey({ ...base, edited: 1_700_000_500 });
    expect(after).not.toBe(before);
  });

  it('keeps the key STABLE across a replay, which is what dedupe needs', () => {
    const thing = { name: 't3_abc1', createdUtc: 100, edited: 1_700_000_500 };
    expect(redditDedupeKey(thing)).toBe(redditDedupeKey(thing));
  });

  it('does not coerce the legacy `true` into a wall-clock value', () => {
    // Coercing it to Date.now() would make the key different on every pass,
    // turning replay dedupe off entirely for those rows — the loudest possible
    // version of this bug, and the tempting fix for the missing timestamp.
    const thing = { name: 't1_abc1', createdUtc: 100, edited: true as const };
    expect(redditDedupeKey(thing)).toBe(redditDedupeKey(thing));
    expect(redditDedupeKey(thing)).not.toMatch(/\d{13}/);
  });
});

describe('normalization', () => {
  it('carries the two fields the reply seam reads off the stored document', () => {
    const world = makeWorld();
    const thing = makeThing(world, { subreddit: 'papercusp' });
    const event = normalizeRedditThing(thing);
    expect(event.payload.fullname).toBe(thing.name);
    expect(event.payload.subreddit).toBe('papercusp');
  });

  it('round-trips through the REAL reply-coordinate derivation', () => {
    // The Mastodon lesson: omitting a coordinate field does not fail at ingest,
    // it fails much later at every reply attempt, against a document that looks
    // perfectly fine. Driving the real derivation is what catches it here.
    const world = makeWorld();
    const thing = makeThing(world, { subreddit: 'papercusp' });
    const event = normalizeRedditThing(thing);
    const coordinates = resolveSocialReplyCoordinates({
      source: 'reddit',
      externalId: event.externalId,
      payload: event.payload,
    } as never);
    expect(coordinates.target).toEqual({
      platform: 'reddit',
      parentFullname: thing.name,
      subreddit: 'papercusp',
    });
  });

  it('names a comment and a link differently', () => {
    expect(redditEventName({ kind: 't1' })).toBe('comment');
    expect(redditEventName({ kind: 't3' })).toBe('post');
  });

  it('converts epoch SECONDS to ISO, not epoch milliseconds', () => {
    const world = makeWorld();
    const event = normalizeRedditThing(makeThing(world, { createdUtc: 1_700_000_000 }));
    expect(event.occurredAt).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('limit clamping mirrors VLimit', () => {
  it('clamps to [1, 100] and defaults to 25', () => {
    expect(clampRedditLimit(undefined)).toBe(REDDIT_LIMIT_DEFAULT);
    expect(clampRedditLimit(null)).toBe(REDDIT_LIMIT_DEFAULT);
    expect(clampRedditLimit(0)).toBe(1);
    expect(clampRedditLimit(-5)).toBe(1);
    expect(clampRedditLimit(500)).toBe(REDDIT_LIMIT_MAX);
    expect(clampRedditLimit(50)).toBe(50);
  });

  it('clamps the adapter’s page size, so "was the page full?" stays answerable', async () => {
    // An adapter that asked for 500 and compared the result against 500 would
    // read every page as short and conclude the listing was exhausted on the
    // very first call — losing everything below page one, silently.
    const world = makeWorld();
    const adapter = newAdapter(world, { pageSize: 500 });
    for (let i = 0; i < 250; i += 1) world.listing.unshift(makeThing(world));
    await drain(adapter, null);
    expect(world.requests[0]!.limit).toBe(REDDIT_LIMIT_MAX);
    expect(world.requests.length).toBeGreaterThan(1);
  });
});

describe('rate limiting — X-Ratelimit-Reset is SECONDS REMAINING, not a timestamp', () => {
  it('waits the stated remainder', () => {
    expect(redditRetryDelayMs(new RedditRateLimited('429', 12), 0, 4)).toBe(12_000);
  });

  it('caps the wait so a large or bogus reset cannot hang the adapter', () => {
    expect(redditRetryDelayMs(new RedditRateLimited('429', 86_400), 0, 4)).toBe(REDDIT_MAX_RATE_LIMIT_WAIT_MS);
  });

  it('does not read the reset as an epoch', () => {
    // Reading 1_700_000_000 as an epoch would produce a ~57-year wait, which
    // presents as a hung adapter rather than as an error anyone can find.
    expect(redditRetryDelayMs(new RedditRateLimited('429', 1_700_000_000), 0, 4)).toBe(
      REDDIT_MAX_RATE_LIMIT_WAIT_MS,
    );
  });

  it('backs off exponentially when the header is absent', () => {
    expect(redditRetryDelayMs(new RedditRateLimited('429', null), 0, 4)).toBe(1000);
    expect(redditRetryDelayMs(new RedditRateLimited('429', null), 2, 4)).toBe(4000);
  });

  it('gives up at the retry ceiling instead of retrying forever', () => {
    expect(redditRetryDelayMs(new RedditRateLimited('429', 1), 4, 4)).toBeNull();
  });

  it('never retries a non-rate-limit error', () => {
    expect(redditRetryDelayMs(new Error('connection reset'), 0, 4)).toBeNull();
  });
});

describe('the mandatory User-Agent is enforced at construction', () => {
  it('accepts the documented format', () => {
    expect(assertRedditUserAgent(USER_AGENT)).toBe(USER_AGENT);
  });

  it('refuses the generic agents reddit throttles', () => {
    expect(() => assertRedditUserAgent('Python/urllib')).toThrow(/reddit_user_agent_invalid/);
    expect(() => assertRedditUserAgent('Java')).toThrow(/reddit_user_agent_invalid/);
    expect(() => assertRedditUserAgent('')).toThrow(/reddit_user_agent_invalid/);
  });

  it('refuses a browser impersonation, which the rules forbid outright', () => {
    expect(() => assertRedditUserAgent('Mozilla/5.0 (X11; Linux x86_64)')).toThrow(/reddit_user_agent_invalid/);
  });

  it('refuses an agent missing the contact half', () => {
    expect(() => assertRedditUserAgent('linux:ai.papercusp.operator:v0.1.0')).toThrow(/reddit_user_agent_invalid/);
  });

  it('fails the adapter fast rather than earning a silent throttle later', () => {
    expect(() => new RedditAdapter({ client: fakeClient(makeWorld()), userAgent: 'bot' })).toThrow(
      /reddit_user_agent_invalid/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Controls — the kit must FAIL a broken adapter                              */
/* -------------------------------------------------------------------------- */

type Ctx = Parameters<RedditAdapter['reconcile']>[0];

describe('controls — the kit must FAIL a broken adapter', () => {
  async function failuresFor(build: (world: FakeWorld) => SocialAdapter): Promise<string[]> {
    const base = harness();
    const report = await runSocialAdapterConformance({
      ...base,
      async create() {
        const world = makeWorld();
        return { adapter: build(world), world };
      },
    });
    return report.failures.map((f) => f.check);
  }

  it('catches an adapter that reads only the first page (the D-013 control)', async () => {
    // The single most likely Reddit bug: read page one, call it a day. With a
    // page size >= the kit's 3-item gap this adapter would PASS the gap check,
    // which is precisely why PAGE_SIZE is 2.
    const checks = await failuresFor(
      (world) =>
        new (class extends RedditAdapter {
          override async reconcile(ctx: Ctx) {
            return super.reconcile({ ...ctx, cursor: ctx.cursor });
          }
        })({ client: fakeClient(world), userAgent: USER_AGENT, pageSize: PAGE_SIZE, maxPages: 1 }),
    );
    expect(checks).toContain('offline-gap-closed-exactly-once');
  });

  it('D-013 CALIBRATION: the same broken adapter PASSES the gap check at page size 3', async () => {
    // The reason D-013 exists, measured rather than asserted. The identical
    // one-page adapter is run with a page size >= the kit's 3-item gap: it now
    // closes the gap in a single request and the check goes green while the
    // paginator is still broken.
    //
    // This is the control on the control. Without it, "PAGE_SIZE must be < 3"
    // is a claim about the kit that nobody has watched be true — and the cost of
    // being wrong is not a failing test, it is a check that silently proves
    // nothing for every adapter that follows.
    const base = harness();
    const report = await runSocialAdapterConformance({
      ...base,
      async create() {
        const world = makeWorld();
        return {
          adapter: new RedditAdapter({
            client: fakeClient(world),
            userAgent: USER_AGENT,
            pageSize: 3,
            maxPages: 1,
          }),
          world,
        };
      },
    });
    expect(report.failures.map((f) => f.check)).not.toContain('offline-gap-closed-exactly-once');
  });

  it('catches an adapter that re-reads the whole listing every pass', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends RedditAdapter {
          override async reconcile(ctx: Ctx) {
            return super.reconcile({ ...ctx, cursor: null });
          }
        })({ client: fakeClient(world), userAgent: USER_AGENT, pageSize: PAGE_SIZE }),
    );
    expect(checks).toContain('no-op-reconcile-emits-nothing');
  });

  it('catches an adapter that reports live-only when the marker is gone', async () => {
    // The silent-loss failure D-005 exists for: shrug, report success, lose the
    // gap. It is invisible from the outside because it emits zero events.
    const checks = await failuresFor(
      (world) =>
        new (class extends RedditAdapter {
          override async reconcile(ctx: Ctx) {
            const result = await super.reconcile(ctx);
            if (result.path === 'backfill') {
              return { ...result, path: 'live-only' as const, backfillReason: undefined };
            }
            return result;
          }
        })({ client: fakeClient(world), userAgent: USER_AGENT, pageSize: PAGE_SIZE }),
    );
    expect(checks).toContain('cursor-unusable-falls-back-to-backfill');
  });

  it('catches a backfill that does not state its reason', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends RedditAdapter {
          override async reconcile(ctx: Ctx) {
            const result = await super.reconcile(ctx);
            if (result.path === 'backfill') return { ...result, backfillReason: undefined };
            return result;
          }
        })({ client: fakeClient(world), userAgent: USER_AGENT, pageSize: PAGE_SIZE }),
    );
    expect(checks).toContain('cursor-unusable-falls-back-to-backfill');
  });

  it('catches a dedupe key that is not stable across a replay', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends RedditAdapter {
          override async reconcile(ctx: Ctx) {
            return super.reconcile({
              ...ctx,
              emit: (event) => ctx.emit({ ...event, dedupeKey: `${event.dedupeKey}:${Math.random()}` }),
            });
          }
        })({ client: fakeClient(world), userAgent: USER_AGENT, pageSize: PAGE_SIZE }),
    );
    expect(checks).toContain('dedupe-keys-unique-and-stable');
  });

  it('catches an adapter that leaks the credential into the payload', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends RedditAdapter {
          override async reconcile(ctx: Ctx) {
            return super.reconcile({
              ...ctx,
              emit: (event) => ctx.emit({ ...event, payload: { ...event.payload, bearer: NEVER_EMIT_MARKER } }),
            });
          }
        })({ client: fakeClient(world), userAgent: USER_AGENT, pageSize: PAGE_SIZE }),
    );
    expect(checks).toContain('credential-never-emitted');
  });

  it('catches an adapter whose emitted count disagrees with what it emitted', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends RedditAdapter {
          override async reconcile(ctx: Ctx) {
            const result = await super.reconcile(ctx);
            return { ...result, emitted: result.emitted + 1 };
          }
        })({ client: fakeClient(world), userAgent: USER_AGENT, pageSize: PAGE_SIZE }),
    );
    expect(checks).toContain('cold-start');
  });

  it('catches an adapter that propagates a rate limit instead of absorbing it', async () => {
    const checks = await failuresFor((world) => newAdapter(world, { maxRetries: 0 }));
    expect(checks).toContain('rate-limit-is-absorbed');
  });
});
