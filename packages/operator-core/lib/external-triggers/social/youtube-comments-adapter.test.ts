/**
 * YouTube comments adapter tests — P-015 stage 3.
 *
 * NO `expireCursor`, DELIBERATELY — the same choice the Mastodon suite makes and
 * for the same reason: the watermark is never sent to the provider, so no
 * provider can refuse it. The kit skips that check and SAYS it did, which is
 * asserted below rather than left implicit. What replaces it is a direct test of
 * `declarePath`, since the kit's skipped check is exactly the one that would
 * otherwise have covered the backfill reporting.
 *
 * THE PAGE SIZE IS THE POINT (D-013, binding). The kit's gap check publishes
 * THREE items into the offline window, so a page size >= 3 closes that gap in a
 * single request and the multi-page walk never executes. PAGE_SIZE is 2, and a
 * dedicated test asserts the REQUEST COUNT rather than trusting the constant.
 *
 * The controls at the bottom are permanent — a conformance kit nobody has
 * watched fail is a kit that proves nothing.
 */
import { describe, expect, it } from 'vitest';

import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import type { SocialAdapter, SocialNormalizedEvent, SocialReconcileContext } from './adapter-contract';
import { YouTubeRateLimited } from './youtube-common';
import {
  clampYouTubeCommentThreadsMaxResults,
  isYouTubeCommentsCursor,
  normalizeYouTubeComment,
  threadRepliesAreComplete,
  youtubeCommentDedupeKey,
  youtubeCommentEffectiveAt,
  youtubeCommentEventName,
  YouTubeCommentsAdapter,
  YOUTUBE_COMMENTS_PAGE_SIZE_DEFAULT,
  YOUTUBE_COMMENT_THREADS_MAX_RESULTS,
  type YouTubeCommentsCursor,
  type YouTubeCommentThreadsClient,
  type YouTubeCommentThreadsPage,
  type YouTubeRawComment,
  type YouTubeRawCommentThread,
} from './youtube-comments-adapter';

type Ctx = SocialReconcileContext;

/** Smaller than the kit's 3-item gap, so the gap check must paginate. D-013. */
const PAGE_SIZE = 2;

/**
 * The value the kit scans emitted output for. Deliberately low-entropy and named
 * for its ROLE: a realistic credential-shaped fixture trips the secrets guard on
 * write and, worse, the pot-git publish guard forever after — the blob stays in
 * history, so editing the file afterwards does not clear it
 * (EI-21230011589307899).
 */
const NEVER_EMIT_MARKER = 'never-emit-me';

/* -------------------------------------------------------------------------- */
/* A fake YouTube comments feed                                               */
/* -------------------------------------------------------------------------- */

type ServeOrder = 'newest-first' | 'oldest-first';

interface FakeWorld {
  threads: YouTubeRawCommentThread[];
  requests: { pageToken: string | null; maxResults: number }[];
  serveOrder: ServeOrder;
  rateLimitNext: boolean;
  seq: number;
}

const EPOCH = Date.parse('2026-08-23T12:00:00.000Z');

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return { threads: [], requests: [], serveOrder: 'newest-first', rateLimitNext: false, seq: 0, ...over };
}

function makeComment(world: FakeWorld, over: Partial<YouTubeRawComment> = {}): YouTubeRawComment {
  world.seq += 1;
  return {
    id: `c${String(world.seq).padStart(3, '0')}`,
    publishedAt: new Date(EPOCH + world.seq * 1000).toISOString(),
    authorDisplayName: `viewer ${world.seq}`,
    authorChannelId: `UCviewer${world.seq}`,
    textDisplay: `comment ${world.seq}`,
    channelId: 'UC_papercusp',
    likeCount: 0,
    ...over,
  };
}

/** One thread with a top-level comment. Returns the thread. */
function addThread(world: FakeWorld, over: Partial<YouTubeRawCommentThread> = {}): YouTubeRawCommentThread {
  const topLevelComment = makeComment(world);
  const thread: YouTubeRawCommentThread = {
    id: `t_${topLevelComment.id}`,
    videoId: `vid${world.seq}`,
    channelId: 'UC_papercusp',
    totalReplyCount: 0,
    isPublic: true,
    canReply: true,
    topLevelComment,
    replies: [],
    ...over,
  };
  world.threads.push(thread);
  return thread;
}

