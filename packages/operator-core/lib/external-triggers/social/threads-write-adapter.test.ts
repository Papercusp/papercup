/**
 * P-018 — the Threads write adapter.
 *
 * THE TESTS THAT MATTER MOST ARE THE ONES THAT WOULD PASS IF THIS FILE HAD BEEN
 * COPIED FROM ITS INSTAGRAM SIBLING. Both platforms sit under one Meta app
 * identity and one review, and their publish flows look alike, so the realistic
 * failure is not a bug invented here — it is a correct Instagram behaviour
 * carried across to a platform that does the opposite:
 *
 *   - Instagram refuses a text-only post; Threads' own worked example IS a
 *     text-only post (D-032).
 *   - Instagram normalises a reply target UP to the top-level comment because
 *     it silently re-parents; Threads honours the exact id (D-035).
 *   - Instagram's reply is ONE call; on Threads both verbs are container +
 *     publish (D-035).
 *
 * Each of those has a test that FAILS under the inherited behaviour, which is
 * the only way to pin a difference that is invisible from the code's shape.
 *
 * The second cluster is the retry semantics. Threads has no idempotency
 * mechanism, so an ungated retry publishes a second visible post — the one
 * error class here that cannot be taken back.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OutboundContext } from '../../capability-verbs/resolve';
import type { SocialReplyRequest, SocialPostRequest, SocialReplyTarget } from '../../capability-verbs/social';
import { resolveThreadsReplyTarget } from '../../capability-verbs/social';
import { ThreadsReplyNotPermitted, type ThreadsContainerStatus, type ThreadsCredential } from './threads-common';
import {
  ThreadsPublishAmbiguous,
  ThreadsWriteAdapter,
  ThreadsWriteUnconfirmed,
  type ThreadsCreateContainerRequest,
  type ThreadsWriteClient,
} from './threads-write-adapter';

const USER_ID = '17841400000000000';
const CTX = {} as OutboundContext;

const CREDENTIAL: ThreadsCredential = {
  userId: USER_ID,
  accessToken: 'TH|never-emit-this',
  scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_read_replies'],
};

interface FakeClient extends ThreadsWriteClient {
  containers: ThreadsCreateContainerRequest[];
  publishes: string[];
  statusCalls: number;
}

function makeClient(
  over: {
    publishFails?: boolean;
    publishReturnsNoId?: boolean;
    status?: ThreadsContainerStatus | null;
    publishingLimit?: unknown;
    withLimitEndpoint?: boolean;
  } = {},
): FakeClient {
  const containers: ThreadsCreateContainerRequest[] = [];
  const publishes: string[] = [];
  const client: FakeClient = {
    containers,
    publishes,
    statusCalls: 0,
    async createContainer(request) {
      containers.push(request);
      return { id: `container-${containers.length}` };
    },
    async publishContainer({ creationId }) {
      publishes.push(creationId);
      if (over.publishFails) throw new Error('network exploded');
      if (over.publishReturnsNoId) return { id: '' } as { id: string };
      return { id: `media-${publishes.length}` };
    },
    async getContainerStatus() {
      client.statusCalls += 1;
      return over.status ?? null;
    },
  };
  if (over.withLimitEndpoint) {
    client.getPublishingLimit = async () => over.publishingLimit;
  }
  return client;
}

/** A clock that advances only when the adapter sleeps, so tests are instant. */
function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

function newAdapter(client: ThreadsWriteClient, over: Partial<{ credential: ThreadsCredential }> = {}) {
  const clock = fakeClock();
  return new ThreadsWriteAdapter({
    client,
    userId: USER_ID,
    credential: over.credential ?? CREDENTIAL,
    sleep: clock.sleep,
    now: clock.now,
  });
}

const threadsTarget = (over: Partial<Extract<SocialReplyTarget, { platform: 'threads' }>> = {}) =>
  ({
    platform: 'threads' as const,
    replyToId: 'r-4',
    rootPostId: 'root-1',
    rootPostOwnerId: USER_ID,
    ...over,
  });

const replyRequest = (over: Partial<SocialReplyRequest> = {}): SocialReplyRequest => ({
  target: threadsTarget(),
  text: 'thanks!',
  visibility: 'public',
  idempotencyKey: 'key-1',
  ...over,
});

const postRequest = (over: Partial<SocialPostRequest> = {}): SocialPostRequest => ({
  destination: USER_ID,
  text: 'hello world',
  visibility: 'public',
  idempotencyKey: 'key-post-1',
  ...over,
});

