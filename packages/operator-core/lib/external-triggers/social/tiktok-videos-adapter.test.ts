/**
 * Tests for the TikTok video read adapter — P-022.
 *
 * THE CENTREPIECE IS THE CURSOR-INVERSION CONTROL. TikTok's `cursor` means
 * "videos posted BEFORE this timestamp" against a descending list, so the
 * natural implementation — persist it, send it back — walks into the past and
 * emits nothing new, forever, while looking perfectly healthy. A test that only
 * checked "new items are emitted" would pass against a correct adapter and also
 * against several broken ones, so the fake world here RECORDS EVERY REQUEST and
 * the suite asserts what was actually sent to TikTok, not merely what came back.
 *
 * The second thing under test is the SECONDS/MILLISECONDS boundary. `cursor` is
 * milliseconds and `create_time` is seconds; a 1000x slip does not throw, it
 * just decides that everything or nothing is new. The unit helpers are tested
 * directly and the boundary cases are exercised through the adapter.
 */
import { describe, expect, it } from 'vitest';
import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import type { SocialNormalizedEvent } from './adapter-contract';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import {
  isTikTokWatermarkCursor,
  tiktokAdvanceWatermark,
  tiktokCursorMsToSeconds,
  tiktokErrorFor,
  tiktokIsNewAgainstWatermark,
  tiktokSecondsToCursorMs,
  tiktokSecondsToInstant,
  tiktokWatermarkSeconds,
  TikTokAuthRejected,
  TikTokRateLimited,
  TIKTOK_VIDEO_LIST_MAX_COUNT,
  type TikTokWatermarkCursor,
} from './tiktok-common';
import {
  TikTokVideosAdapter,
  normalizeTikTokVideo,
  tiktokVideoDedupeKey,
  tiktokVideoText,
  tiktokVideoUrl,
  type TikTokRawVideo,
  type TikTokVideoListPage,
  type TikTokVideoListRequest,
  type TikTokVideosClient,
} from './tiktok-videos-adapter';

const SECRET = 'act.tiktok-access-token-must-never-be-emitted';

/** Backoff is proven by the retry COUNT, not by spending real seconds. */
const NO_SLEEP = async (): Promise<void> => {};

/* -------------------------------------------------------------------------- */
/* Fake world                                                                 */
/* -------------------------------------------------------------------------- */

interface FakeWorld {
  /** Videos NEWEST FIRST, as TikTok serves them. */
  videos: TikTokRawVideo[];
  /** Every request the adapter made, in order. The inversion control reads this. */
  requests: TikTokVideoListRequest[];
  /** When set, the next call returns this error code instead of data. */
  failNextWith: { code: string; message: string } | null;
  /** Serve `has_more: true` even on the last page, to model a lying vendor. */
  alwaysMoreThanServed: boolean;
  nextId: number;
  nextCreateTime: number;
}

const BASE_TIME_SECONDS = 1_700_000_000;

function makeWorld(overrides: Partial<FakeWorld> = {}): FakeWorld {
  return {
    videos: [],
    requests: [],
    failNextWith: null,
    alwaysMoreThanServed: false,
    nextId: 1,
    nextCreateTime: BASE_TIME_SECONDS,
    ...overrides,
  };
}

/** Add `count` videos, each one second newer than the last. Returns ids oldest-first. */
function publish(world: FakeWorld, count: number, opts: { sameSecond?: boolean } = {}): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `v${world.nextId}`;
    world.nextId += 1;
    const createTime = world.nextCreateTime;
    if (!opts.sameSecond) world.nextCreateTime += 1;
    // Newest first: unshift.
    world.videos.unshift({
      id,
      create_time: createTime,
      video_description: `caption for ${id}`,
      share_url: `https://www.tiktok.com/@creator/video/${id}`,
      cover_image_url: `https://p16.tiktokcdn.com/${id}.jpeg`,
      embed_link: `https://www.tiktok.com/embed/${id}`,
      duration: 30,
      comment_count: 4,
    });
    ids.push(id);
  }
  if (opts.sameSecond) world.nextCreateTime += 1;
  return ids;
}