/** Add a reply to an existing thread, keeping totalReplyCount honest. */
function addReply(
  world: FakeWorld,
  thread: YouTubeRawCommentThread,
  over: Partial<YouTubeRawComment> = {},
): YouTubeRawComment {
  const reply = makeComment(world, { parentId: thread.topLevelComment.id, ...over });
  thread.replies = [...(thread.replies ?? []), reply];
  thread.totalReplyCount = (thread.replies ?? []).length;
  return reply;
}

/** `count` threads, each one second newer. Returns the TOP-LEVEL COMMENT ids. */
function publishThreads(world: FakeWorld, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) ids.push(addThread(world).topLevelComment.id);
  return ids;
}

function fakeClient(world: FakeWorld): YouTubeCommentThreadsClient {
  return {
    async listCommentThreads({ pageToken, maxResults }): Promise<YouTubeCommentThreadsPage> {
      world.requests.push({ pageToken, maxResults });
      if (world.rateLimitNext) {
        world.rateLimitNext = false;
        throw new YouTubeRateLimited('429 rateLimitExceeded', 0);
      }

      // `order=time` — modelled on the TOP-LEVEL comment, the pessimistic
      // reading (see the adapter header). The adapter must not depend on it.
      const ordered = [...world.threads].sort((a, b) => {
        const delta =
          Date.parse(youtubeCommentEffectiveAt(a.topLevelComment)) -
          Date.parse(youtubeCommentEffectiveAt(b.topLevelComment));
        if (delta !== 0) return world.serveOrder === 'newest-first' ? -delta : delta;
        return world.serveOrder === 'newest-first' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
      });

      const offset = pageToken === null ? 0 : Number.parseInt(pageToken, 10);
      const items = ordered.slice(offset, offset + maxResults);
      const next = offset + maxResults;
      return { items, nextPageToken: next < ordered.length ? String(next) : null };
    },
  };
}

function newAdapter(world: FakeWorld, over: Partial<ConstructorParameters<typeof YouTubeCommentsAdapter>[0]> = {}) {
  return new YouTubeCommentsAdapter({
    client: fakeClient(world),
    pageSize: PAGE_SIZE,
    sleep: async () => {},
    ...over,
  });
}

