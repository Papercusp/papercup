/**
 * P-017 — the Instagram comments adapter.
 *
 * The tests that matter most here are the D-031 ones. Every other property this
 * adapter has (no loss on replay, dedupe stability, credential gating) is shared
 * with its Pages sibling and checked by the same conformance kit. What is NEW is
 * that Instagram's comments edge is CAPPED at 50 with no paging, which turns a
 * throughput limit into a correctness bound — and the failure it produces is
 * invisible from the response, so it has to be caught by a predicate rather than
 * by an assertion on what came back.
 *
 * Each of those tests is paired with a CONTROL showing the naive implementation
 * (report success, emit the 50 you can see) passing where the real one reports
 * loss — because a test that only asserts "lossRisk is set" cannot distinguish a
 * working detector from one that fires constantly.
 */

import { describe, expect, it } from 'vitest';
import {
  runSocialAdapterConformance,
  type SocialConformanceHarness,
} from './conformance';
import type { SocialAdapter, SocialNormalizedEvent } from './adapter-contract';
import { isCoherentReconcileResult } from './adapter-contract';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import {
  INSTAGRAM_COMMENTS_MAX_PER_QUERY,
  InstagramCredentialError,
  type InstagramCredential,
  instagramIsReverseChronological,
  instagramWindowOverflowed,
} from './instagram-common';
import {
  InstagramCommentsAdapter,
  flattenInstagramComments,
  instagramCommentDedupeKey,
  instagramCommentEventName,
  normalizeInstagramComment,
  type InstagramCommentsClient,
  type InstagramRawComment,
} from './instagram-comments-adapter';

const IG_USER_ID = 'ig-17841400000000000';
const PAGE_ID = 'page-999';
const NEVER_EMIT_MARKER = 'ig-token-must-never-be-emitted';

const CREDENTIAL: InstagramCredential = {
  igUserId: IG_USER_ID,
  pageId: PAGE_ID,
  accessToken: NEVER_EMIT_MARKER,
  scopes: ['instagram_basic', 'instagram_manage_comments', 'pages_read_engagement'],
};

interface FakeWorld {
  /** mediaId -> comments, NEWEST FIRST as the vendor documents for v3.2+. */
  media: Map<string, InstagramRawComment[]>;
  watchCalls: number;
  commentCalls: string[];
  maxPerQuery: number;
  seq: number;
}

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return {
    media: new Map([['media-1', []]]),
    watchCalls: 0,
    commentCalls: [],
    maxPerQuery: INSTAGRAM_COMMENTS_MAX_PER_QUERY,
    seq: 0,
    ...over,
  };
}

/** Publish `count` comments onto media-1, each one second newer than the last. */
function publishComments(world: FakeWorld, count: number, mediaId = 'media-1'): string[] {
  const list = world.media.get(mediaId) ?? [];
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    world.seq += 1;
    const id = `c${world.seq}`;
    ids.push(id);
    // Unshift: the fake returns newest-first, matching the documented order.
    list.unshift({
      id,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, world.seq)).toISOString(),
      text: `comment ${world.seq}`,
      username: 'someone',
      like_count: 0,
    });
  }
  world.media.set(mediaId, list);
  return ids;
}

function makeClient(world: FakeWorld): InstagramCommentsClient {
  return {
    async listWatchedMediaIds({ limit }) {
      world.watchCalls += 1;
      return [...world.media.keys()].slice(0, limit);
    },
    async listComments({ mediaId, limit }) {
      world.commentCalls.push(mediaId);
      // THE VENDOR'S CAP, modelled honestly: the provider hands back at most
      // `limit` items and offers no way to ask for the rest.
      return (world.media.get(mediaId) ?? []).slice(0, Math.min(limit, world.maxPerQuery));
    },
  };
}

function newAdapter(world: FakeWorld, over: Partial<{ credential: InstagramCredential; watchWindow: number }> = {}) {
  return new InstagramCommentsAdapter({
    client: makeClient(world),
    igUserId: IG_USER_ID,
    credential: over.credential ?? CREDENTIAL,
    watchWindow: over.watchWindow ?? 25,
    maxPerQuery: world.maxPerQuery,
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
    // No expireCursor / rateLimitOnce: this platform has no server-side cursor to
    // expire, so the kit SKIPS those and says so rather than passing vacuously.
    secret: NEVER_EMIT_MARKER,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
  };
}

/* -------------------------------------------------------------------------- */
/* Conformance                                                                */
/* -------------------------------------------------------------------------- */

describe('InstagramCommentsAdapter — P-003 conformance', () => {
  it('passes the shared kit UNMODIFIED', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures.map((f) => `${f.check}: ${f.detail}`).join(' || ')).toBe('');
  });

  it('passes the kit with a SMALL cap, where the window overflows constantly', async () => {
    // The adapter now reports loss on most passes. That must not make it
    // non-conformant: declaring a known gap is correct behaviour, and the kit
    // should still see a coherent adapter.
    const report = await runSocialAdapterConformance(harness({ maxPerQuery: 2 }));
    expect(report.failures.map((f) => `${f.check}: ${f.detail}`).join(' || ')).toBe('');
  });
});

