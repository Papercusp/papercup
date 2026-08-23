/**
 * YouTube activities adapter tests — P-015 stage 2.
 *
 * THE KIT IS RUN TWICE, AGAINST TWO DIFFERENT PROVIDERS. The vendor page for
 * activities.list does not state whether `publishedAfter` includes an activity
 * occurring at exactly that instant (it states the rule only at DAY
 * granularity). Rather than pick a reading and hope, the fake provider here is
 * parameterised by that reading and the ENTIRE conformance kit runs against
 * both. An adapter that silently depends on one of them fails the other run.
 *
 * THE PAGE SIZE IS THE POINT (D-013, binding, inherited from P-013). The kit's
 * gap check publishes THREE items into the offline window, so a page size >= 3
 * closes that gap in a single request and the multi-page walk never executes —
 * the check would be decoration a broken paginator sails through. PAGE_SIZE is
 * 2, and a dedicated test asserts the REQUEST COUNT rather than trusting the
 * constant to stay small.
 *
 * The controls at the bottom are permanent. Each is a real failure mode, and
 * each must FAIL the kit — a conformance kit nobody has watched fail is a kit
 * that proves nothing. Two of them are specific to this adapter's central
 * design decision: they demonstrate that the REJECTED cursor designs lose
 * events, so the one that shipped is not merely asserted to be better.
 */
import { describe, expect, it } from 'vitest';

import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import type { SocialAdapter, SocialNormalizedEvent, SocialReconcileContext } from './adapter-contract';
import {
  clampYouTubeMaxResults,
  isYouTubeActivitiesCursor,
  normalizeYouTubeActivity,
  youtubeActivityDedupeKey,
  youtubeActivityEventName,
  youtubeInstantMs,
  youtubeQueryFloor,
  youtubeRetryDelayMs,
  YouTubeActivitiesAdapter,
  YouTubeCursorRejected,
  YouTubeRateLimited,
  YOUTUBE_ACTIVITIES_PAGE_SIZE_DEFAULT,
  YOUTUBE_MAX_RATE_LIMIT_WAIT_MS,
  YOUTUBE_MAX_RESULTS_CEILING,
  type YouTubeActivitiesClient,
  type YouTubeActivitiesCursor,
  type YouTubeActivitiesPage,
  type YouTubeRawActivity,
} from './youtube-activities-adapter';

type Ctx = SocialReconcileContext;

/** Smaller than the kit's 3-item gap, so the gap check must paginate. D-013. */
const PAGE_SIZE = 2;

/**
 * The value the kit scans emitted output for. Deliberately low-entropy and
 * named for its ROLE, matching the Wave A suites: a realistic credential-shaped
 * fixture trips the secrets guard on write and, worse, the pot-git publish guard
 * forever after — the blob stays in history, so editing the file afterwards does
 * not clear it (EI-21230011589307899).
 */
const NEVER_EMIT_MARKER = 'never-emit-me';

/* -------------------------------------------------------------------------- */
/* A fake YouTube                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How the fake applies `publishedAfter`.
 *
 * `inclusive` — an activity AT the boundary instant is returned (the reading the
 * vendor prose leans toward). `exclusive` — it is not. The adapter must be
 * correct under both; see the file header.
 */
type BoundaryMode = 'inclusive' | 'exclusive';

/** How the fake orders the result set. The vendor page specifies no ordering. */
type ServeOrder = 'newest-first' | 'oldest-first';

interface FakeWorld {
  activities: YouTubeRawActivity[];
  requests: { publishedAfter: string | null; pageToken: string | null; maxResults: number }[];
  boundaryMode: BoundaryMode;
  serveOrder: ServeOrder;
  rejectCursor: boolean;
  rateLimitNext: boolean;
  seq: number;
}

const EPOCH = Date.parse('2026-08-23T12:00:00.000Z');

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    activities: [],
    requests: [],
    boundaryMode: 'inclusive',
    serveOrder: 'newest-first',
    rejectCursor: false,
    rateLimitNext: false,
    seq: 0,
    ...over,
  };
}

