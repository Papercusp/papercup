/**
 * Tests for the Facebook Pages POSTS adapter — P-016.
 *
 * The centrepiece is the RANKED-ORDER control. D-025 rules that this adapter may
 * derive no control flow from item position, because the vendor describes the
 * result set as "ranked" and documents no ordering guarantee. That ruling is
 * only worth anything if a violation of it actually fails a test, so the fake
 * world can serve posts in an order where an unseen item sits BEHIND a seen one
 * — the exact arrangement under which the conventional "stop at the first old
 * item" optimisation silently drops an event.
 */
import { describe, expect, it, vi } from 'vitest';
import { runSocialAdapterConformance, type SocialConformanceHarness } from './conformance';
import type { SocialAdapter, SocialNormalizedEvent } from './adapter-contract';
import { SOCIAL_POST_SCHEMA_FIXTURE } from './social-post-schema.fixture';
import { FacebookPageCredentialError, type FacebookPageCredential } from './facebook-common';
import {
  FacebookPostsAdapter,
  type FacebookPostsClient,
  type FacebookPostsPageRequest,
  type FacebookRawPost,
  facebookPostEffectiveAt,
  facebookPostText,
  facebookPostUrl,
  normalizeFacebookPost,
} from './facebook-posts-adapter';

const PAGE_ID = 'page-1';
const NEVER_EMIT_MARKER = 'page-token-must-never-be-emitted';

const CREDENTIAL: FacebookPageCredential = {
  pageId: PAGE_ID,
  accessToken: NEVER_EMIT_MARKER,
  tasks: ['CREATE_CONTENT', 'MODERATE'],
};

/* -------------------------------------------------------------------------- */
/* Fake world                                                                 */
/* -------------------------------------------------------------------------- */

interface FakeWorld {
  posts: FacebookRawPost[];
  /** Pages of ids the client will serve, in order. Built by `paginate`. */
  serveOrder: 'newest-first' | 'oldest-first' | 'ranked';
  /** Insert an EMPTY page that still carries `next`, per the vendor's warning. */
  emptyPageWithNext: boolean;
  pageSize: number;
  calls: number;
  seq: number;
}

function makeWorld(over: Partial<FakeWorld> = {}): FakeWorld {
  return { posts: [], serveOrder: 'newest-first', emptyPageWithNext: false, pageSize: 2, calls: 0, seq: 0, ...over };
}

function post(id: string, createdIso: string, over: Partial<FacebookRawPost> = {}): FacebookRawPost {
  return { id, message: 'text of ' + id, created_time: createdIso, ...over };
}

function publishPosts(world: FakeWorld, count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    world.seq += 1;
    const id = 'post-' + world.seq;
    // Distinct, strictly increasing instants so ordering is unambiguous.
    world.posts.push(post(id, new Date(Date.UTC(2026, 0, 1, 0, 0, world.seq)).toISOString()));
    ids.push(id);
  }
  return ids;
}

function ordered(world: FakeWorld): FacebookRawPost[] {
  const byNewest = [...world.posts].sort(
    (a, b) => Date.parse(facebookPostEffectiveAt(b)) - Date.parse(facebookPostEffectiveAt(a)),
  );
  if (world.serveOrder === 'newest-first') return byNewest;
  if (world.serveOrder === 'oldest-first') return byNewest.reverse();
  // 'ranked': deliberately NOT chronological — oldest first, newest buried last.
  // This is the arrangement that breaks an early-exit implementation.
  return byNewest.reverse();
}

function makeClient(world: FakeWorld): FacebookPostsClient {
  return {
    async listPublishedPosts(request: FacebookPostsPageRequest) {
      world.calls += 1;
      const all = ordered(world);
      const url = request.nextUrl ? new URL(request.nextUrl) : null;
      const offset = url ? Number(url.searchParams.get('offset') ?? '0') : 0;
      const primed = url?.searchParams.get('primed') === '1';

      if (world.emptyPageWithNext && !primed && offset === 0 && all.length > 0) {
        // An empty page that STILL carries next — the vendor's documented case.
        // `primed` marks it as already served so the walk advances past it.
        return { data: [], paging: { next: 'https://graph.facebook.com/x?offset=0&primed=1' } };
      }

      const slice = all.slice(offset, offset + world.pageSize);
      const nextOffset = offset + world.pageSize;
      const hasMore = nextOffset < all.length;
      return {
        data: slice,
        paging: hasMore ? { next: 'https://graph.facebook.com/x?offset=' + nextOffset } : {},
      };
    },
  };
}