/* -------------------------------------------------------------------------- */
/* D-032 — text-primary, the OPPOSITE of Instagram                            */
/* -------------------------------------------------------------------------- */

describe('post is TEXT-PRIMARY (D-032)', () => {
  it('publishes a text-only post with NO media', async () => {
    // The inherited-from-Instagram behaviour would refuse this, and it is the
    // ordinary case on Threads: "Create a media container with text only".
    const client = makeClient();
    const outcome = await newAdapter(client).post(postRequest(), CTX);

    expect(client.containers).toHaveLength(1);
    expect(client.containers[0].mediaType).toBe('TEXT');
    expect(client.containers[0].text).toBe('hello world');
    expect(outcome.externalId).toBe('media-1');
    expect(outcome.ref).toBe('threads:media-1');
  });

  it('still carries media when the caller supplies it', async () => {
    const client = makeClient();
    await newAdapter(client).post(
      postRequest({ media: [{ url: 'https://example.test/a.jpg', type: 'image' }] }),
      CTX,
    );
    expect(client.containers[0].mediaType).toBe('IMAGE');
    expect(client.containers[0].imageUrl).toBe('https://example.test/a.jpg');
  });

  it('refuses EMPTY text, which is the vendor\'s one required field for TEXT', async () => {
    const client = makeClient();
    await expect(newAdapter(client).post(postRequest({ text: '   ' }), CTX)).rejects.toThrow(/empty-text/);
    // Refused locally: no container was created, so nothing has to be cleaned up.
    expect(client.containers).toHaveLength(0);
  });

  it('refuses text over the documented 500-character limit', async () => {
    const client = makeClient();
    await expect(newAdapter(client).post(postRequest({ text: 'x'.repeat(501) }), CTX)).rejects.toThrow(
      /text-too-long/,
    );
    expect(client.containers).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* D-035 — one path, exact reply targeting                                    */
/* -------------------------------------------------------------------------- */

describe('reply takes the SAME two-step path as post (D-035)', () => {
  it('creates a container carrying reply_to_id, then publishes it', async () => {
    // Instagram's reply is ONE call. Copying that shape here would miss the
    // container step entirely.
    const client = makeClient();
    const outcome = await newAdapter(client).reply(replyRequest(), CTX);

    expect(client.containers).toHaveLength(1);
    expect(client.containers[0].replyToId).toBe('r-4');
    expect(client.containers[0].mediaType).toBe('TEXT');
    expect(client.publishes).toEqual(['container-1']);
    expect(outcome.externalId).toBe('media-1');
  });

  it('a POST carries NO reply_to_id — its absence is what makes it a root post', async () => {
    const client = makeClient();
    await newAdapter(client).post(postRequest(), CTX);
    expect(client.containers[0].replyToId).toBeUndefined();
  });

  it('addresses a nested reply EXACTLY rather than re-parenting to the root', async () => {
    // The Instagram adapter must normalise UP because that platform silently
    // re-parents. Threads honours the exact id, so normalising here would post
    // publicly in the wrong place on every nested conversation.
    const client = makeClient();
    await newAdapter(client).reply(
      replyRequest({ target: threadsTarget({ replyToId: 'deep-reply-77', rootPostId: 'root-1' }) }),
      CTX,
    );
    expect(client.containers[0].replyToId).toBe('deep-reply-77');
    expect(client.containers[0].replyToId).not.toBe('root-1');
  });

  it('the RESOLVER supplies the document\'s own id, not its parent', () => {
    // Read beside resolveInstagramReplyTarget, which does the opposite. A stored
    // reply r-9 whose parent is r-4: Instagram must reply to r-4, Threads to r-9.
    const target = resolveThreadsReplyTarget(
      { replyToId: 'r-4', subjectId: 'root-1', subjectOwnerId: USER_ID },
      'r-9',
    );
    expect(target.replyToId).toBe('r-9');
    expect(target.rootPostId).toBe('root-1');
    expect(target.rootPostOwnerId).toBe(USER_ID);
  });

  it('the resolver omits ownership when the document never recorded it', () => {
    const target = resolveThreadsReplyTarget({ subjectId: 'root-1' }, 'r-9');
    expect(target.rootPostOwnerId).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* D-039 — the ownership gate                                                 */
/* -------------------------------------------------------------------------- */

describe('the reply ownership gate refuses BEFORE the call (D-039)', () => {
  it('refuses a root post owned by someone else', async () => {
    const client = makeClient();
    await expect(
      newAdapter(client).reply(replyRequest({ target: threadsTarget({ rootPostOwnerId: 'someone-else' }) }), CTX),
    ).rejects.toThrow(ThreadsReplyNotPermitted);
    expect(client.containers).toHaveLength(0);
  });

  it('refuses an UNKNOWN owner rather than attempting', async () => {
    // Threads publishes no error code, so a provider-side refusal could not be
    // recognised — and a successful call would be a public post we did not mean.
    const client = makeClient();
    await expect(
      newAdapter(client).reply(replyRequest({ target: threadsTarget({ rootPostOwnerId: undefined }) }), CTX),
    ).rejects.toThrow(/root_owner_unknown/);
    expect(client.containers).toHaveLength(0);
  });

  it('refuses a target belonging to another platform', async () => {
    const client = makeClient();
    await expect(
      newAdapter(client).reply(
        replyRequest({ target: { platform: 'instagram', topLevelCommentId: 'c-1' } }),
        CTX,
      ),
    ).rejects.toThrow(/wrong-target-platform/);
  });

  it('refuses when threads_manage_replies is missing', async () => {
    const client = makeClient();
    await expect(
      newAdapter(client, { credential: { ...CREDENTIAL, scopes: ['threads_basic'] } }).reply(replyRequest(), CTX),
    ).rejects.toThrow(/missing_scope/);
    expect(client.containers).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Retry semantics — the double-post class                                    */
/* -------------------------------------------------------------------------- */

describe('a retried write never double-posts', () => {
  it('absorbs a repeat of the same idempotency key without calling the provider', async () => {
    const client = makeClient();
    const adapter = newAdapter(client);
    const first = await adapter.reply(replyRequest(), CTX);
    const second = await adapter.reply(replyRequest(), CTX);

    expect(second.externalId).toBe(first.externalId);
    expect(client.containers).toHaveLength(1);
    expect(client.publishes).toHaveLength(1);
  });

  it('a DIFFERENT key is a different write', async () => {
    const client = makeClient();
    const adapter = newAdapter(client);
    await adapter.reply(replyRequest({ idempotencyKey: 'a' }), CTX);
    await adapter.reply(replyRequest({ idempotencyKey: 'b' }), CTX);
    expect(client.publishes).toHaveLength(2);
  });

  it('NEVER retries the publish itself — the adapter calls it exactly once', async () => {
    // Asserted on a counter the adapter genuinely drives. A previous version of
    // this suite counted calls on a client whose own override had removed the
    // counter, so it would have read zero whether or not a retry happened.
    const client = makeClient({ publishFails: true });
    const publishSpy = vi.spyOn(client, 'publishContainer');
    await expect(newAdapter(client).reply(replyRequest(), CTX)).rejects.toThrow(ThreadsPublishAmbiguous);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(client.publishes).toHaveLength(1);
  });
});

describe('an ambiguous publish is settled by the CONTAINER, not by guessing (D-033)', () => {
  it('PUBLISHED means the post exists — retryable false', async () => {
    const client = makeClient({ publishFails: true, status: 'PUBLISHED' });
    try {
      await newAdapter(client).reply(replyRequest(), CTX);
      throw new Error('expected an ambiguous failure');
    } catch (e) {
      expect(e).toBeInstanceOf(ThreadsPublishAmbiguous);
      const err = e as ThreadsPublishAmbiguous;
      expect(err.retryable).toBe(false);
      expect(err.lastStatus).toBe('PUBLISHED');
      expect(err.message).toMatch(/do not retry/);
      expect(err.containerId).toBe('container-1');
    }
  });

  it('EXPIRED means nothing was published — retryable true', async () => {
    const client = makeClient({ publishFails: true, status: 'EXPIRED' });
    const err = await newAdapter(client)
      .reply(replyRequest(), CTX)
      .catch((e) => e as ThreadsPublishAmbiguous);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/NEW container/);
  });

  it('a publish returning no id is ambiguous too, not a silent success', async () => {
    const client = makeClient({ publishReturnsNoId: true, status: 'ERROR' });
    const err = await newAdapter(client)
      .reply(replyRequest(), CTX)
      .catch((e) => e as ThreadsPublishAmbiguous);
    expect(err).toBeInstanceOf(ThreadsPublishAmbiguous);
    expect(err.retryable).toBe(true);
  });

  it('an UNDETERMINED status stops polling at the documented 5-minute ceiling', async () => {
    // "once per minute, for no more than 5 minutes". The loop must terminate on
    // the deadline rather than spinning while the status stays IN_PROGRESS.
    const client = makeClient({ publishFails: true, status: 'IN_PROGRESS' });
    const err = await newAdapter(client)
      .reply(replyRequest(), CTX)
      .catch((e) => e as ThreadsPublishAmbiguous);
    expect(err.retryable).toBeNull();
    expect(err.message).toMatch(/park this for a human/);
    // 5 minutes at one call per minute, plus the initial probe.
    expect(client.statusCalls).toBeGreaterThan(1);
    expect(client.statusCalls).toBeLessThanOrEqual(7);
  });

  it('a probe that itself throws still surfaces the ORIGINAL ambiguity', async () => {
    // Replacing it with "the status probe failed" would discard the containerId
    // a human needs to resolve the write by hand.
    const client = makeClient({ publishFails: true });
    client.getContainerStatus = async () => {
      throw new Error('probe exploded');
    };
    const err = await newAdapter(client)
      .reply(replyRequest(), CTX)
      .catch((e) => e as ThreadsPublishAmbiguous);
    expect(err).toBeInstanceOf(ThreadsPublishAmbiguous);
    expect(err.containerId).toBe('container-1');
  });

  it('a failed write is NOT recorded in the dedupe cache', async () => {
    // Recording it would convert a recoverable failure into a permanent silent
    // drop: the retry would return the cached "success" and never send.
    const client = makeClient({ publishFails: true, status: 'EXPIRED' });
    const adapter = newAdapter(client);
    await adapter.reply(replyRequest(), CTX).catch(() => undefined);
    await adapter.reply(replyRequest(), CTX).catch(() => undefined);
    expect(client.publishes).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* D-030 — the two buckets are not fungible                                   */
/* -------------------------------------------------------------------------- */

describe('the quota pre-flight is per-verb (D-030)', () => {
  const exhaustedPosts = {
    data: [
      {
        quota_usage: 250,
        config: { quota_total: 250 },
        reply_quota_usage: 3,
        reply_config: { quota_total: 1000 },
      },
    ],
  };

  it('refuses a POST when the posts bucket is spent, without sending anything', async () => {
    const client = makeClient({ withLimitEndpoint: true, publishingLimit: exhaustedPosts });
    await expect(newAdapter(client).post(postRequest(), CTX)).rejects.toThrow(ThreadsWriteUnconfirmed);
    expect(client.containers).toHaveLength(0);
  });

  it('still allows a REPLY with the posts bucket spent', async () => {
    // 250 posts and 1,000 replies are separate rolling allowances; rationing a
    // reply against the publishing bucket would refuse writes the vendor permits.
    const client = makeClient({ withLimitEndpoint: true, publishingLimit: exhaustedPosts });
    await expect(newAdapter(client).reply(replyRequest(), CTX)).resolves.toMatchObject({ externalId: 'media-1' });
  });

  it('an UNKNOWN figure proceeds rather than halting all writing', async () => {
    const client = makeClient({ withLimitEndpoint: true, publishingLimit: { data: [{}] } });
    await expect(newAdapter(client).post(postRequest(), CTX)).resolves.toMatchObject({ externalId: 'media-1' });
  });

  it('a BROKEN pre-flight probe does not become an outage', async () => {
    const client = makeClient({ withLimitEndpoint: true });
    client.getPublishingLimit = async () => {
      throw new Error('limit endpoint down');
    };
    await expect(newAdapter(client).post(postRequest(), CTX)).resolves.toMatchObject({ externalId: 'media-1' });
  });

  it('a client with NO limit endpoint simply publishes', async () => {
    const client = makeClient();
    expect(client.getPublishingLimit).toBeUndefined();
    await expect(newAdapter(client).post(postRequest(), CTX)).resolves.toMatchObject({ externalId: 'media-1' });
  });
});

describe('the outcome carries no invented URL', () => {
  it('returns id and ref only', async () => {
    // The documented response to both calls is {"id": "..."} and nothing more.
    // `permalink` is a READ field, so an address can be fetched later; deriving
    // one from the id would invent a URL format the vendor never published.
    const outcome = await newAdapter(makeClient()).post(postRequest(), CTX);
    expect(outcome.url).toBeUndefined();
    expect(Object.keys(outcome).sort()).toEqual(['externalId', 'ref']);
  });
});