/** Add one activity at an explicit instant — used to build same-instant siblings. */
function addActivity(world: FakeWorld, publishedAt: string, over: Partial<YouTubeRawActivity> = {}): string {
  world.seq += 1;
  const id = `act${String(world.seq).padStart(3, '0')}`;
  world.activities.push({
    id,
    publishedAt,
    channelId: 'UC_papercusp',
    channelTitle: 'Papercusp',
    title: `upload ${world.seq}`,
    description: `description ${world.seq}`,
    type: 'upload',
    videoId: `vid${world.seq}`,
    ...over,
  });
  return id;
}

/** `count` activities, each one second newer than the last. Returns ids oldest-first. */
function publishActivities(world: FakeWorld, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    ids.push(addActivity(world, new Date(EPOCH + (world.seq + 1) * 1000).toISOString()));
  }
  return ids;
}

function fakeClient(world: FakeWorld): YouTubeActivitiesClient {
  return {
    async listActivities({ publishedAfter, pageToken, maxResults }): Promise<YouTubeActivitiesPage> {
      world.requests.push({ publishedAfter, pageToken, maxResults });

      if (world.rateLimitNext) {
        world.rateLimitNext = false;
        throw new YouTubeRateLimited('429 rateLimitExceeded', 0);
      }
      if (world.rejectCursor && publishedAfter !== null) {
        throw new YouTubeCursorRejected(
          `400 invalidValue: publishedAfter=${publishedAfter}`,
          publishedAfter,
        );
      }

      const cutoff = publishedAfter === null ? null : Date.parse(publishedAfter);
      const matched = world.activities.filter((activity) => {
        if (cutoff === null) return true;
        const at = Date.parse(activity.publishedAt);
        return world.boundaryMode === 'inclusive' ? at >= cutoff : at > cutoff;
      });

      // Deterministic order within an instant, so a same-instant pair is served
      // in a fixed sequence rather than by array luck.
      matched.sort((a, b) => {
        const delta = Date.parse(a.publishedAt) - Date.parse(b.publishedAt);
        if (delta !== 0) return world.serveOrder === 'newest-first' ? -delta : delta;
        return world.serveOrder === 'newest-first' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
      });

      const offset = pageToken === null ? 0 : Number.parseInt(pageToken, 10);
      const items = matched.slice(offset, offset + maxResults);
      const next = offset + maxResults;
      return { items, nextPageToken: next < matched.length ? String(next) : null };
    },
  };
}

function newAdapter(world: FakeWorld, over: Partial<ConstructorParameters<typeof YouTubeActivitiesAdapter>[0]> = {}) {
  return new YouTubeActivitiesAdapter({
    client: fakeClient(world),
    pageSize: PAGE_SIZE,
    sleep: async () => {},
    ...over,
  });
}