function harness(worldOver: Partial<FakeWorld> = {}): SocialConformanceHarness<FakeWorld> {
  return {
    async create() {
      const world = makeWorld(worldOver);
      return { adapter: newAdapter(world), world };
    },
    async publish(world, count) {
      return publishThreads(world, count);
    },
    // NO expireCursor: this stream's watermark is never sent to the provider, so
    // the provider cannot refuse it. The kit skips that check and SAYS it did —
    // asserted below, and `declarePath` is tested directly instead.
    async rateLimitOnce(world) {
      world.rateLimitNext = true;
    },
    secret: NEVER_EMIT_MARKER,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
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
  const report = await runSocialAdapterConformance({
    ...harness(),
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

describe('YouTubeCommentsAdapter — P-003 conformance', () => {
  it('passes every check the kit can run', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.platformId).toBe('youtube');
  });

  it('SKIPS the cursor-unusable check, and the kit says so', async () => {
    // The skip is a claim about the platform: there is no time parameter on
    // commentThreads.list, so no cursor is ever sent and none can be refused.
    // Asserting the kit RECORDED the skip is what keeps that claim visible
    // rather than letting a silently-absent check look like a passing one.
    const report = await runSocialAdapterConformance(harness());
    expect(report.checksSkipped.map((s) => s.check)).toContain('cursor-unusable-falls-back-to-backfill');
    expect(report.checksRun).not.toContain('cursor-unusable-falls-back-to-backfill');
  });

  it('passes the kit even when the provider serves oldest-first', async () => {
    // `order=time` is documented only as "ordered by time". If this adapter ever
    // gains an early exit keyed on the provider's order, this run fails.
    const report = await runSocialAdapterConformance(harness({ serveOrder: 'oldest-first' }));
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toEqual([]);
  });

  it('walks more than one page to close the kit’s gap', async () => {
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
/* The path this stream reports                                                */
/* -------------------------------------------------------------------------- */

describe('a stored cursor always yields backfill/no-replay-supported', () => {
  it('reports cold-start only when there is genuinely no stored cursor', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 2);
    const { result } = await drain(adapter, null);
    expect(result.path).toBe('cold-start');
    expect(result.backfillReason).toBeUndefined();
  });

  it('reports backfill even on a pass that emitted nothing', async () => {
    // `live-only` asserts the PROVIDER had nothing to replay — a claim about
    // server-side replay this stream cannot support. Reporting it would tell an
    // operator the provider is covering gaps when only our re-read is.
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 2);
    const first = await drain(adapter, null);

    const second = await drain(adapter, first.result.cursor);
    expect(second.events).toHaveLength(0);
    expect(second.result.path).toBe('backfill');
    expect(second.result.backfillReason).toBe('no-replay-supported');
  });

  it('never reports live-only', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 3);
    let cursor: unknown = null;
    for (let pass = 0; pass < 3; pass += 1) {
      const next = await drain(adapter, cursor);
      if (cursor !== null) expect(next.result.path).not.toBe('live-only');
      cursor = next.result.cursor;
    }
  });

  it('reports an unreadable stored cursor as no-replay-supported, not cursor-rejected', async () => {
    // The watermark is never sent anywhere, so no provider ever rejected it.
    // `cursor-rejected` would send a reader hunting for an API error that was
    // never produced; the structural truth is that this stream has no replay.
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 3);
    const { result, events } = await drain(adapter, { legacyShape: 'from-an-older-adapter' });
    expect(result.path).toBe('backfill');
    expect(result.backfillReason).toBe('no-replay-supported');
    expect(result.backfillReason).not.toBe('cursor-rejected');
    expect(events).toHaveLength(3); // the window is still read, not skipped
  });

  it('never reports cursor-expired or cursor-rejected on any pass', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 2);
    const first = await drain(adapter, null);
    publishThreads(world, 2);
    const second = await drain(adapter, first.result.cursor);
    expect(['cursor-expired', 'cursor-rejected']).not.toContain(second.result.backfillReason);
  });
});

/* -------------------------------------------------------------------------- */
/* No time filter exists — structurally                                        */
/* -------------------------------------------------------------------------- */

describe('the watermark is client-side only', () => {
  it('never sends a time parameter, because the endpoint has none', async () => {
    // Pinned on the REQUEST rather than on the client interface, so adding a
    // time field to the port and quietly passing the watermark through it fails
    // here instead of looking like a working incremental read.
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 2);
    const first = await drain(adapter, null);
    const watermark = (first.result.cursor as YouTubeCommentsCursor).watermark;

    world.requests.length = 0;
    await drain(adapter, first.result.cursor);

    for (const request of world.requests) {
      expect(Object.keys(request).sort()).toEqual(['maxResults', 'pageToken']);
      expect(JSON.stringify(request)).not.toContain(watermark);
    }
  });

  it('re-reads the whole window every pass and filters locally', async () => {
    // The defining cost of watermark-rescan, asserted so nobody later "optimises"
    // it into an incremental read this endpoint cannot support.
    const world = makeWorld();
    const adapter = newAdapter(world, { pageSize: 100 });
    publishThreads(world, 5);
    const first = await drain(adapter, null);

    world.requests.length = 0;
    publishThreads(world, 1);
    const second = await drain(adapter, first.result.cursor);

    expect(second.events).toHaveLength(1); // only the new one is emitted…
    expect(world.requests).toHaveLength(1); // …but all six were read
  });
});

/* -------------------------------------------------------------------------- */
/* The boundary half of D-023                                                  */
/* -------------------------------------------------------------------------- */

