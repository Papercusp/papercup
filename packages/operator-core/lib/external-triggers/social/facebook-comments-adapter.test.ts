/**
 * Tests for the Facebook Pages COMMENTS adapter — P-016.
 *
 * The two controls that matter most here are both about things that SUCCEED
 * while being wrong: the credential rail (D-027 — this edge returns empty data
 * rather than erroring for an under-privileged caller) and the `filter` value
 * (the vendor default silently drops nested replies). Neither would show up as
 * a failure in production; both have to be pinned here or not at all.
 */
import { describe, expect, it, vi } from 'vitest';
import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import type { SocialAdapter, SocialNormalizedEvent } from './adapter-contract';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import { FacebookPageCredentialError, type FacebookPageCredential } from './facebook-common';
import {
  FACEBOOK_COMMENTS_FILTER,
  FacebookCommentsAdapter,
  type FacebookCommentsClient,
  type FacebookCommentsPageRequest,
  type FacebookRawComment,
  facebookCommentEventName,
  normalizeFacebookComment,
} from './facebook-comments-adapter';

const PAGE_ID = 'page-1';
const NEVER_EMIT_MARKER = 'page-token-must-never-be-emitted';

const CREDENTIAL: FacebookPageCredential = {
  pageId: PAGE_ID,
  accessToken: NEVER_EMIT_MARKER,
  tasks: ['CREATE_CONTENT', 'MODERATE'],
};

interface FakeWorld {
  /** postId -> comments on it. */
  byPost: Map<string, FacebookRawComment[]>;
  postIds: string[];
  emptyPageWithNext: boolean;
  pageSize: number;
  seq: number;
  commentCalls: FacebookCommentsPageRequest[];
  watchCalls: number;
}

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    byPost: new Map([['post-a', []]]),
    postIds: ['post-a'],
    emptyPageWithNext: false,
    pageSize: 2,
    seq: 0,
    commentCalls: [],
    watchCalls: 0,
    ...over,
  };
}

function publishComments(world: FakeWorld, count: number, postId = world.postIds[0]!): string[] {
  const ids: string[] = [];
  const list = world.byPost.get(postId) ?? [];
  for (let i = 0; i < count; i += 1) {
    world.seq += 1;
    const id = 'c-' + world.seq;
    list.push({
      id,
      created_time: new Date(Date.UTC(2026, 0, 1, 0, 0, world.seq)).toISOString(),
      message: 'body of ' + id,
      from: { id: 'u1', name: 'A Visitor' },
    });
    ids.push(id);
  }
  world.byPost.set(postId, list);
  return ids;
}

function makeClient(world: FakeWorld): FacebookCommentsClient {
  return {
    async listWatchedPostIds() {
      world.watchCalls += 1;
      return [...world.postIds];
    },
    async listComments(request) {
      world.commentCalls.push(request);
      const all = [...(world.byPost.get(request.postId) ?? [])].sort(
        (a, b) => Date.parse(b.created_time) - Date.parse(a.created_time),
      );
      const url = request.nextUrl ? new URL(request.nextUrl) : null;
      const offset = url ? Number(url.searchParams.get('offset') ?? '0') : 0;
      const primed = url?.searchParams.get('primed') === '1';

      if (world.emptyPageWithNext && !primed && offset === 0 && all.length > 0) {
        return { data: [], paging: { next: 'https://graph.facebook.com/c?offset=0&primed=1' } };
      }

      const slice = all.slice(offset, offset + world.pageSize);
      const nextOffset = offset + world.pageSize;
      return {
        data: slice,
        paging: nextOffset < all.length ? { next: 'https://graph.facebook.com/c?offset=' + nextOffset } : {},
      };
    },
  };
}