function harness(
  over: Partial<SocialConformanceHarness<FakeWorld>> = {},
  worldOver: Partial<FakeWorld> = {},
): SocialConformanceHarness<FakeWorld> {
  return {
    async create() {
      const world = makeWorld(worldOver);
      return { adapter: newAdapter(world), world };
    },
    async publish(world, count) {
      return publishActivities(world, count);
    },
    async expireCursor(world) {
      // The realistic way a YouTube time cursor becomes unusable: the Data API
      // refuses the VALUE with `400 invalidValue`. There is deliberately no
      // "the anchor item was deleted" variant here — unlike reddit's fullname
      // marker, a timestamp does not stop resolving when its activity is
      // removed, so modelling deletion would be modelling a hazard this stream
      // does not have.
      world.rejectCursor = true;
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

/* -------------------------------------------------------------------------- */
/* Conformance                                                                */
/* -------------------------------------------------------------------------- */

describe('YouTubeActivitiesAdapter — P-003 conformance', () => {
  // The two runs are the whole point: `publishedAfter`'s instant-level
  // behaviour is UNSPECIFIED by the vendor, so passing under one reading proves
  // nothing about the other.
  for (const boundaryMode of ['inclusive', 'exclusive'] as const) {
    it(`passes every check the kit can run — publishedAfter treated as ${boundaryMode}`, async () => {
      const report = await runSocialAdapterConformance(harness({}, { boundaryMode }));
      expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.platformId).toBe('youtube');
    });
  }

  it('passes the kit even when the provider serves oldest-first', async () => {
    // The vendor page specifies no ordering for activities.list, so the adapter
    // must derive no control flow from it. If it ever gains a "stop at the first
    // item older than the watermark" early exit, this run collapses the gap to
    // nothing and the kit fails here.
    const report = await runSocialAdapterConformance(harness({}, { serveOrder: 'oldest-first' }));
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
  });

  it('runs the cursor-unusable check rather than skipping it', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.checksRun).toContain('cursor-unusable-falls-back-to-backfill');
    expect(report.checksSkipped.map((s) => s.check)).not.toContain('cursor-unusable-falls-back-to-backfill');
  });

  it('walks more than one page to close the kit’s gap', async () => {
    // D-013 is only satisfied if the walk actually happens. Asserting the
    // REQUEST COUNT rather than the constant means raising PAGE_SIZE later fails
    // here, instead of silently hollowing out the gap check.
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

/* -------------------------------------------------------------------------- */
/* The cursor: a watermark plus the ids sitting exactly on it                  */
/* -------------------------------------------------------------------------- */

describe('the cursor does not depend on publishedAfter being inclusive or exclusive', () => {
  for (const boundaryMode of ['inclusive', 'exclusive'] as const) {
    it(`emits nothing on an unchanged feed — ${boundaryMode}`, async () => {
      const world = makeWorld({ boundaryMode });
      const adapter = newAdapter(world);
      publishActivities(world, 3);

      const first = await drain(adapter, null);
      expect(first.events).toHaveLength(3);

      const second = await drain(adapter, first.result.cursor);
      expect(second.events).toHaveLength(0);
      expect(second.result.path).toBe('live-only');
    });
  }

  it('stores the provider’s own timestamp spelling verbatim', async () => {
    // The stored value is what every boundary comparison is made against, so a
    // round-trip through Date#toISOString would rewrite the provider's own
    // precision.
    const world = makeWorld();
    const adapter = newAdapter(world);
    addActivity(world, '2026-08-23T12:00:00Z'); // no milliseconds, as a provider may serve it

    const first = await drain(adapter, null);
    expect((first.result.cursor as YouTubeActivitiesCursor).publishedAfter).toBe('2026-08-23T12:00:00Z');
  });

  it('queries a floor one millisecond BEFORE the watermark, never the watermark itself', async () => {
    // The margin points backwards on purpose. Sending the watermark itself
    // leaves the boundary instant outside the query under the exclusive
    // reading, which is exactly how a same-instant sibling is lost.
    const world = makeWorld();
    const adapter = newAdapter(world);
    addActivity(world, '2026-08-23T12:00:00Z');

    const first = await drain(adapter, null);
    world.requests.length = 0;
    await drain(adapter, first.result.cursor);

    expect(world.requests[0]!.publishedAfter).toBe('2026-08-23T11:59:59.999Z');
  });

  it('derives the floor from the watermark, and nothing from a cold start', () => {
    expect(youtubeQueryFloor({ publishedAfter: '2026-08-23T12:00:00.000Z', boundaryIds: [] })).toBe(
      '2026-08-23T11:59:59.999Z',
    );
    expect(youtubeQueryFloor(null)).toBeNull();
  });

  it('treats two spellings of one instant as the same instant', async () => {
    // `...T12:00:00Z` and `...T12:00:00.000Z` are not string-equal but are the
    // same moment. A string comparison in the boundary filter would let a
    // re-spelled boundary item through and emit it a second time.
    const world = makeWorld();
    const adapter = newAdapter(world);
    const id = addActivity(world, '2026-08-23T12:00:00Z');

    const first = await drain(adapter, null);
    expect(first.events.map((e) => e.externalId)).toEqual([id]);

    // The provider re-serves the same activity with a fuller timestamp.
    world.activities[0]!.publishedAt = '2026-08-23T12:00:00.000Z';
    const second = await drain(adapter, first.result.cursor);
    expect(second.events).toHaveLength(0);
  });

  it('carries boundaryIds forward when the watermark does not move', async () => {
    // Recomputing them on a pass that read nothing new would re-admit exactly
    // the items they exist to suppress — the inclusive-reading bug, one level
    // down. Three consecutive no-op passes would surface it.
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 2);

    let cursor: unknown = null;
    const first = await drain(adapter, cursor);
    cursor = first.result.cursor;
    for (let pass = 0; pass < 3; pass += 1) {
      const next = await drain(adapter, cursor);
      expect(next.events, `pass ${pass} re-emitted the boundary`).toHaveLength(0);
      cursor = next.result.cursor;
    }
    expect((cursor as YouTubeActivitiesCursor).boundaryIds.length).toBeGreaterThan(0);
  });

  it('resets boundaryIds once the watermark advances', async () => {
    // The set is bounded by how many activities share ONE instant, not by the
    // size of the gap. If it accumulated, a busy channel would grow the stored
    // cursor without limit.
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 2);
    const first = await drain(adapter, null);
    const firstCursor = first.result.cursor as YouTubeActivitiesCursor;

    publishActivities(world, 2);
    const second = await drain(adapter, firstCursor);
    const secondCursor = second.result.cursor as YouTubeActivitiesCursor;

    expect(secondCursor.publishedAfter).not.toBe(firstCursor.publishedAfter);
    expect(secondCursor.boundaryIds).toHaveLength(1);
    for (const id of firstCursor.boundaryIds) expect(secondCursor.boundaryIds).not.toContain(id);
  });

  it('emits a sibling published at the SAME instant as the stored watermark', async () => {
    // THE CASE THE REJECTED `watermark + 1ms` DESIGN LOSES, and it loses it
    // under BOTH readings of publishedAfter — so this is not an argument about
    // the ambiguity, it is an argument about the ambiguity's popular workaround.
    // Two uploads land in the same second; the first pass sees only one.
    for (const boundaryMode of ['inclusive', 'exclusive'] as const) {
      const world = makeWorld({ boundaryMode });
      const adapter = newAdapter(world);
      const first = addActivity(world, '2026-08-23T12:00:00.000Z');

      const pass1 = await drain(adapter, null);
      expect(pass1.events.map((e) => e.externalId)).toEqual([first]);

      const sibling = addActivity(world, '2026-08-23T12:00:00.000Z');
      const pass2 = await drain(adapter, pass1.result.cursor);
      expect(pass2.events.map((e) => e.externalId), `boundaryMode=${boundaryMode}`).toEqual([sibling]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Paths                                                                       */
/* -------------------------------------------------------------------------- */

describe('the reported path is a fact, not a guess', () => {
  it('reports cold-start only when there is genuinely no stored cursor', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 2);
    const { result } = await drain(adapter, null);
    expect(result.path).toBe('cold-start');
    expect(result.backfillReason).toBeUndefined();
  });

  it('reports cursor-replay when the provider closed the gap', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 2);
    const first = await drain(adapter, null);
    publishActivities(world, 2);
    const second = await drain(adapter, first.result.cursor);
    expect(second.result.path).toBe('cursor-replay');
    expect(second.events).toHaveLength(2);
  });

  it('reports backfill/cursor-rejected when the provider refuses the watermark', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 2);
    const first = await drain(adapter, null);
    const missed = publishActivities(world, 3);

    world.rejectCursor = true;
    const second = await drain(adapter, first.result.cursor);

    expect(second.result.path).toBe('backfill');
    expect(second.result.backfillReason).toBe('cursor-rejected');
    expect(second.events.map((e) => e.externalId).sort()).toEqual([...missed].sort());
  });

  it('never reports cursor-expired, because this stream has no retention window', async () => {
    // 'cursor-expired' means the provider aged the cursor out. activities.list
    // documents no retention boundary for `publishedAfter`, so emitting that
    // reason would send whoever reads it hunting for a window that does not
    // exist.
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 2);
    const first = await drain(adapter, null);
    world.rejectCursor = true;
    const second = await drain(adapter, first.result.cursor);
    expect(second.result.backfillReason).not.toBe('cursor-expired');
  });

  it('treats an unreadable stored cursor as a backfill, never as a cold start', async () => {
    // A cursor this adapter version can no longer parse is not "first connect".
    // Reporting cold-start would hide that a gap of unknown size was closed by a
    // bounded window rather than by the provider.
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 3);
    const { result, events } = await drain(adapter, { legacyShape: 'from-an-older-adapter' });
    expect(result.path).toBe('backfill');
    expect(result.backfillReason).toBe('cursor-rejected');
    expect(events).toHaveLength(3); // the window is still read, not skipped
  });

  it('recovers the gap on backfill rather than restarting from live', async () => {
    // The silent-loss failure D-005 exists for. It is invisible from the
    // outside because it emits zero events and looks like a quiet channel.
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 2);
    const first = await drain(adapter, null);
    const missed = publishActivities(world, 4);
    world.rejectCursor = true;

    const second = await drain(adapter, first.result.cursor);
    for (const id of missed) expect(second.events.map((e) => e.externalId)).toContain(id);
  });
});