function makeClient(world: FakeWorld): TikTokVideosClient {
  return {
    async listVideos(request: TikTokVideoListRequest): Promise<TikTokVideoListPage> {
      world.requests.push({ ...request });

      if (world.failNextWith) {
        const failure = world.failNextWith;
        world.failNextWith = null;
        return { errorCode: failure.code, errorMessage: failure.message, logId: 'log-1' };
      }

      // Model the vendor honestly: `cursor` selects videos posted STRICTLY
      // BEFORE that instant, and the list is create_time descending.
      const sorted = [...world.videos].sort(
        (a, b) => Number(b.create_time ?? 0) - Number(a.create_time ?? 0),
      );
      const eligible =
        request.cursor === null
          ? sorted
          : sorted.filter((v) => Number(v.create_time ?? 0) * 1000 < (request.cursor as number));

      const page = eligible.slice(0, request.maxCount);
      const remaining = eligible.length > page.length;
      const last = page[page.length - 1];
      return {
        videos: page,
        cursor: last ? Number(last.create_time ?? 0) * 1000 : 0,
        has_more: world.alwaysMoreThanServed ? true : remaining,
        errorCode: 'ok',
        errorMessage: '',
      };
    },
  };
}

async function drain(
  adapter: TikTokVideosAdapter,
  cursor: unknown | null,
): Promise<{ result: Awaited<ReturnType<TikTokVideosAdapter['reconcile']>>; events: SocialNormalizedEvent[] }> {
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
/* The cursor-inversion control — the reason this file exists                 */
/* -------------------------------------------------------------------------- */

describe('TikTok cursor semantics (the inversion trap)', () => {
  it('NEVER sends the stored watermark to TikTok as a cursor', async () => {
    const world = makeWorld();
    publish(world, 5);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world) });

    const first = await drain(adapter, null);
    expect(first.events).toHaveLength(5);

    // Two more arrive after we recorded the watermark.
    publish(world, 2);
    world.requests.length = 0;

    const second = await drain(adapter, first.result.cursor);

    // THE ASSERTION THAT MATTERS. The first call of every pass must carry NO
    // cursor. Sending the watermark here would ask TikTok for everything older
    // than it — i.e. only things we have already seen.
    expect(world.requests[0]?.cursor).toBeNull();
    expect(second.events.map((e) => e.externalId)).toEqual(['v7', 'v6']);
  });

  it('emits the new items rather than walking into the past (the whole failure mode)', async () => {
    const world = makeWorld();
    publish(world, 3);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world) });
    const first = await drain(adapter, null);

    publish(world, 4);
    const second = await drain(adapter, first.result.cursor);

    // A broken adapter that persisted TikTok's cursor and replayed it would
    // emit ZERO here while reporting healthy paging.
    expect(second.result.emitted).toBe(4);
    expect(second.events.every((e) => Number(e.payload.commentCount) === 4)).toBe(true);
  });

  it('uses TikTok\'s cursor for WITHIN-pass paging, decreasing monotonically', async () => {
    const world = makeWorld();
    publish(world, 25);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world), pageSize: 10 });

    const { events } = await drain(adapter, null);
    expect(events).toHaveLength(25);

    // First call no cursor; every later call carries one, strictly decreasing —
    // that is what "paging backward through one descending scan" looks like.
    expect(world.requests[0].cursor).toBeNull();
    const later = world.requests.slice(1).map((r) => r.cursor as number);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((c) => typeof c === 'number')).toBe(true);
    for (let i = 1; i < later.length; i += 1) expect(later[i]).toBeLessThan(later[i - 1]);
  });

  it('stops walking once it reaches the watermark instead of paging all history', async () => {
    const world = makeWorld();
    publish(world, 60);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world), pageSize: 10 });
    const first = await drain(adapter, null);
    expect(first.events).toHaveLength(60);

    publish(world, 3);
    world.requests.length = 0;
    const second = await drain(adapter, first.result.cursor);

    expect(second.events).toHaveLength(3);
    // One page was enough to prove the gap closed; it must not have walked the
    // remaining 60 videos to find that out.
    expect(world.requests).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Same-second boundary                                                       */
/* -------------------------------------------------------------------------- */