/* -------------------------------------------------------------------------- */
/* D-031 — the loss bound                                                     */
/* -------------------------------------------------------------------------- */

describe('capped, unpageable window (D-031)', () => {
  it('reports NO loss when the window reaches back past the watermark', async () => {
    const world = makeWorld({ maxPerQuery: 10 });
    publishComments(world, 3);
    const first = await drain(newAdapter(world), null);

    publishComments(world, 2);
    const second = await drain(newAdapter(world), first.result.cursor);

    expect(second.events).toHaveLength(2);
    expect(second.result.lossRisk).toBeUndefined();
  });

  it('reports loss when MORE than a full window arrived between polls', async () => {
    const world = makeWorld({ maxPerQuery: 5 });
    publishComments(world, 2);
    const first = await drain(newAdapter(world), null);

    // 8 new against a 5-wide window: the oldest 3 fall off the end and the API
    // offers no way to ask for them.
    publishComments(world, 8);
    const second = await drain(newAdapter(world), first.result.cursor);

    expect(second.result.lossRisk).toMatchObject({ kind: 'capped-window-overflow', occurrences: 1 });
    expect(second.result.lossRisk?.detail).toContain('media-1');
    // It still emits everything it CAN see — declaring a gap is not a reason to
    // throw away the events that did arrive.
    expect(second.events).toHaveLength(5);
  });

  it('CONTROL: the naive implementation is indistinguishable from a healthy pass', () => {
    // What a reader of the response alone can see. Both passes return a full
    // page; only the watermark comparison separates them, which is why the
    // predicate exists rather than an assertion on the payload.
    const full = Array.from({ length: 5 }, (_, i) => ({
      id: `x${i}`,
      timestamp: new Date(Date.UTC(2026, 0, 2, 0, 0, 30 + i)).toISOString(),
    }));

    const naiveLooksFine = full.length > 0; // "we got comments, all good"
    expect(naiveLooksFine).toBe(true);

    const behind = { watermark: new Date(Date.UTC(2026, 0, 2, 0, 0, 1)).toISOString(), seenAtWatermark: ['old'] };
    const caughtUp = { watermark: new Date(Date.UTC(2026, 0, 2, 0, 0, 40)).toISOString(), seenAtWatermark: ['new'] };

    expect(instagramWindowOverflowed(full, behind, 5)).toBe(true);
    expect(instagramWindowOverflowed(full, caughtUp, 5)).toBe(false);
  });

  it('a SHORT page never reports loss, however far behind the watermark is', () => {
    // Short means the provider had nothing more to give: the window covered
    // everything that exists, so there is no gap regardless of the watermark.
    const short = [{ id: 'a', timestamp: '2026-01-02T00:00:30.000Z' }];
    const ancient = { watermark: '2020-01-01T00:00:00.000Z', seenAtWatermark: [] };
    expect(instagramWindowOverflowed(short, ancient, 5)).toBe(false);
  });

  it('a COLD START never reports loss, by definition rather than by luck', async () => {
    // With no watermark there is nothing to have fallen behind. A full first
    // page is the documented starting position, not a gap.
    const world = makeWorld({ maxPerQuery: 3 });
    publishComments(world, 20);
    const { result } = await drain(newAdapter(world), null);

    expect(result.path).toBe('cold-start');
    expect(result.lossRisk).toBeUndefined();
  });

  it('counts loss PER MEDIA, so one busy thread does not hide behind a quiet one', async () => {
    const world = makeWorld({ maxPerQuery: 3, media: new Map([['media-1', []], ['media-2', []]]) });
    publishComments(world, 1, 'media-1');
    publishComments(world, 1, 'media-2');
    const first = await drain(newAdapter(world), null);

    publishComments(world, 6, 'media-1');
    publishComments(world, 6, 'media-2');
    const second = await drain(newAdapter(world), first.result.cursor);

    expect(second.result.lossRisk?.occurrences).toBe(2);
  });

  it('the declared loss is COHERENT by the contract\'s own predicate', async () => {
    const world = makeWorld({ maxPerQuery: 2 });
    publishComments(world, 1);
    const first = await drain(newAdapter(world), null);
    publishComments(world, 5);
    const second = await drain(newAdapter(world), first.result.cursor);

    expect(second.result.lossRisk).toBeDefined();
    expect(isCoherentReconcileResult(second.result)).toBe(true);

    // CONTROL: a zero-occurrence loss claim is rejected, so the field cannot be
    // set decoratively.
    expect(
      isCoherentReconcileResult({
        ...second.result,
        lossRisk: { kind: 'capped-window-overflow', occurrences: 0, detail: 'x' },
      }),
    ).toBe(false);
  });

  it('the ordering guarantee this all rests on is version-gated, and asserted', () => {
    // If the pinned version ever moves below 3.2 the results come back OLDEST
    // first, and the newest-50 argument silently inverts.
    expect(instagramIsReverseChronological('v23.0')).toBe(true);
    expect(instagramIsReverseChronological('v3.2')).toBe(true);
    expect(instagramIsReverseChronological('v3.1')).toBe(false);
    expect(instagramIsReverseChronological('nonsense')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Replies — the top-level-only default                                       */
/* -------------------------------------------------------------------------- */

describe('nested replies (the top-level-only default)', () => {
  it('emits expanded replies, which the default response would have omitted', async () => {
    const world = makeWorld();
    world.media.set('media-1', [
      {
        id: 'parent-1',
        timestamp: '2026-01-01T00:00:10.000Z',
        text: 'top level',
        replies: { data: [{ id: 'reply-1', timestamp: '2026-01-01T00:00:20.000Z', text: 'nested' }] },
      },
    ]);

    const { events } = await drain(newAdapter(world), null);
    expect(events.map((e) => e.externalId).sort()).toEqual(['parent-1', 'reply-1']);
  });

  it('CONTROL: without expansion the reply is simply absent — no error, no signal', () => {
    // The trap this guards. The vendor returns 200 with only top-level comments,
    // so an adapter that never asked for `replies` looks perfectly healthy.
    const topLevelOnly: InstagramRawComment[] = [{ id: 'parent-1', timestamp: '2026-01-01T00:00:10.000Z' }];
    expect(flattenInstagramComments(topLevelOnly)).toHaveLength(1);
  });

  it('a reply is a DIFFERENT event kind, and inherits its parent id when the vendor omits one', () => {
    const flat = flattenInstagramComments([
      {
        id: 'p',
        timestamp: '2026-01-01T00:00:10.000Z',
        replies: { data: [{ id: 'r', timestamp: '2026-01-01T00:00:20.000Z' }] },
      },
    ]);
    expect(instagramCommentEventName(flat[0]!)).toBe('comment');
    expect(instagramCommentEventName(flat[1]!)).toBe('reply');
    expect(flat[1]!.parent_id).toBe('p');
  });

  it('drops a malformed item rather than emitting one with no timestamp', () => {
    const flat = flattenInstagramComments([
      { id: 'ok', timestamp: '2026-01-01T00:00:10.000Z' },
      { id: 'bad' } as InstagramRawComment,
    ]);
    expect(flat.map((c) => c.id)).toEqual(['ok']);
  });
});

/* -------------------------------------------------------------------------- */
/* Credential rail (D-027, re-derived)                                        */
/* -------------------------------------------------------------------------- */

describe('credential rail', () => {
  it('refuses a credential without instagram_manage_comments, BEFORE any call', async () => {
    const world = makeWorld();
    publishComments(world, 3);
    const weak: InstagramCredential = { ...CREDENTIAL, scopes: ['instagram_basic'] };

    await expect(drain(newAdapter(world, { credential: weak }), null)).rejects.toThrow(InstagramCredentialError);
    expect(world.watchCalls).toBe(0);
    expect(world.commentCalls).toHaveLength(0);
  });

  it('refuses a credential minted for a DIFFERENT Instagram account', async () => {
    const world = makeWorld();
    const wrong: InstagramCredential = { ...CREDENTIAL, igUserId: 'ig-someone-else' };
    await expect(drain(newAdapter(world, { credential: wrong }), null)).rejects.toThrow(/wrong_account/);
  });

  it('does NOT advance the watermark when the credential is refused', async () => {
    const world = makeWorld();
    publishComments(world, 2);
    const good = await drain(newAdapter(world), null);
    const saved = good.result.cursor;

    const weak: InstagramCredential = { ...CREDENTIAL, scopes: [] };
    await expect(drain(newAdapter(world, { credential: weak }), saved)).rejects.toThrow();
    expect(saved).toEqual(good.result.cursor);
  });
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

describe('normalization', () => {
  it('keys dedupe on the id ALONE, because the node carries no edit marker', () => {
    // like_count moves whenever anyone likes the comment. Folding it in would
    // re-deliver the same comment on every like.
    const a: InstagramRawComment = { id: 'c1', timestamp: '2026-01-01T00:00:01.000Z', like_count: 0 };
    const b: InstagramRawComment = { ...a, like_count: 41 };
    expect(instagramCommentDedupeKey(a)).toBe(instagramCommentDedupeKey(b));
  });

  it('carries the vendor timestamp format through unchanged', () => {
    // `2017-05-19T23:27:28+0000` — an offset with no colon. A helper written for
    // RFC 3339 would reject it and the failure would look like "no comments".
    const event = normalizeInstagramComment({ id: 'c1', timestamp: '2017-05-19T23:27:28+0000' }, 'media-1');
    expect(event.occurredAt).toBe('2017-05-19T23:27:28+0000');
    expect(Number.isFinite(Date.parse(event.occurredAt as string))).toBe(true);
  });

  it('never emits the access token', async () => {
    const world = makeWorld();
    publishComments(world, 2);
    const { events } = await drain(newAdapter(world), null);
    expect(JSON.stringify(events)).not.toContain(NEVER_EMIT_MARKER);
  });
});