/* -------------------------------------------------------------------------- */
/* Paging                                                                      */
/* -------------------------------------------------------------------------- */

describe('pageToken is a page within one query, never a resume point (D-021)', () => {
  it('never persists a pageToken into the cursor', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 5); // > PAGE_SIZE, so the walk pages

    const { result } = await drain(adapter, null);
    expect(world.requests.some((r) => r.pageToken !== null)).toBe(true);
    expect(JSON.stringify(result.cursor)).not.toContain('pageToken');
    expect(isYouTubeActivitiesCursor(result.cursor)).toBe(true);
  });

  it('starts every reconcile at the first page', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishActivities(world, 5);
    const first = await drain(adapter, null);

    world.requests.length = 0;
    publishActivities(world, 5);
    await drain(adapter, first.result.cursor);
    expect(world.requests[0]!.pageToken).toBeNull();
  });

  it('stops at maxPages rather than walking a feed forever', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world, { maxPages: 2 });
    publishActivities(world, 50);
    const { events } = await drain(adapter, null);
    expect(world.requests).toHaveLength(2);
    expect(events).toHaveLength(PAGE_SIZE * 2);
  });
});

/* -------------------------------------------------------------------------- */
/* maxResults                                                                  */
/* -------------------------------------------------------------------------- */