describe('same-second boundary', () => {
  it('does not re-emit a video at exactly the watermark second', async () => {
    const world = makeWorld();
    publish(world, 2, { sameSecond: true });
    const adapter = new TikTokVideosAdapter({ client: makeClient(world) });

    const first = await drain(adapter, null);
    expect(first.events).toHaveLength(2);

    const second = await drain(adapter, first.result.cursor);
    expect(second.events).toHaveLength(0);
  });

  it('emits a NEW sibling posted in the same second as the watermark', async () => {
    const world = makeWorld();
    publish(world, 1);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world) });
    const first = await drain(adapter, null);
    const mark = first.result.cursor as TikTokWatermarkCursor;

    // A second video sharing the watermark's exact second. Terminating on `<=`
    // instead of `<` would drop this one.
    world.videos.unshift({
      id: 'sibling',
      create_time: Math.floor(Date.parse(mark.watermark) / 1000),
      video_description: 'same second',
      share_url: 'https://www.tiktok.com/@creator/video/sibling',
    });

    const second = await drain(adapter, first.result.cursor);
    expect(second.events.map((e) => e.externalId)).toEqual(['sibling']);

    // And it is now recorded as a boundary id, so a third pass is quiet.
    const third = await drain(adapter, second.result.cursor);
    expect(third.events).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Path + loss reporting                                                      */
/* -------------------------------------------------------------------------- */

describe('path and loss declaration', () => {
  it('declares cold-start with no stored cursor, and backfill afterwards', async () => {
    const world = makeWorld();
    publish(world, 2);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world) });

    const first = await drain(adapter, null);
    expect(first.result.path).toBe('cold-start');
    expect(first.result.backfillReason).toBeUndefined();

    const second = await drain(adapter, first.result.cursor);
    expect(second.result.path).toBe('backfill');
    expect(second.result.backfillReason).toBe('no-replay-supported');
  });

  it('reports cursor-rejected — distinctly — when the stored cursor is unreadable', async () => {
    const world = makeWorld();
    publish(world, 1);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world) });

    const { result } = await drain(adapter, { nonsense: true });
    expect(result.path).toBe('backfill');
    // Distinct from the routine steady state, so an alert on it is meaningful.
    expect(result.backfillReason).toBe('cursor-rejected');
  });

  it('reports lossRisk when the page bound is hit without reaching the watermark', async () => {
    const world = makeWorld();
    publish(world, 5);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world), pageSize: 2, maxPages: 2 });
    const first = await drain(adapter, null);

    // 40 new videos, but the bound only walks 4.
    publish(world, 40);
    const second = await drain(adapter, first.result.cursor);

    expect(second.result.lossRisk).toBeDefined();
    expect(second.result.lossRisk?.kind).toBe('capped-window-overflow');
    expect(second.result.lossRisk?.occurrences).toBeGreaterThan(0);
    expect(second.result.lossRisk?.detail).toContain('watermark');
  });

  it('does NOT report lossRisk on cold start, however bounded the read', async () => {
    const world = makeWorld();
    publish(world, 40);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world), pageSize: 2, maxPages: 2 });

    const { result } = await drain(adapter, null);
    // A bounded first read is intended behaviour, not loss.
    expect(result.lossRisk).toBeUndefined();
    expect(result.path).toBe('cold-start');
  });

  it('does not report loss when the gap closes exactly at the bound', async () => {
    const world = makeWorld();
    publish(world, 2);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world), pageSize: 5, maxPages: 3 });
    const first = await drain(adapter, null);

    publish(world, 3);
    const second = await drain(adapter, first.result.cursor);
    expect(second.result.lossRisk).toBeUndefined();
    expect(second.events).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Vendor error handling                                                      */
/* -------------------------------------------------------------------------- */