describe('boundaryIds — D-023’s client-side half', () => {
  it('emits nothing on an unchanged feed, repeatedly', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 3);

    let cursor: unknown = null;
    const first = await drain(adapter, cursor);
    expect(first.events).toHaveLength(3);
    cursor = first.result.cursor;

    for (let pass = 0; pass < 3; pass += 1) {
      const next = await drain(adapter, cursor);
      expect(next.events, `pass ${pass} re-emitted the boundary`).toHaveLength(0);
      cursor = next.result.cursor;
    }
  });

  it('emits a comment landing in the SAME instant as the watermark', async () => {
    // The reason boundaryIds exist rather than a bare `>` comparison: a bare
    // `>` would drop this comment, and a bare `>=` would re-emit the one already
    // delivered at that instant.
    const world = makeWorld();
    const adapter = newAdapter(world);
    const sameInstant = '2026-08-23T12:00:00.000Z';
    const firstThread = addThread(world);
    firstThread.topLevelComment.publishedAt = sameInstant;

    const pass1 = await drain(adapter, null);
    expect(pass1.events).toHaveLength(1);

    const secondThread = addThread(world);
    secondThread.topLevelComment.publishedAt = sameInstant;

    const pass2 = await drain(adapter, pass1.result.cursor);
    expect(pass2.events.map((e) => e.externalId)).toEqual([secondThread.topLevelComment.id]);
  });

  it('carries boundaryIds forward when the watermark does not move', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 2);
    const first = await drain(adapter, null);
    const second = await drain(adapter, first.result.cursor);
    const cursor = second.result.cursor as YouTubeCommentsCursor;
    expect(cursor.boundaryIds.length).toBeGreaterThan(0);
  });

  it('resets boundaryIds once the watermark advances', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 2);
    const first = await drain(adapter, null);
    const firstCursor = first.result.cursor as YouTubeCommentsCursor;

    publishThreads(world, 2);
    const second = await drain(adapter, firstCursor);
    const secondCursor = second.result.cursor as YouTubeCommentsCursor;

    expect(secondCursor.watermark).not.toBe(firstCursor.watermark);
    expect(secondCursor.boundaryIds).toHaveLength(1);
    for (const id of firstCursor.boundaryIds) expect(secondCursor.boundaryIds).not.toContain(id);
  });
});

/* -------------------------------------------------------------------------- */
/* Edits                                                                       */
/* -------------------------------------------------------------------------- */

describe('an edited comment is new content, not a duplicate', () => {
  it('falls back to publishedAt when updatedAt is absent', () => {
    // The vendor page documents what updatedAt MEANS but not whether it is
    // present on a never-edited comment, so the fallback is load-bearing.
    expect(youtubeCommentEffectiveAt({ publishedAt: 'p', updatedAt: null })).toBe('p');
    expect(youtubeCommentEffectiveAt({ publishedAt: 'p', updatedAt: undefined })).toBe('p');
    expect(youtubeCommentEffectiveAt({ publishedAt: 'p', updatedAt: '' })).toBe('p');
    expect(youtubeCommentEffectiveAt({ publishedAt: 'p', updatedAt: 'u' })).toBe('u');
  });

  it('re-delivers a comment whose text was edited after the watermark', async () => {
    // Watermarking on publishedAt would file the edit under the ORIGINAL
    // publication instant — below the watermark — so the edit would never be
    // delivered at all.
    const world = makeWorld();
    const adapter = newAdapter(world);
    const thread = addThread(world);
    const first = await drain(adapter, null);
    expect(first.events).toHaveLength(1);

    thread.topLevelComment.textDisplay = 'edited text';
    thread.topLevelComment.updatedAt = new Date(EPOCH + 60_000).toISOString();

    const second = await drain(adapter, first.result.cursor);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.payload.text).toBe('edited text');
    expect(second.events[0]!.payload.editedAt).toBe(thread.topLevelComment.updatedAt);
  });

  it('changes the dedupe key on an edit so the ingestion seam re-delivers it', () => {
    const base = { id: 'c001', publishedAt: '2026-08-23T12:00:00.000Z' };
    const edited = { ...base, updatedAt: '2026-08-23T13:00:00.000Z' };
    expect(youtubeCommentDedupeKey(base)).not.toBe(youtubeCommentDedupeKey(edited));
  });

  it('keeps the dedupe key stable when nothing changed', () => {
    const comment = { id: 'c001', publishedAt: '2026-08-23T12:00:00.000Z' };
    expect(youtubeCommentDedupeKey(comment)).toBe(youtubeCommentDedupeKey(comment));
    expect(youtubeCommentDedupeKey(comment)).toBe('c001@2026-08-23T12:00:00.000Z');
  });
});