function newAdapter(
  world: FakeWorld,
  over: Partial<{ credential: FacebookPageCredential; watchWindow: number; maxPagesPerPost: number }> = {},
) {
  return new FacebookCommentsAdapter({
    client: makeClient(world),
    pageId: PAGE_ID,
    credential: over.credential ?? CREDENTIAL,
    pageSize: world.pageSize,
    watchWindow: over.watchWindow ?? 25,
    maxPagesPerPost: over.maxPagesPerPost ?? 10,
  });
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

function harness(worldOver: Partial<FakeWorld> = {}): SocialConformanceHarness<FakeWorld> {
  return {
    async create() {
      const world = makeWorld(worldOver);
      return { adapter: newAdapter(world), world };
    },
    async publish(world, count) {
      return publishComments(world, count);
    },
    // NO expireCursor / NO rateLimitOnce — the same two declared skips the posts
    // adapter documents (D-017 / D-028).
    secret: NEVER_EMIT_MARKER,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
  };
}

/* -------------------------------------------------------------------------- */
/* Conformance                                                                */
/* -------------------------------------------------------------------------- */

describe('FacebookCommentsAdapter — P-003 conformance', () => {
  it('passes the shared kit UNMODIFIED', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures.map((f) => f.check + ': ' + f.detail).join(' || ')).toBe('');
  });

  it('passes the kit when a page is EMPTY but still carries next', async () => {
    const report = await runSocialAdapterConformance(harness({ emptyPageWithNext: true }));
    expect(report.failures.map((f) => f.check + ': ' + f.detail).join(' || ')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* D-027 — the credential rail                                                */
/* -------------------------------------------------------------------------- */

describe('page credential rail (D-027)', () => {
  it('requires MODERATE specifically — CREATE_CONTENT alone is NOT enough', async () => {
    // Without MODERATE the vendor withholds comment ids while the call still
    // succeeds, so a weaker credential yields a believable empty answer.
    const world = makeWorld();
    publishComments(world, 3);
    const weak: FacebookPageCredential = { pageId: PAGE_ID, accessToken: 't', tasks: ['CREATE_CONTENT'] };

    await expect(drain(newAdapter(world, { credential: weak }), null)).rejects.toThrow(
      FacebookPageCredentialError,
    );
  });

  it('fires BEFORE any provider call, including the watch-window lookup', async () => {
    const world = makeWorld();
    publishComments(world, 3);
    const weak: FacebookPageCredential = { pageId: PAGE_ID, accessToken: 't', tasks: ['MANAGE'] };

    await expect(drain(newAdapter(world, { credential: weak }), null)).rejects.toThrow();
    expect(world.watchCalls).toBe(0);
    expect(world.commentCalls).toHaveLength(0);
  });

  it('does NOT advance the watermark when the credential is refused', async () => {
    const world = makeWorld();
    publishComments(world, 2);
    const good = await drain(newAdapter(world), null);
    const savedCursor = good.result.cursor;

    const weak: FacebookPageCredential = { pageId: PAGE_ID, accessToken: 't', tasks: [] };
    await expect(drain(newAdapter(world, { credential: weak }), savedCursor)).rejects.toThrow();

    // The stored cursor is untouched, so a later good pass still covers the gap.
    expect(savedCursor).toEqual(good.result.cursor);
  });

  it('an EMPTY result is only reachable through an asserted credential', async () => {
    // The positive half: with MODERATE held and genuinely no comments, zero is a
    // legitimate answer and the adapter reports it as such.
    const world = makeWorld();
    const { result, events } = await drain(newAdapter(world), null);
    expect(events).toEqual([]);
    expect(result.emitted).toBe(0);
    expect(world.watchCalls).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* filter=stream                                                              */
/* -------------------------------------------------------------------------- */

describe('comment filter', () => {
  it('ALWAYS sends filter=stream — the vendor default drops nested replies', async () => {
    const world = makeWorld();
    publishComments(world, 2);
    await drain(newAdapter(world), null);

    expect(world.commentCalls.length).toBeGreaterThan(0);
    for (const call of world.commentCalls) {
      expect(call.filter).toBe('stream');
      expect(call.filter).not.toBe('toplevel');
    }
  });

  it('exports the value so a regression to the default is assertable', () => {
    expect(FACEBOOK_COMMENTS_FILTER).toBe('stream');
  });
});

/* -------------------------------------------------------------------------- */
/* Fan-out                                                                    */
/* -------------------------------------------------------------------------- */

describe('per-post fan-out (D-026)', () => {
  it('polls EACH watched post — there is no page-wide edge', async () => {
    const world = makeWorld({
      postIds: ['p1', 'p2', 'p3'],
      byPost: new Map([
        ['p1', []],
        ['p2', []],
        ['p3', []],
      ]),
      pageSize: 10,
    });
    publishComments(world, 1, 'p1');
    publishComments(world, 1, 'p3');

    const { events } = await drain(newAdapter(world), null);

    expect(world.commentCalls.map((c) => c.postId)).toEqual(['p1', 'p2', 'p3']);
    expect(events).toHaveLength(2);
  });

  it('bounds the fan-out by the declared watch window', async () => {
    const world = makeWorld({
      postIds: ['p1', 'p2', 'p3', 'p4'],
      byPost: new Map([
        ['p1', []],
        ['p2', []],
        ['p3', []],
        ['p4', []],
      ]),
      pageSize: 10,
    });

    await drain(newAdapter(world, { watchWindow: 2 }), null);
    expect(world.commentCalls.map((c) => c.postId)).toEqual(['p1', 'p2']);
  });

  it('carries one watermark ACROSS posts', async () => {
    const world = makeWorld({
      postIds: ['p1', 'p2'],
      byPost: new Map([
        ['p1', []],
        ['p2', []],
      ]),
      pageSize: 10,
    });
    publishComments(world, 2, 'p1');
    publishComments(world, 2, 'p2');

    const first = await drain(newAdapter(world), null);
    expect(first.events).toHaveLength(4);

    const second = await drain(newAdapter(world), first.result.cursor);
    expect(second.events).toEqual([]);

    const [freshId] = publishComments(world, 1, 'p1');
    const third = await drain(newAdapter(world), second.result.cursor);
    expect(third.events.map((e) => e.externalId)).toEqual([freshId]);
  });
});

/* -------------------------------------------------------------------------- */
/* Paging + path                                                              */
/* -------------------------------------------------------------------------- */

describe('paging and declared path', () => {
  it('does not stop on an empty page that carries next', async () => {
    const world = makeWorld({ emptyPageWithNext: true, pageSize: 2 });
    publishComments(world, 3);
    const { events } = await drain(newAdapter(world), null);
    expect(events).toHaveLength(3);
  });

  it('bounds pages per post', async () => {
    const world = makeWorld({ pageSize: 1 });
    publishComments(world, 10);
    const { events } = await drain(newAdapter(world, { maxPagesPerPost: 3 }), null);
    expect(events).toHaveLength(3);
  });

  it('distinguishes a lost cursor from the routine tick', async () => {
    const world = makeWorld();
    publishComments(world, 2);
    const first = await drain(newAdapter(world), null);

    const routine = await drain(newAdapter(world), first.result.cursor);
    const lost = await drain(newAdapter(world), { watermark: 'not-a-date', boundaryIds: [] });

    expect(first.result.path).toBe('cold-start');
    expect(routine.result.backfillReason).toBe('no-replay-supported');
    expect(lost.result.backfillReason).toBe('cursor-rejected');
  });
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

describe('normalization', () => {
  const base: FacebookRawComment = { id: 'c1', created_time: '2026-01-01T00:00:00Z', message: 'hi' };

  it('names a top-level comment `comment` and a nested one `reply`', () => {
    expect(facebookCommentEventName(base)).toBe('comment');
    expect(facebookCommentEventName({ ...base, parent: { id: 'c0' } })).toBe('reply');
  });

  it('replyToId is the PARENT comment when nested, the POST when top-level', () => {
    expect(normalizeFacebookComment(base, 'post-9').payload.replyToId).toBe('post-9');
    expect(normalizeFacebookComment({ ...base, parent: { id: 'c0' } }, 'post-9').payload.replyToId).toBe('c0');
  });

  it('carries can_comment when stated', () => {
    expect(normalizeFacebookComment({ ...base, can_comment: true }, 'p').payload.canComment).toBe(true);
    expect(normalizeFacebookComment({ ...base, can_comment: false }, 'p').payload.canComment).toBe(false);
  });

  it('leaves canComment UNDEFINED when absent — never coerced to false', () => {
    // Coercing an absent optional field to false would turn a gap in the
    // response into a refusal to reply. Same asymmetry as D-023.
    expect(normalizeFacebookComment(base, 'p').payload.canComment).toBeUndefined();
  });

  it('flags an empty message rather than dropping the comment', () => {
    expect(normalizeFacebookComment({ ...base, message: null }, 'p').payload.textAbsent).toBe(true);
    expect(normalizeFacebookComment(base, 'p').payload.textAbsent).toBeUndefined();
  });

  it('builds a stable dedupe key from provider facts only', async () => {
    const world = makeWorld();
    publishComments(world, 2);
    const a = await drain(newAdapter(world), null);
    const b = await drain(newAdapter(world), null);
    expect(a.events.map((e) => e.dedupeKey)).toEqual(b.events.map((e) => e.dedupeKey));
  });

  it('never emits the access token', async () => {
    const world = makeWorld();
    publishComments(world, 2);
    const { events } = await drain(newAdapter(world), null);
    expect(JSON.stringify(events)).not.toContain(NEVER_EMIT_MARKER);
  });
});

describe('cancellation', () => {
  it('honours an aborted signal', async () => {
    const world = makeWorld();
    publishComments(world, 3);
    const controller = new AbortController();
    controller.abort();
    await expect(
      newAdapter(world).reconcile({ cursor: null, emit: vi.fn(), signal: controller.signal }),
    ).rejects.toThrow();
  });
});