describe('vendor errors reported in the body', () => {
  it('ABSORBS a transient rate limit reported in the body and loses no events', async () => {
    const world = makeWorld({ failNextWith: { code: 'rate_limit_exceeded', message: 'slow down' } });
    const ids = publish(world, 3);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world), sleep: NO_SLEEP });

    const { events } = await drain(adapter, null);
    // A 200 response carrying error.code must be caught and retried, not read
    // as success and not propagated.
    expect(events.map((e) => e.externalId).sort()).toEqual([...ids].sort());
  });

  it('gives up and throws once the retry budget is spent', async () => {
    const world = makeWorld();
    publish(world, 1);
    const client = makeClient(world);
    const alwaysLimited: TikTokVideosClient = {
      async listVideos() {
        return { errorCode: 'rate_limit_exceeded', errorMessage: 'still limited' };
      },
    };
    void client;
    const adapter = new TikTokVideosAdapter({
      client: alwaysLimited,
      maxRetries: 2,
      sleep: NO_SLEEP,
    });

    await expect(drain(adapter, null)).rejects.toBeInstanceOf(TikTokRateLimited);
  });

  it('does NOT retry an auth rejection — it will fail identically forever', async () => {
    const world = makeWorld({
      failNextWith: { code: 'scope_not_authorized', message: 'video.list not granted' },
    });
    publish(world, 1);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world), sleep: NO_SLEEP });

    await expect(drain(adapter, null)).rejects.toMatchObject({
      name: 'TikTokAuthRejected',
      code: 'scope_not_authorized',
    });
    // Exactly one call: a retry here would only delay the operator learning the
    // account is missing the scope.
    expect(world.requests).toHaveLength(1);
  });

  it('stops rather than looping when the vendor claims more but gives no cursor', async () => {
    const world = makeWorld({ alwaysMoreThanServed: true });
    publish(world, 3);
    const client = makeClient(world);
    const lying: TikTokVideosClient = {
      async listVideos(request) {
        const page = await client.listVideos(request);
        return { ...page, cursor: 'not-a-number', has_more: true };
      },
    };
    const adapter = new TikTokVideosAdapter({ client: lying, pageSize: 2, maxPages: 10 });

    const { events } = await drain(adapter, null);
    // One page served, then it stopped for want of a usable cursor.
    expect(world.requests).toHaveLength(1);
    expect(events).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Unit boundary + normalization                                              */
/* -------------------------------------------------------------------------- */

describe('the seconds/milliseconds boundary', () => {
  it('converts create_time seconds to cursor milliseconds', () => {
    expect(tiktokSecondsToCursorMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(tiktokCursorMsToSeconds(1_700_000_000_000)).toBe(1_700_000_000);
  });

  it('returns null rather than NaN for unusable input', () => {
    // NaN would lose every comparison silently and be classified "not new".
    expect(tiktokSecondsToCursorMs('nope')).toBeNull();
    expect(tiktokSecondsToCursorMs(Number.NaN)).toBeNull();
    expect(tiktokSecondsToCursorMs(-1)).toBeNull();
    expect(tiktokCursorMsToSeconds(undefined)).toBeNull();
  });

  it('emits occurredAt as an ISO instant derived from SECONDS', () => {
    const event = normalizeTikTokVideo({ id: 'v1', create_time: 1_700_000_000 }, 'v1');
    // Reading create_time as milliseconds would land in 1970.
    expect(event.occurredAt).toBe('2023-11-14T22:13:20.000Z');
    expect(new Date(event.occurredAt as string).getUTCFullYear()).toBe(2023);
  });
});

describe('normalization', () => {
  it('prefers video_description over title for text', () => {
    expect(tiktokVideoText({ video_description: 'caption', title: 'the title' })).toBe('caption');
    expect(tiktokVideoText({ title: 'the title' })).toBe('the title');
  });

  it('marks textAbsent for a caption-less video rather than failing the schema', () => {
    const event = normalizeTikTokVideo({ id: 'v1', create_time: BASE_TIME_SECONDS }, 'v1');
    expect(event.payload.text).toBe('');
    expect(event.payload.textAbsent).toBe(true);
  });

  it('prefers the vendor share_url and falls back to a constructed permalink', () => {
    expect(tiktokVideoUrl({ share_url: 'https://www.tiktok.com/@a/video/1' }, '1')).toBe(
      'https://www.tiktok.com/@a/video/1',
    );
    expect(tiktokVideoUrl({}, '1')).toContain('https://www.tiktok.com/');
  });

  it('excludes volatile counters from the dedupe key', () => {
    // A poll that saw a different comment_count must NOT produce a new delivery.
    const a = tiktokVideoDedupeKey('v1', BASE_TIME_SECONDS);
    const b = tiktokVideoDedupeKey('v1', BASE_TIME_SECONDS);
    expect(a).toBe(b);
    expect(a).not.toContain('4');
  });

  it('flags the cover image as expiring (TikTok documents a 6-hour TTL)', () => {
    const event = normalizeTikTokVideo(
      { id: 'v1', create_time: BASE_TIME_SECONDS, cover_image_url: 'https://cdn/x.jpg' },
      'v1',
    );
    const media = (event.payload.media as Array<Record<string, unknown>>)[0];
    expect(media.coverImageUrlExpires).toBe(true);
  });
});

describe('watermark helpers', () => {
  const at = (seconds: number): TikTokWatermarkCursor => ({
    watermark: tiktokSecondsToInstant(seconds),
    boundaryIds: [],
  });

  it('rejects malformed stored cursors', () => {
    expect(isTikTokWatermarkCursor({ watermark: '2023-11-14T22:13:20.000Z', boundaryIds: ['a'] })).toBe(
      true,
    );
    expect(isTikTokWatermarkCursor({ watermark: 1700000000, boundaryIds: [] })).toBe(false);
    expect(isTikTokWatermarkCursor({ watermark: 'not-a-date', boundaryIds: [] })).toBe(false);
    expect(isTikTokWatermarkCursor({ watermark: '2023-11-14T22:13:20.000Z' })).toBe(false);
    expect(isTikTokWatermarkCursor(null)).toBe(false);
  });

  it('stores the mark in the field cursor-freshness recognizes, not raw seconds', () => {
    // Regression pin: a bespoke numeric field made the admin pane report this
    // platform 'never synced' forever while it synced perfectly.
    const mark = tiktokAdvanceWatermark(null, 1_700_000_000, 'a');
    expect(typeof mark?.watermark).toBe('string');
    expect(mark?.watermark).toBe('2023-11-14T22:13:20.000Z');
    expect(tiktokWatermarkSeconds(mark as TikTokWatermarkCursor)).toBe(1_700_000_000);
  });

  it('treats an unparseable create_time as NEW, preferring a duplicate over a silent drop', () => {
    const stored = at(100);
    expect(tiktokIsNewAgainstWatermark(stored, undefined, 'x')).toBe(true);
    expect(tiktokIsNewAgainstWatermark(stored, 99, 'x')).toBe(false);
    expect(tiktokIsNewAgainstWatermark(stored, 101, 'x')).toBe(true);
  });

  it('replaces boundary ids when the mark advances, so the cursor cannot grow forever', () => {
    let mark = tiktokAdvanceWatermark(null, 100, 'a');
    mark = tiktokAdvanceWatermark(mark, 100, 'b');
    expect(mark?.boundaryIds).toEqual(['a', 'b']);
    mark = tiktokAdvanceWatermark(mark, 101, 'c');
    expect(mark).toEqual({ watermark: tiktokSecondsToInstant(101), boundaryIds: ['c'] });
  });

  it('never moves the mark backwards', () => {
    const stored: TikTokWatermarkCursor = { watermark: tiktokSecondsToInstant(100), boundaryIds: ['a'] };
    expect(tiktokAdvanceWatermark(stored, 50, 'old')).toEqual(stored);
  });
});

describe('error mapping', () => {
  it('returns null for ok and maps the documented codes', () => {
    expect(tiktokErrorFor('ok', '')).toBeNull();
    expect(tiktokErrorFor('rate_limit_exceeded', 'x')).toBeInstanceOf(TikTokRateLimited);
    expect(tiktokErrorFor('access_token_invalid', 'x')).toBeInstanceOf(TikTokAuthRejected);
    expect(tiktokErrorFor('invalid_param', 'bad')).toBeInstanceOf(Error);
  });

  it('carries the log_id so a vendor ticket can reference it', () => {
    const error = tiktokErrorFor('invalid_param', 'bad', 'log-42');
    expect(error?.message).toContain('log-42');
  });
});

describe('vendor bounds', () => {
  it('clamps max_count to TikTok\'s documented maximum of 20', async () => {
    const world = makeWorld();
    publish(world, 1);
    const adapter = new TikTokVideosAdapter({ client: makeClient(world), pageSize: 500 });
    await drain(adapter, null);
    expect(world.requests[0].maxCount).toBe(TIKTOK_VIDEO_LIST_MAX_COUNT);
  });
});

/* -------------------------------------------------------------------------- */
/* Conformance kit                                                            */
/* -------------------------------------------------------------------------- */

function harness(): SocialConformanceHarness<FakeWorld> {
  return {
    async create() {
      const world = makeWorld();
      return {
        adapter: new TikTokVideosAdapter({ client: makeClient(world), sleep: NO_SLEEP }),
        world,
      };
    },
    async publish(world, count) {
      return publish(world, count);
    },
    // expireCursor is deliberately OMITTED: the watermark is ours and is never
    // sent to TikTok, so there is no provider-side cursor that can be refused.
    // The kit skips the check and SAYS it skipped, which is the honest outcome
    // — asserted below so the skip stays visible rather than reading as a pass.
    async rateLimitOnce(world) {
      world.failNextWith = { code: 'rate_limit_exceeded', message: 'slow down' };
    },
    secret: SECRET,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
  };
}

describe('TikTokVideosAdapter — P-003 conformance', () => {
  it('passes the shared kit UNMODIFIED', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures.map((f) => f.check + ': ' + f.detail).join(' || ')).toBe('');
  });

  it('declares the cursor-expiry check SKIPPED rather than passing it silently', async () => {
    const report = await runSocialAdapterConformance(harness());
    // TikTok has no provider-side cursor to expire — the watermark never leaves
    // this process — so the kit must SAY it skipped rather than score a pass.
    expect(report.checksSkipped.map((s) => s.check)).toContain(
      'cursor-unusable-falls-back-to-backfill',
    );
  });
});