/* -------------------------------------------------------------------------- */
/* Replies                                                                     */
/* -------------------------------------------------------------------------- */

describe('replies are ingested, not ignored', () => {
  it('emits an inline reply as its own event', async () => {
    // The declared write verb is `reply`; an integration that can reply but
    // cannot see a reply back is half a conversation. They arrive inside the
    // same 1-unit call, so this costs no extra quota.
    const world = makeWorld();
    const adapter = newAdapter(world);
    const thread = addThread(world);
    const reply = addReply(world, thread);

    const { events } = await drain(adapter, null);
    const names = events.map((e) => `${e.event}:${e.externalId}`);
    expect(names).toContain(`comment:${thread.topLevelComment.id}`);
    expect(names).toContain(`reply:${reply.id}`);
  });

  it('names a top-level comment and a reply differently', () => {
    expect(youtubeCommentEventName({ parentId: null })).toBe('comment');
    expect(youtubeCommentEventName({ parentId: undefined })).toBe('comment');
    expect(youtubeCommentEventName({ parentId: 'c001' })).toBe('reply');
  });

  it('carries parentId verbatim without reinterpreting it as a thread id', async () => {
    // The vendor page does not say whether a nested reply points at the thread
    // root or at an intermediate comment, so the adapter must not assert either.
    const world = makeWorld();
    const adapter = newAdapter(world);
    const thread = addThread(world);
    const reply = addReply(world, thread, { parentId: 'some-other-comment' });

    const { events } = await drain(adapter, null);
    const emitted = events.find((e) => e.externalId === reply.id)!;
    expect(emitted.payload.replyToId).toBe('some-other-comment');
    expect(emitted.payload.threadId).toBe(thread.id);
  });

  it('flags a thread whose replies are truncated, rather than under-reporting silently', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    const thread = addThread(world);
    addReply(world, thread);
    thread.totalReplyCount = 12; // the provider says there are more than it sent

    const { events } = await drain(adapter, null);
    const top = events.find((e) => e.externalId === thread.topLevelComment.id)!;
    expect(top.payload.repliesTruncated).toBe(true);
    expect(top.payload.totalReplyCount).toBe(12);
  });

  it('does not flag a thread whose replies are complete', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    const thread = addThread(world);
    addReply(world, thread);

    const { events } = await drain(adapter, null);
    const top = events.find((e) => e.externalId === thread.topLevelComment.id)!;
    expect(top.payload.repliesTruncated).toBeUndefined();
  });

  it('threadRepliesAreComplete compares the list against totalReplyCount', () => {
    const base = {
      id: 't1',
      totalReplyCount: 0,
      topLevelComment: { id: 'c1', publishedAt: '2026-08-23T12:00:00.000Z' },
    } satisfies YouTubeRawCommentThread;
    expect(threadRepliesAreComplete(base)).toBe(true);
    expect(threadRepliesAreComplete({ ...base, totalReplyCount: 3 })).toBe(false);
    expect(
      threadRepliesAreComplete({
        ...base,
        totalReplyCount: 1,
        replies: [{ id: 'c2', publishedAt: '2026-08-23T12:00:01.000Z' }],
      }),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                               */
/* -------------------------------------------------------------------------- */

describe('normalization', () => {
  const thread: YouTubeRawCommentThread = {
    id: 't_c001',
    videoId: 'vid42',
    channelId: 'UC_papercusp',
    totalReplyCount: 0,
    isPublic: true,
    canReply: true,
    topLevelComment: {
      id: 'c001',
      publishedAt: '2026-08-23T12:00:00.000Z',
      authorDisplayName: 'a viewer',
      authorChannelId: 'UCviewer',
      textDisplay: 'nice video',
      channelId: 'UC_papercusp',
      likeCount: 4,
    },
    replies: [],
  };

  it('carries the fields the stage-4 reply seam will read off the stored document', () => {
    const event = normalizeYouTubeComment(thread.topLevelComment, thread);
    expect(event.payload.threadId).toBe('t_c001');
    expect(event.payload.channelId).toBe('UC_papercusp');
    expect(event.payload.id).toBe('c001');
  });

  it('takes videoId from the THREAD, since the comment resource has none', () => {
    const event = normalizeYouTubeComment(thread.topLevelComment, thread);
    expect(event.payload.videoId).toBe('vid42');
    expect(event.payload.url).toBe('https://www.youtube.com/watch?v=vid42&lc=c001');
  });

  it('prefers textDisplay, which is the field reliably served to non-authors', () => {
    const event = normalizeYouTubeComment(
      { ...thread.topLevelComment, textOriginal: 'raw', textDisplay: 'display' },
      thread,
    );
    expect(event.payload.text).toBe('display');
  });

  it('still produces a schema-valid payload when the comment carries no text', () => {
    const event = normalizeYouTubeComment(
      { id: 'c9', publishedAt: '2026-08-23T12:00:00.000Z' },
      { ...thread, videoId: null },
    );
    expect(typeof event.payload.text).toBe('string');
    expect(event.payload.url).toBeUndefined();
  });

  it('omits editedAt when the comment was never edited', () => {
    const event = normalizeYouTubeComment(thread.topLevelComment, thread);
    expect(event.payload.editedAt).toBeUndefined();
    expect(event.payload.publishedAt).toBe('2026-08-23T12:00:00.000Z');
  });
});

/* -------------------------------------------------------------------------- */
/* Paging and bounds                                                           */
/* -------------------------------------------------------------------------- */

describe('pageToken is a page within one query, never a resume point (D-021)', () => {
  it('never persists a pageToken into the cursor', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 5);
    const { result } = await drain(adapter, null);
    expect(world.requests.some((r) => r.pageToken !== null)).toBe(true);
    expect(JSON.stringify(result.cursor)).not.toContain('pageToken');
    expect(isYouTubeCommentsCursor(result.cursor)).toBe(true);
  });

  it('starts every reconcile at the first page', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    publishThreads(world, 5);
    const first = await drain(adapter, null);

    world.requests.length = 0;
    publishThreads(world, 3);
    await drain(adapter, first.result.cursor);
    expect(world.requests[0]!.pageToken).toBeNull();
  });

  it('KNOWN LIMIT: activity beyond the bounded window is not seen', async () => {
    // Not a bug — the stated cost of a stream with no time filter, pinned here so
    // it is a measured bound rather than a surprise. maxPages is the bound; the
    // remedy is a larger window, not an order-dependent early exit.
    const world = makeWorld();
    const adapter = newAdapter(world, { maxPages: 1 }); // 1 page × 2 threads
    publishThreads(world, 5);

    const { events } = await drain(adapter, null);
    expect(world.requests).toHaveLength(1);
    expect(events).toHaveLength(PAGE_SIZE);
  });
});