describe('maxResults mirrors the documented 0–50 range', () => {
  it('clamps to [1, 50] and defaults to the ceiling', () => {
    expect(clampYouTubeMaxResults(undefined)).toBe(YOUTUBE_ACTIVITIES_PAGE_SIZE_DEFAULT);
    expect(clampYouTubeMaxResults(null)).toBe(YOUTUBE_ACTIVITIES_PAGE_SIZE_DEFAULT);
    expect(clampYouTubeMaxResults(500)).toBe(YOUTUBE_MAX_RESULTS_CEILING);
    expect(clampYouTubeMaxResults(50)).toBe(50);
    expect(clampYouTubeMaxResults(7)).toBe(7);
    expect(clampYouTubeMaxResults(Number.NaN)).toBe(YOUTUBE_ACTIVITIES_PAGE_SIZE_DEFAULT);
  });

  it('refuses to poll with the API-legal 0, which would emit nothing forever', () => {
    // 0 is an accepted value that returns no items. Passing it through would
    // cost a quota unit per poll and never emit — a hang presenting as "the
    // integration is quiet", the most expensive shape of bug in this substrate.
    expect(clampYouTubeMaxResults(0)).toBe(1);
    expect(clampYouTubeMaxResults(-10)).toBe(1);
  });

  it('defaults to the ceiling rather than the API default of 5, because cost is per CALL', async () => {
    // D-020: activities.list costs 1 unit per call regardless of item count, so
    // a smaller page size is a pure quota multiplier.
    expect(YOUTUBE_ACTIVITIES_PAGE_SIZE_DEFAULT).toBe(50);
    const world = makeWorld();
    const adapter = new YouTubeActivitiesAdapter({ client: fakeClient(world), sleep: async () => {} });
    publishActivities(world, 10);
    await drain(adapter, null);
    expect(world.requests).toHaveLength(1);
    expect(world.requests[0]!.maxResults).toBe(50);
  });
});