function newAdapter(world: FakeWorld, over: Partial<{ maxPages: number; credential: FacebookPageCredential }> = {}) {
  return new FacebookPostsAdapter({
    client: makeClient(world),
    pageId: PAGE_ID,
    credential: over.credential ?? CREDENTIAL,
    pageSize: world.pageSize,
    maxPages: over.maxPages ?? 20,
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
      return publishPosts(world, count);
    },
    // NO expireCursor: the watermark is never sent to the provider (D-025), so
    // the provider cannot refuse it. The kit skips that check and SAYS it did.
    //
    // NO rateLimitOnce: this is a DECLARED SKIP under D-017, not an oversight.
    // The kit's rate-limit check asserts an adapter recovers transparently from
    // a throttle. On Meta, recovering by retrying is the one thing a client must
    // NOT do — the vendor states continuing to call "will increase the time
    // before calls will be successful again" (D-028). An adapter that passed
    // that check here would be one that deepens every throttle it meets, so the
    // honest move is to decline the check rather than patch the kit or write an
    // adapter that satisfies it.
    secret: NEVER_EMIT_MARKER,
    payloadSchema: SOCIAL_POST_SCHEMA_FIXTURE,
  };
}

/* -------------------------------------------------------------------------- */
/* Conformance                                                                */
/* -------------------------------------------------------------------------- */

describe('FacebookPostsAdapter — P-003 conformance', () => {
  it('passes the shared kit UNMODIFIED', async () => {
    const report = await runSocialAdapterConformance(harness());
    expect(report.failures.map((f) => f.check + ': ' + f.detail).join(' || ')).toBe('');
  });

  it('passes the kit when the provider serves oldest-first', async () => {
    const report = await runSocialAdapterConformance(harness({ serveOrder: 'oldest-first' }));
    expect(report.failures.map((f) => f.check + ': ' + f.detail).join(' || ')).toBe('');
  });

  it('passes the kit when a page is EMPTY but still carries next', async () => {
    const report = await runSocialAdapterConformance(harness({ emptyPageWithNext: true }));
    expect(report.failures.map((f) => f.check + ': ' + f.detail).join(' || ')).toBe('');
  });

  it('declares the cursor-expiry and rate-limit checks as SKIPPED rather than passing them silently', async () => {
    const report = await runSocialAdapterConformance(harness());
    const skipped = report.checksSkipped.map((s) => s.check);
    expect(skipped).toContain('cursor-unusable-falls-back-to-backfill');
    expect(skipped).toContain('rate-limit-is-absorbed');
  });
});

/* -------------------------------------------------------------------------- */
/* D-025 — the ranked-order control                                           */
/* -------------------------------------------------------------------------- */