describe('maxResults mirrors the documented 1–100 range', () => {
  it('clamps to [1, 100] and defaults to the ceiling', () => {
    expect(clampYouTubeCommentThreadsMaxResults(undefined)).toBe(YOUTUBE_COMMENTS_PAGE_SIZE_DEFAULT);
    expect(clampYouTubeCommentThreadsMaxResults(500)).toBe(YOUTUBE_COMMENT_THREADS_MAX_RESULTS);
    expect(clampYouTubeCommentThreadsMaxResults(0)).toBe(1);
    expect(clampYouTubeCommentThreadsMaxResults(-5)).toBe(1);
    expect(clampYouTubeCommentThreadsMaxResults(20)).toBe(20);
  });

  it('does not reuse the activities endpoint’s 50 ceiling', () => {
    // The two endpoints publish different ranges (activities 0–50 default 5;
    // commentThreads 1–100 default 20). Sharing a constant would silently cap
    // this stream at half its allowance.
    expect(YOUTUBE_COMMENT_THREADS_MAX_RESULTS).toBe(100);
    expect(clampYouTubeCommentThreadsMaxResults(100)).toBe(100);
  });
});

describe('the cursor type guard', () => {
  it('accepts a well-formed cursor', () => {
    expect(isYouTubeCommentsCursor({ watermark: '2026-08-23T12:00:00Z', boundaryIds: [] })).toBe(true);
  });

  it('refuses shapes that would silently behave as a cold start', () => {
    expect(isYouTubeCommentsCursor(null)).toBe(false);
    expect(isYouTubeCommentsCursor({ watermark: 'not-a-date', boundaryIds: [] })).toBe(false);
    expect(isYouTubeCommentsCursor({ watermark: '2026-08-23T12:00:00Z' })).toBe(false);
    expect(isYouTubeCommentsCursor({ boundaryIds: [] })).toBe(false);
    // The activities cursor's shape must not be mistaken for this one.
    expect(isYouTubeCommentsCursor({ publishedAfter: '2026-08-23T12:00:00Z', boundaryIds: [] })).toBe(false);
  });
});