/* -------------------------------------------------------------------------- */
/* Rate limiting                                                               */
/* -------------------------------------------------------------------------- */

describe('rate limiting — retryAfter is a DURATION, not a timestamp', () => {
  it('waits the stated duration', () => {
    expect(youtubeRetryDelayMs(new YouTubeRateLimited('429', 5), 0, 4)).toBe(5000);
  });

  it('caps the wait so a large or bogus value cannot hang the adapter', () => {
    expect(youtubeRetryDelayMs(new YouTubeRateLimited('429', 99_999), 0, 4)).toBe(YOUTUBE_MAX_RATE_LIMIT_WAIT_MS);
  });

  it('does not read the duration as an epoch', () => {
    const asEpoch = Math.floor(Date.now() / 1000);
    const delay = youtubeRetryDelayMs(new YouTubeRateLimited('429', asEpoch), 0, 4);
    expect(delay).toBe(YOUTUBE_MAX_RATE_LIMIT_WAIT_MS);
    expect(delay).toBeLessThan(60 * 60 * 1000);
  });

  it('backs off exponentially when no duration is supplied', () => {
    expect(youtubeRetryDelayMs(new YouTubeRateLimited('429', null), 0, 4)).toBe(1000);
    expect(youtubeRetryDelayMs(new YouTubeRateLimited('429', null), 2, 4)).toBe(4000);
  });

  it('gives up at the retry ceiling instead of retrying forever', () => {
    expect(youtubeRetryDelayMs(new YouTubeRateLimited('429', 1), 4, 4)).toBeNull();
  });

  it('never retries a cursor rejection, which can never succeed', () => {
    // Retrying a value the provider will refuse every time burns the retry
    // schedule against a wall and delays the backfill that would actually work.
    expect(youtubeRetryDelayMs(new YouTubeCursorRejected('400', 'x'), 0, 4)).toBeNull();
  });

  it('never retries an arbitrary error', () => {
    expect(youtubeRetryDelayMs(new Error('boom'), 0, 4)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

describe('normalization', () => {
  const sample: YouTubeRawActivity = {
    id: 'act001',
    publishedAt: '2026-08-23T12:00:00.000Z',
    channelId: 'UC_papercusp',
    channelTitle: 'Papercusp',
    title: 'A new video',
    description: 'about adapters',
    type: 'upload',
    videoId: 'vid001',
  };

  it('derives the event name from snippet.type, so a binding can target uploads alone', () => {
    expect(youtubeActivityEventName(sample)).toBe('upload');
    expect(youtubeActivityEventName({ type: 'subscription' })).toBe('subscription');
    expect(youtubeActivityEventName({ type: 'LIKE' })).toBe('like');
  });

  it('falls back to a generic event name rather than an empty key', () => {
    expect(youtubeActivityEventName({ type: null })).toBe('activity');
    expect(youtubeActivityEventName({ type: '  ' })).toBe('activity');
  });

  it('builds a dedupe key from provider facts only', () => {
    expect(youtubeActivityDedupeKey(sample)).toBe('act001@2026-08-23T12:00:00.000Z');
    // Stable across calls — no wall-clock, no randomness.
    expect(youtubeActivityDedupeKey(sample)).toBe(youtubeActivityDedupeKey(sample));
  });

  it('satisfies the canonical social-post schema', () => {
    const event = normalizeYouTubeActivity(sample);
    expect(event.externalId).toBe('act001');
    expect(event.occurredAt).toBe(sample.publishedAt);
    expect(event.payload.id).toBe('act001');
    expect(event.payload.text).toBe('A new video');
    expect(event.payload.url).toBe('https://www.youtube.com/watch?v=vid001');
    expect(event.payload.videoId).toBe('vid001');
  });

  it('still produces a valid payload for an activity carrying no title', () => {
    // A `like` or `subscription` activity can legitimately carry neither title
    // nor description. Failing datatype validation for a well-formed provider
    // response would drop the event entirely rather than deliver a thin one.
    const event = normalizeYouTubeActivity({
      id: 'act002',
      publishedAt: '2026-08-23T12:00:01.000Z',
      channelId: 'UC_papercusp',
      type: 'subscription',
    });
    expect(typeof event.payload.text).toBe('string');
    expect(event.payload.id).toBe('act002');
    expect(event.payload.url).toBeUndefined();
  });

  it('omits the watch URL when there is no videoId to build it from', () => {
    const event = normalizeYouTubeActivity({ ...sample, videoId: null });
    expect(event.payload.url).toBeUndefined();
  });
});

describe('instant parsing', () => {
  it('returns null for values that cannot be compared', () => {
    expect(youtubeInstantMs('not-a-date')).toBeNull();
    expect(youtubeInstantMs(null)).toBeNull();
    expect(youtubeInstantMs(undefined)).toBeNull();
  });

  it('equates two spellings of one instant', () => {
    expect(youtubeInstantMs('2026-08-23T12:00:00Z')).toBe(youtubeInstantMs('2026-08-23T12:00:00.000Z'));
  });
});

describe('the cursor type guard', () => {
  it('accepts a well-formed cursor', () => {
    expect(isYouTubeActivitiesCursor({ publishedAfter: '2026-08-23T12:00:00Z', boundaryIds: [] })).toBe(true);
  });

  it('refuses shapes that would silently behave as a cold start', () => {
    expect(isYouTubeActivitiesCursor(null)).toBe(false);
    expect(isYouTubeActivitiesCursor({ publishedAfter: 'not-a-date', boundaryIds: [] })).toBe(false);
    expect(isYouTubeActivitiesCursor({ publishedAfter: '2026-08-23T12:00:00Z' })).toBe(false);
    expect(isYouTubeActivitiesCursor({ publishedAfter: '2026-08-23T12:00:00Z', boundaryIds: [1] })).toBe(false);
    expect(isYouTubeActivitiesCursor({ boundaryIds: [] })).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* An unparseable provider timestamp                                           */
/* -------------------------------------------------------------------------- */

describe('an unparseable provider timestamp', () => {
  it('is emitted rather than dropped', async () => {
    // Losing a real event over a formatting problem is the worse failure. It
    // sorts last and cannot move the cursor.
    const world = makeWorld();
    const adapter = newAdapter(world);
    addActivity(world, '2026-08-23T12:00:00.000Z');
    const malformed = addActivity(world, 'sometime-tuesday');

    const { result, events } = await drain(adapter, null);
    expect(events.map((e) => e.externalId)).toContain(malformed);
    expect((result.cursor as YouTubeActivitiesCursor).publishedAfter).toBe('2026-08-23T12:00:00.000Z');
  });
});

/* -------------------------------------------------------------------------- */
/* Controls — the kit must FAIL a broken adapter                               */
/* -------------------------------------------------------------------------- */

describe('controls — the kit must FAIL a broken adapter', () => {
  it('catches an adapter that reads only the first page (the D-013 control)', async () => {
    const checks = await failuresFor((world) => newAdapter(world, { maxPages: 1 }));
    expect(checks).toContain('offline-gap-closed-exactly-once');
  });

  it('D-013 CALIBRATION: the same single-page adapter PASSES the gap check at page size 3', async () => {
    // The control on the control. Without it, "PAGE_SIZE must be < 3" is a claim
    // about the kit that nobody has watched be true — and the cost of being
    // wrong is not a failing test, it is a check that silently proves nothing
    // for every adapter that follows.
    const base = harness();
    const report = await runSocialAdapterConformance({
      ...base,
      async create() {
        const world = makeWorld();
        return { adapter: newAdapter(world, { pageSize: 3, maxPages: 1 }), world };
      },
    });
    expect(report.failures.map((f) => f.check)).not.toContain('offline-gap-closed-exactly-once');
  });

  it('REJECTED DESIGN: advancing the watermark by a millisecond loses same-instant siblings', async () => {
    // The obvious fix for an inclusive `publishedAfter` — store newest + 1ms —
    // is why this adapter's cursor carries boundaryIds instead. It loses a
    // sibling published in the same instant under BOTH readings, and it does so
    // SILENTLY: zero events, indistinguishable from a quiet channel.
    class PlusOneMillisecondAdapter extends YouTubeActivitiesAdapter {
      override async reconcile(ctx: Ctx) {
        const result = await super.reconcile(ctx);
        const cursor = result.cursor as YouTubeActivitiesCursor | null;
        if (!cursor) return result;
        const bumped = new Date(Date.parse(cursor.publishedAfter) + 1).toISOString();
        return { ...result, cursor: { publishedAfter: bumped, boundaryIds: [] } };
      }
    }

    for (const boundaryMode of ['inclusive', 'exclusive'] as const) {
      const world = makeWorld({ boundaryMode });
      const adapter = new PlusOneMillisecondAdapter({
        client: fakeClient(world),
        pageSize: PAGE_SIZE,
        sleep: async () => {},
      });
      addActivity(world, '2026-08-23T12:00:00.000Z');
      const first = await drain(adapter, null);
      expect(first.events).toHaveLength(1);

      addActivity(world, '2026-08-23T12:00:00.000Z');
      const second = await drain(adapter, first.result.cursor);

      // The sibling is gone, and the adapter reports a clean 'live-only'.
      expect(second.events, `boundaryMode=${boundaryMode}`).toHaveLength(0);
      expect(second.result.path).toBe('live-only');
    }
  });

  it('REJECTED DESIGN: a bare watermark with no boundaryIds re-emits forever when inclusive', async () => {
    // The other half of the same fork. Under the inclusive reading this
    // re-fires every binding on every poll.
    class BareWatermarkAdapter extends YouTubeActivitiesAdapter {
      override async reconcile(ctx: Ctx) {
        const result = await super.reconcile(ctx);
        const cursor = result.cursor as YouTubeActivitiesCursor | null;
        if (!cursor) return result;
        return { ...result, cursor: { publishedAfter: cursor.publishedAfter, boundaryIds: [] } };
      }
    }

    const checks = await failuresFor(
      (world) =>
        new BareWatermarkAdapter({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('no-op-reconcile-emits-nothing');
  });

  it('catches an adapter that re-reads the whole feed every pass', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeActivitiesAdapter {
          override async reconcile(ctx: Ctx) {
            return super.reconcile({ ...ctx, cursor: null });
          }
        })({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('no-op-reconcile-emits-nothing');
  });

  it('catches an adapter that reports live-only when the cursor was refused', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeActivitiesAdapter {
          override async reconcile(ctx: Ctx) {
            const result = await super.reconcile(ctx);
            if (result.path === 'backfill') {
              return { ...result, path: 'live-only' as const, backfillReason: undefined };
            }
            return result;
          }
        })({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('cursor-unusable-falls-back-to-backfill');
  });

  it('catches a backfill that does not state its reason', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeActivitiesAdapter {
          override async reconcile(ctx: Ctx) {
            const result = await super.reconcile(ctx);
            if (result.path === 'backfill') return { ...result, backfillReason: undefined };
            return result;
          }
        })({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('cursor-unusable-falls-back-to-backfill');
  });

  it('catches a dedupe key that is not stable across a replay', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeActivitiesAdapter {
          override async reconcile(ctx: Ctx) {
            return super.reconcile({
              ...ctx,
              emit: (event) => ctx.emit({ ...event, dedupeKey: `${event.dedupeKey}:${Math.random()}` }),
            });
          }
        })({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('dedupe-keys-unique-and-stable');
  });

  it('catches an adapter that leaks the credential into the payload', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeActivitiesAdapter {
          override async reconcile(ctx: Ctx) {
            return super.reconcile({
              ...ctx,
              emit: (event) => ctx.emit({ ...event, payload: { ...event.payload, bearer: NEVER_EMIT_MARKER } }),
            });
          }
        })({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('credential-never-emitted');
  });

  it('catches an adapter whose emitted count disagrees with what it emitted', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeActivitiesAdapter {
          override async reconcile(ctx: Ctx) {
            const result = await super.reconcile(ctx);
            return { ...result, emitted: result.emitted + 1 };
          }
        })({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('cold-start');
  });

  it('catches an adapter that propagates a rate limit instead of absorbing it', async () => {
    const checks = await failuresFor((world) => newAdapter(world, { maxRetries: 0 }));
    expect(checks).toContain('rate-limit-is-absorbed');
  });
});