describe('ranked order (D-025) — the adapter derives no control flow from position', () => {
  it('emits a NEW post that the provider buried BEHIND already-seen ones', async () => {
    const world = makeWorld({ serveOrder: 'ranked', pageSize: 2 });
    publishPosts(world, 3);

    const first = await drain(newAdapter(world), null);
    expect(first.events).toHaveLength(3);

    // A new post arrives, but the ranked order serves it LAST — behind three
    // posts that are all at or below the watermark.
    const [freshId] = publishPosts(world, 1);
    const second = await drain(newAdapter(world), first.result.cursor);

    expect(second.events.map((e) => e.externalId)).toEqual([freshId]);
    expect(second.result.emitted).toBe(1);
  });

  it('CONTROL: an early-exit implementation would have dropped that post', async () => {
    const world = makeWorld({ serveOrder: 'ranked', pageSize: 2 });
    publishPosts(world, 3);
    const first = await drain(newAdapter(world), null);
    publishPosts(world, 1);

    // Model the conventional optimisation: stop at the first item at-or-below
    // the mark. Under ranked order it stops immediately and emits nothing.
    const stored = first.result.cursor as { watermark: string };
    const served = ordered(world);
    const earlyExit: string[] = [];
    for (const p of served) {
      if (Date.parse(facebookPostEffectiveAt(p)) <= Date.parse(stored.watermark)) break;
      earlyExit.push(p.id);
    }

    expect(earlyExit).toEqual([]);

    // The real adapter does not.
    const second = await drain(newAdapter(world), first.result.cursor);
    expect(second.events).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* D-025 — pagination termination                                             */
/* -------------------------------------------------------------------------- */

describe('pagination (D-025)', () => {
  it('does NOT stop on an empty page that carries next', async () => {
    const world = makeWorld({ emptyPageWithNext: true, pageSize: 2 });
    publishPosts(world, 3);

    const { events } = await drain(newAdapter(world), null);
    expect(events).toHaveLength(3);
    // First call returned the empty primed page; the walk continued past it.
    expect(world.calls).toBeGreaterThan(1);
  });

  it('stops when next is absent', async () => {
    const world = makeWorld({ pageSize: 10 });
    publishPosts(world, 3);
    await drain(newAdapter(world), null);
    expect(world.calls).toBe(1);
  });

  it('honours maxPages as a stated bound', async () => {
    const world = makeWorld({ pageSize: 1 });
    publishPosts(world, 10);
    const { events } = await drain(newAdapter(world, { maxPages: 3 }), null);
    expect(world.calls).toBe(3);
    expect(events).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* D-027 — the credential rail                                                */
/* -------------------------------------------------------------------------- */

describe('page credential rail (D-027)', () => {
  it('refuses to read at all when the credential lacks every acceptable task', async () => {
    const world = makeWorld();
    publishPosts(world, 2);
    const weak: FacebookPageCredential = { pageId: PAGE_ID, accessToken: 't', tasks: ['ANALYZE'] };

    await expect(drain(newAdapter(world, { credential: weak }), null)).rejects.toThrow(
      FacebookPageCredentialError,
    );
  });

  it('fires BEFORE any provider call — the check cannot be a response inspection', async () => {
    const world = makeWorld();
    publishPosts(world, 2);
    const weak: FacebookPageCredential = { pageId: PAGE_ID, accessToken: 't', tasks: [] };

    await expect(drain(newAdapter(world, { credential: weak }), null)).rejects.toThrow();
    expect(world.calls).toBe(0);
  });

  it('accepts any ONE of the three acceptable feed tasks', async () => {
    for (const task of ['CREATE_CONTENT', 'MANAGE', 'MODERATE']) {
      const world = makeWorld();
      publishPosts(world, 1);
      const cred: FacebookPageCredential = { pageId: PAGE_ID, accessToken: 't', tasks: [task] };
      const { events } = await drain(newAdapter(world, { credential: cred }), null);
      expect(events).toHaveLength(1);
    }
  });

  it('refuses a credential minted for a different Page', async () => {
    const world = makeWorld();
    publishPosts(world, 1);
    const other: FacebookPageCredential = { pageId: 'other-page', accessToken: 't', tasks: ['MANAGE'] };
    await expect(drain(newAdapter(world, { credential: other }), null)).rejects.toThrow(/minted-for:other-page/);
  });
});

/* -------------------------------------------------------------------------- */
/* Watermark + path                                                           */
/* -------------------------------------------------------------------------- */

describe('watermark and declared path', () => {
  it('reports cold-start on first connect and backfill thereafter', async () => {
    const world = makeWorld();
    publishPosts(world, 2);

    const first = await drain(newAdapter(world), null);
    expect(first.result.path).toBe('cold-start');
    expect(first.result.backfillReason).toBeUndefined();

    const second = await drain(newAdapter(world), first.result.cursor);
    expect(second.result.path).toBe('backfill');
    expect(second.result.backfillReason).toBe('no-replay-supported');
  });

  it('reports backfill — NOT cold-start — for an UNREADABLE stored cursor', async () => {
    // EI-21256621031947425: reporting cold-start for a dropped cursor asserts
    // "first connect", which is false and hides the loss.
    const world = makeWorld();
    publishPosts(world, 2);
    const { result } = await drain(newAdapter(world), { watermark: 'not-a-date', boundaryIds: [] });
    expect(result.path).toBe('backfill');
    expect(result.backfillReason).toBe('cursor-rejected');
  });

  it('DISTINGUISHES a lost cursor from the routine tick — the reasons must not collapse', async () => {
    // `no-replay-supported` fires every tick, so an alert on it is noise;
    // `cursor-rejected` is rare and means persisted state was lost. Reporting
    // both identically would hide the serious one behind the routine one.
    const world = makeWorld();
    publishPosts(world, 2);
    const first = await drain(newAdapter(world), null);

    const routine = await drain(newAdapter(world), first.result.cursor);
    const lost = await drain(newAdapter(world), { watermark: 'not-a-date', boundaryIds: [] });

    expect(routine.result.backfillReason).toBe('no-replay-supported');
    expect(lost.result.backfillReason).toBe('cursor-rejected');
    expect(routine.result.backfillReason).not.toBe(lost.result.backfillReason);
  });

  it('emits nothing on an immediate second pass with no new posts', async () => {
    const world = makeWorld();
    publishPosts(world, 3);
    const first = await drain(newAdapter(world), null);
    const second = await drain(newAdapter(world), first.result.cursor);
    expect(second.events).toEqual([]);
    expect(second.result.emitted).toBe(0);
  });

  it('re-emits an EDITED post with a new dedupe key', async () => {
    const world = makeWorld();
    publishPosts(world, 1);
    const first = await drain(newAdapter(world), null);
    expect(first.events).toHaveLength(1);

    world.posts[0]!.updated_time = new Date(Date.UTC(2026, 5, 1)).toISOString();
    world.posts[0]!.message = 'edited';

    const second = await drain(newAdapter(world), first.result.cursor);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.dedupeKey).not.toBe(first.events[0]!.dedupeKey);
    expect(second.events[0]!.payload.editedAt).toBe(world.posts[0]!.updated_time);
  });
});

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

describe('normalization', () => {
  it('prefers the user-authored message', () => {
    expect(facebookPostText(post('p', '2026-01-01T00:00:00Z', { message: 'mine', story: 'generated' }))).toBe('mine');
  });

  it("falls back to Facebook's OWN story when there is no message", () => {
    const p = post('p', '2026-01-01T00:00:00Z', { message: null, story: 'Page added a photo.' });
    expect(facebookPostText(p)).toBe('Page added a photo.');
  });

  it('returns empty text — and FLAGS it — when the post genuinely carries neither', () => {
    // The canonical schema cannot represent this; the adapter surfaces it loudly
    // rather than dropping the post or inventing a caption. See the note on
    // facebookPostText: P-017 (Instagram) is where this must be settled.
    const p = post('p', '2026-01-01T00:00:00Z', { message: null, story: null });
    expect(facebookPostText(p)).toBe('');
    expect(normalizeFacebookPost(p).payload.textAbsent).toBe(true);
  });

  it('does not flag textAbsent when text is present', () => {
    expect(normalizeFacebookPost(post('p', '2026-01-01T00:00:00Z')).payload.textAbsent).toBeUndefined();
  });

  it('prefers the provider permalink and falls back to the documented URL shape', () => {
    expect(facebookPostUrl(post('p', '2026-01-01T00:00:00Z', { permalink_url: 'https://fb.com/x' }))).toBe(
      'https://fb.com/x',
    );
    expect(facebookPostUrl(post('123_456', '2026-01-01T00:00:00Z'))).toBe('https://www.facebook.com/123_456');
  });

  it('watermarks on updated_time when present, created_time otherwise', () => {
    expect(facebookPostEffectiveAt({ created_time: 'c', updated_time: 'u' })).toBe('u');
    expect(facebookPostEffectiveAt({ created_time: 'c', updated_time: null })).toBe('c');
    expect(facebookPostEffectiveAt({ created_time: 'c' })).toBe('c');
  });

  it('carries an author when the provider named one', () => {
    const p = post('p', '2026-01-01T00:00:00Z', { from: { id: '1', name: 'The Page' } });
    expect(normalizeFacebookPost(p).payload.author).toBe('The Page');
  });

  it('surfaces is_published:false, so an edge that misbehaves is visible', () => {
    const p = post('p', '2026-01-01T00:00:00Z', { is_published: false });
    expect(normalizeFacebookPost(p).payload.isPublished).toBe(false);
    expect(normalizeFacebookPost(post('q', '2026-01-01T00:00:00Z')).payload.isPublished).toBeUndefined();
  });

  it('never puts the access token in an emitted payload', async () => {
    const world = makeWorld();
    publishPosts(world, 2);
    const { events } = await drain(newAdapter(world), null);
    expect(JSON.stringify(events)).not.toContain(NEVER_EMIT_MARKER);
  });

  it('builds a dedupe key from provider facts only — stable across identical passes', async () => {
    const world = makeWorld();
    publishPosts(world, 2);
    const a = await drain(newAdapter(world), null);
    const b = await drain(newAdapter(world), null);
    expect(a.events.map((e) => e.dedupeKey)).toEqual(b.events.map((e) => e.dedupeKey));
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                               */
/* -------------------------------------------------------------------------- */

describe('cancellation', () => {
  it('honours an aborted signal mid-walk', async () => {
    const world = makeWorld({ pageSize: 1 });
    publishPosts(world, 5);
    const controller = new AbortController();
    controller.abort();

    const adapter = newAdapter(world);
    await expect(
      adapter.reconcile({ cursor: null, emit: vi.fn(), signal: controller.signal }),
    ).rejects.toThrow();
    expect(world.calls).toBe(0);
  });
});