describe('an unparseable provider timestamp', () => {
  it('is emitted rather than dropped, and cannot move the watermark', async () => {
    const world = makeWorld();
    const adapter = newAdapter(world);
    addThread(world); // a well-formed one at EPOCH+1s
    const broken = addThread(world);
    broken.topLevelComment.publishedAt = 'sometime-tuesday';

    const { result, events } = await drain(adapter, null);
    expect(events.map((e) => e.externalId)).toContain(broken.topLevelComment.id);
    expect((result.cursor as YouTubeCommentsCursor).watermark).not.toBe('sometime-tuesday');
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
    // about the kit that nobody has watched be true.
    const report = await runSocialAdapterConformance({
      ...harness(),
      async create() {
        const world = makeWorld();
        return { adapter: newAdapter(world, { pageSize: 3, maxPages: 1 }), world };
      },
    });
    expect(report.failures.map((f) => f.check)).not.toContain('offline-gap-closed-exactly-once');
  });

  it('REJECTED DESIGN: a bare watermark with no boundaryIds re-emits the boundary forever', async () => {
    // On a rescan stream this is worse than on a cursored one: the whole window
    // is re-read every pass, so the boundary is re-emitted on EVERY tick.
    class BareWatermarkAdapter extends YouTubeCommentsAdapter {
      override async reconcile(ctx: Ctx) {
        const result = await super.reconcile(ctx);
        const cursor = result.cursor as YouTubeCommentsCursor | null;
        if (!cursor) return result;
        return { ...result, cursor: { watermark: cursor.watermark, boundaryIds: [] } };
      }
    }

    const checks = await failuresFor(
      (world) => new BareWatermarkAdapter({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('no-op-reconcile-emits-nothing');
  });

  it('catches an adapter that ignores the watermark entirely', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeCommentsAdapter {
          override async reconcile(ctx: Ctx) {
            return super.reconcile({ ...ctx, cursor: null });
          }
        })({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    expect(checks).toContain('no-op-reconcile-emits-nothing');
  });

  it('catches a backfill that does not state its reason', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeCommentsAdapter {
          override async reconcile(ctx: Ctx) {
            const result = await super.reconcile(ctx);
            if (result.path === 'backfill') return { ...result, backfillReason: undefined };
            return result;
          }
        })({ client: fakeClient(world), pageSize: PAGE_SIZE, sleep: async () => {} }),
    );
    // isCoherentReconcileResult is checked on the cold-start and gap passes.
    expect(checks).toContain('offline-gap-closed-exactly-once');
  });

  it('catches a dedupe key that is not stable across a replay', async () => {
    const checks = await failuresFor(
      (world) =>
        new (class extends YouTubeCommentsAdapter {
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
        new (class extends YouTubeCommentsAdapter {
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
        new (class extends YouTubeCommentsAdapter {
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
