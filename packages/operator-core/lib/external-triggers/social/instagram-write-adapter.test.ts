/**
 * Tests for the Instagram WRITE adapter — P-017.
 *
 * THE THEME IS THAT THE TWO-STEP PUBLISH BUYS SOMETHING, and these tests are
 * where that claim is either true or empty. Pages' single-call create leaves an
 * ambiguous publish permanently unknowable; Instagram's container carries a
 * `status_code` that answers the question the failed call could not. So the
 * ambiguity cases are tested as a CASE ANALYSIS with each branch pinned
 * separately — PUBLISHED means do-not-retry, FINISHED means a retry is safe, an
 * unreadable probe means the ambiguity stands — because collapsing any two of
 * those is exactly how one intended post becomes two public ones, or none.
 *
 * The second theme is the asymmetry the generic contract does not express:
 * Instagram is MEDIA-PRIMARY. A text-only request is refused, and that refusal
 * is asserted here rather than left as an implementation detail, because it is
 * the difference between an adapter that cannot post and one that posts
 * something nobody asked for.
 */
import { describe, expect, it } from 'vitest';
import type { OutboundContext } from '../../capability-verbs/resolve';
import {
  resolveInstagramReplyTarget,
  resolveSocialReplyCoordinates,
  type SocialPostRequest,
  type SocialReplyRequest,
} from '../../capability-verbs/social';
import { SocialPlatformUnusableError, getSocialPlatform } from './platform-registry';
import { InstagramCredentialError, type InstagramCredential } from './instagram-common';
import {
  INSTAGRAM_CONTAINER_POLL_INTERVAL_MS,
  INSTAGRAM_CONTAINER_POLL_MAX_MS,
  InstagramPublishAmbiguous,
  InstagramWriteAdapter,
  InstagramWriteUnconfirmed,
  inMemoryInstagramWriteDedupe,
  isInstagramContainerStatus,
  type InstagramContainerStatus,
  type InstagramCreateContainerRequest,
  type InstagramCreateReplyRequest,
  type InstagramPublishContainerRequest,
  type InstagramWriteClient,
} from './instagram-write-adapter';

const IG_USER_ID = 'ig-17841400000000000';

const CREDENTIAL: InstagramCredential = {
  igUserId: IG_USER_ID,
  pageId: 'page-1',
  accessToken: 'ig-token',
  scopes: ['instagram_basic', 'instagram_manage_comments', 'instagram_content_publish'],
};

const CONTEXT = {} as OutboundContext;

interface Calls {
  replies: InstagramCreateReplyRequest[];
  containers: InstagramCreateContainerRequest[];
  publishes: InstagramPublishContainerRequest[];
  statuses: string[];
  slept: number[];
}

interface Harness {
  client: InstagramWriteClient;
  calls: Calls;
  adapter: InstagramWriteAdapter;
}

/**
 * `statuses` is a QUEUE, one entry consumed per probe, so a test can model a
 * container that is IN_PROGRESS and then FINISHED without a timer. The last
 * entry repeats once the queue drains, which keeps the common single-status
 * case a one-element array rather than a padded one.
 */
function harness(
  over: Partial<InstagramWriteClient> = {},
  options: { statuses?: InstagramContainerStatus[]; credential?: InstagramCredential } = {},
): Harness {
  const calls: Calls = { replies: [], containers: [], publishes: [], statuses: [], slept: [] };
  const queue = [...(options.statuses ?? ['FINISHED'])];

  const client: InstagramWriteClient = {
    async createReply(request) {
      calls.replies.push(request);
      return { id: '17873440459141021' };
    },
    async createContainer(request) {
      calls.containers.push(request);
      return { id: 'container-1' };
    },
    async publishContainer(request) {
      calls.publishes.push(request);
      return { id: 'media-9001' };
    },
    async containerStatus(request) {
      calls.statuses.push(request.containerId);
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return { status_code: next };
    },
    ...over,
  };

  // A virtual clock: `sleep` advances it rather than waiting, so the vendor's
  // real 60s/5min constants stay in the code under test instead of being tuned
  // down to something a test can tolerate — which would stop modelling the
  // documented behaviour.
  let clock = 0;
  const adapter = new InstagramWriteAdapter({
    client,
    igUserId: IG_USER_ID,
    credential: options.credential ?? CREDENTIAL,
    dedupe: inMemoryInstagramWriteDedupe(),
    sleep: async (ms) => {
      calls.slept.push(ms);
      clock += ms;
    },
    now: () => clock,
  });

  return { client, calls, adapter };
}

function replyRequest(over: Partial<SocialReplyRequest> = {}): SocialReplyRequest {
  return {
    target: { platform: 'instagram', topLevelCommentId: 'comment-top-1' },
    text: 'thanks for looking',
    visibility: 'public',
    idempotencyKey: 'key-reply-1',
    ...over,
  } as SocialReplyRequest;
}

function postRequest(over: Partial<SocialPostRequest> = {}): SocialPostRequest {
  return {
    destination: IG_USER_ID,
    text: 'a caption',
    visibility: 'public',
    idempotencyKey: 'key-post-1',
    media: [{ url: 'https://cdn.example/photo.jpg', type: 'image' }],
    ...over,
  } as SocialPostRequest;
}

/* -------------------------------------------------------------------------- */
/* Reply                                                                      */
/* -------------------------------------------------------------------------- */

describe('reply', () => {
  it('creates a reply in ONE call and mints the ref from the SERVER-returned id (D-008)', async () => {
    const { adapter, calls } = harness();
    const outcome = await adapter.reply(replyRequest(), CONTEXT);

    expect(calls.replies).toHaveLength(1);
    expect(calls.replies[0]!.commentId).toBe('comment-top-1');
    expect(calls.replies[0]!.message).toBe('thanks for looking');
    expect(outcome.externalId).toBe('17873440459141021');
    expect(outcome.ref).toBe('instagram:17873440459141021');
  });

  it('reports NO url, because the edge documents an id-only response', async () => {
    // A verified ABSENCE, not an unimplemented field. Pages documents
    // read-after-write and this edge documents `{"id": "..."}`; there is no
    // documented permalink form for a comment id to assemble a URL from. An
    // invented URL would be shown to someone and would resolve to nothing.
    const { adapter } = harness();
    const outcome = await adapter.reply(replyRequest(), CONTEXT);
    expect(outcome.url).toBeUndefined();
    expect(Object.keys(outcome).sort()).toEqual(['externalId', 'ref']);
  });

  it('requires instagram_manage_comments BEFORE the call (D-027)', async () => {
    const weak: InstagramCredential = { ...CREDENTIAL, scopes: ['instagram_basic'] };
    const { adapter, calls } = harness({}, { credential: weak });
    await expect(adapter.reply(replyRequest(), CONTEXT)).rejects.toThrow(InstagramCredentialError);
    expect(calls.replies).toHaveLength(0);
  });

  it('refuses a target belonging to ANOTHER platform rather than duck-typing an id out of it', async () => {
    const { adapter, calls } = harness();
    const foreign = replyRequest({
      target: { platform: 'facebook-pages', objectId: 'page-1_100' },
    });
    await expect(adapter.reply(foreign, CONTEXT)).rejects.toThrow(/wrong-platform-target:facebook-pages/);
    expect(calls.replies).toHaveLength(0);
  });

  it('refuses a DEFINITELY hidden comment — "You cannot reply to hidden comments"', async () => {
    const { adapter, calls } = harness();
    const hidden = replyRequest({
      target: { platform: 'instagram', topLevelCommentId: 'comment-top-1', hidden: true },
    });
    await expect(adapter.reply(hidden, CONTEXT)).rejects.toThrow(/hidden-comment:comment-top-1/);
    expect(calls.replies).toHaveLength(0);
  });

  it('still attempts when hidden is ABSENT — a missing flag is a gap, not a denial', async () => {
    const { adapter, calls } = harness();
    await adapter.reply(replyRequest(), CONTEXT);
    expect(calls.replies).toHaveLength(1);
  });

  it('refuses an empty message locally — it is the edge\'s one required parameter', async () => {
    const { adapter, calls } = harness();
    await expect(adapter.reply(replyRequest({ text: '   ' }), CONTEXT)).rejects.toThrow(
      InstagramWriteUnconfirmed,
    );
    expect(calls.replies).toHaveLength(0);
  });

  it('returns the FIRST result for a repeated idempotency key instead of creating a second comment', async () => {
    const { adapter, calls } = harness();
    const first = await adapter.reply(replyRequest(), CONTEXT);
    const second = await adapter.reply(replyRequest(), CONTEXT);
    expect(second).toEqual(first);
    expect(calls.replies).toHaveLength(1);
  });

  it('refuses a response with no id rather than reporting an unaddressable success', async () => {
    const { adapter } = harness({ async createReply() { return {}; } });
    await expect(adapter.reply(replyRequest(), CONTEXT)).rejects.toThrow(/no-id-in-response/);
  });
});

/* -------------------------------------------------------------------------- */
/* The top-level re-parenting rule                                            */
/* -------------------------------------------------------------------------- */

describe('reply targets resolve to the TOP-LEVEL comment', () => {
  // The vendor does not refuse a reply aimed at a reply — it re-parents it and
  // returns a normal success. So this derivation is the only place the intended
  // and actual targets can be made to agree, and these tests are what make that
  // claim checkable while the platform itself is still walled.

  it('uses the stored replyToId (the vendor parent_id), NOT the reply\'s own id', async () => {
    const target = resolveInstagramReplyTarget({ replyToId: 'comment-top-1' }, 'comment-reply-7');
    expect(target.topLevelCommentId).toBe('comment-top-1');
  });

  it('uses the document\'s own id when it has no parent — that document IS top-level', async () => {
    const target = resolveInstagramReplyTarget({}, 'comment-top-1');
    expect(target.topLevelCommentId).toBe('comment-top-1');
  });

  it('carries mediaId from subjectId, matching what the comments adapter writes', async () => {
    const target = resolveInstagramReplyTarget({ subjectId: 'media-42' }, 'comment-top-1');
    expect(target.mediaId).toBe('media-42');
  });

  it('carries hidden ONLY when it is a definite boolean', async () => {
    expect(resolveInstagramReplyTarget({}, 'c1').hidden).toBeUndefined();
    expect(resolveInstagramReplyTarget({ hidden: true }, 'c1').hidden).toBe(true);
    expect(resolveInstagramReplyTarget({ hidden: false }, 'c1').hidden).toBe(false);
    // A non-boolean is NOT coerced: 'true' as a string would otherwise become a
    // refusal manufactured out of a type error.
    expect(resolveInstagramReplyTarget({ hidden: 'true' }, 'c1').hidden).toBeUndefined();
  });

  it('refuses when the document carries neither a parent nor an id', async () => {
    expect(() => resolveInstagramReplyTarget({}, '')).toThrow(/social_reply_coordinates_missing:instagram/);
  });

  it('takes nothing from a payload field a hostile document might add', async () => {
    const injected = resolveInstagramReplyTarget(
      { replyToId: 'comment-top-1', platform: 'reddit', topLevelCommentId: 'evil', accessToken: 'evil' },
      'comment-reply-7',
    );
    expect(injected.platform).toBe('instagram');
    expect(injected.topLevelCommentId).toBe('comment-top-1');
    expect(JSON.stringify(injected)).not.toContain('evil');
  });
});

describe('the app-review wall still stands in front of all of it', () => {
  it('refuses an instagram reply at resolveSocialReplyCoordinates while the row is blockedOn', async () => {
    // Asserts the WALL, not the derivation — separate tests on purpose, and
    // pinned on the TYPED reason so it cannot pass because of some unrelated
    // failure. If this starts failing, Meta app review landed and the
    // derivation above is what then runs.
    let caught: unknown;
    try {
      resolveSocialReplyCoordinates({
        source: 'instagram',
        externalId: 'comment-top-1',
        payload: { subjectId: 'media-42' },
      } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SocialPlatformUnusableError);
    expect((caught as SocialPlatformUnusableError).reason).toBe('owner-blocked');
    expect((caught as SocialPlatformUnusableError).platformId).toBe('instagram');
  });
});

/* -------------------------------------------------------------------------- */
/* Post — the happy path and its shape                                        */
/* -------------------------------------------------------------------------- */

describe('post', () => {
  it('creates a container and THEN publishes it, carrying the container id as creation_id', async () => {
    const { adapter, calls } = harness();
    const outcome = await adapter.post(postRequest(), CONTEXT);

    expect(calls.containers).toHaveLength(1);
    expect(calls.publishes).toHaveLength(1);
    expect(calls.publishes[0]!.creationId).toBe('container-1');
    expect(outcome.externalId).toBe('media-9001');
    expect(outcome.ref).toBe('instagram:media-9001');
  });

  it('probes the container BEFORE publishing', async () => {
    // Not defensive padding: publishing an IN_PROGRESS container fails, and a
    // failed publish is the ambiguous state the whole design exists to avoid.
    // It is affordable because the publishing cap is enforced on media_publish
    // alone, so the probe spends call budget and never publishing quota.
    const { adapter, calls } = harness();
    await adapter.post(postRequest(), CONTEXT);
    expect(calls.statuses).toEqual(['container-1']);
  });

  it('sends image_url and NO media_type for an image', async () => {
    const { adapter, calls } = harness();
    await adapter.post(postRequest(), CONTEXT);
    expect(calls.containers[0]!.imageUrl).toBe('https://cdn.example/photo.jpg');
    expect(calls.containers[0]!.videoUrl).toBeUndefined();
    expect(calls.containers[0]!.mediaType).toBeUndefined();
  });

  it('sends video_url WITH media_type VIDEO for a video', async () => {
    const { adapter, calls } = harness();
    await adapter.post(
      postRequest({ media: [{ url: 'https://cdn.example/clip.mp4', type: 'video' }] }),
      CONTEXT,
    );
    expect(calls.containers[0]!.videoUrl).toBe('https://cdn.example/clip.mp4');
    expect(calls.containers[0]!.imageUrl).toBeUndefined();
    expect(calls.containers[0]!.mediaType).toBe('VIDEO');
  });

  it('carries the text as the caption, and omits the caption entirely when there is none', async () => {
    const { adapter, calls } = harness();
    await adapter.post(postRequest(), CONTEXT);
    expect(calls.containers[0]!.caption).toBe('a caption');

    const blank = harness();
    await blank.adapter.post(postRequest({ text: '  ', idempotencyKey: 'k2' }), CONTEXT);
    // Caption-less posts are legal on Instagram, so an empty text is NOT an
    // error here — unlike Pages, where "either link or message must be supplied".
    expect(blank.calls.containers[0]!.caption).toBeUndefined();
    expect(blank.calls.publishes).toHaveLength(1);
  });

  it('requires instagram_content_publish BEFORE any call', async () => {
    const weak: InstagramCredential = { ...CREDENTIAL, scopes: ['instagram_basic', 'instagram_manage_comments'] };
    const { adapter, calls } = harness({}, { credential: weak });
    await expect(adapter.post(postRequest(), CONTEXT)).rejects.toThrow(InstagramCredentialError);
    expect(calls.containers).toHaveLength(0);
  });

  it('refuses a destination that is not this adapter\'s account', async () => {
    const { adapter, calls } = harness();
    await expect(adapter.post(postRequest({ destination: 'ig-someone-else' }), CONTEXT)).rejects.toThrow(
      /destination-mismatch/,
    );
    expect(calls.containers).toHaveLength(0);
  });

  it('returns the FIRST result for a repeated idempotency key instead of publishing twice', async () => {
    const { adapter, calls } = harness();
    const first = await adapter.post(postRequest(), CONTEXT);
    const second = await adapter.post(postRequest(), CONTEXT);
    expect(second).toEqual(first);
    expect(calls.publishes).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Post — the media-primary asymmetry                                         */
/* -------------------------------------------------------------------------- */

describe('media is REQUIRED, because Instagram has no text-only feed post', () => {
  it('refuses a text-only request and says why', async () => {
    const { adapter, calls } = harness();
    const textOnly = postRequest({ media: undefined });
    await expect(adapter.post(textOnly, CONTEXT)).rejects.toThrow(/media-required/);
    // Nothing was attempted — the refusal is local, so no call is spent being
    // told what the documentation already says.
    expect(calls.containers).toHaveLength(0);
  });

  it('refuses an EMPTY media array for the same reason', async () => {
    const { adapter } = harness();
    await expect(adapter.post(postRequest({ media: [] }), CONTEXT)).rejects.toThrow(/media-required/);
  });

  it('refuses a carousel EXPLICITLY rather than silently posting only the first item', async () => {
    // Dropping the second image while reporting success would be the failure
    // mode: the caller supplied content that never went out and nothing said so.
    const { adapter, calls } = harness();
    const carousel = postRequest({
      media: [
        { url: 'https://cdn.example/a.jpg', type: 'image' },
        { url: 'https://cdn.example/b.jpg', type: 'image' },
      ],
    });
    await expect(adapter.post(carousel, CONTEXT)).rejects.toThrow(/carousel-unsupported: 2 media/);
    expect(calls.containers).toHaveLength(0);
  });

  it('refuses a media entry with a blank url', async () => {
    const { adapter } = harness();
    await expect(
      adapter.post(postRequest({ media: [{ url: '   ', type: 'image' }] }), CONTEXT),
    ).rejects.toThrow(/media-url-empty/);
  });
});

/* -------------------------------------------------------------------------- */
/* Post — waiting for the container                                           */
/* -------------------------------------------------------------------------- */

describe('container readiness', () => {
  it('polls at the vendor cadence until FINISHED, then publishes', async () => {
    const { adapter, calls } = harness({}, { statuses: ['IN_PROGRESS', 'IN_PROGRESS', 'FINISHED'] });
    await adapter.post(postRequest(), CONTEXT);

    expect(calls.statuses).toHaveLength(3);
    // "once per minute" — every wait is the documented interval, not a backoff
    // we invented.
    expect(calls.slept).toEqual([INSTAGRAM_CONTAINER_POLL_INTERVAL_MS, INSTAGRAM_CONTAINER_POLL_INTERVAL_MS]);
    expect(calls.publishes).toHaveLength(1);
  });

  it('checks IMMEDIATELY first, so an already-ready container costs no wait', async () => {
    const { adapter, calls } = harness();
    await adapter.post(postRequest(), CONTEXT);
    expect(calls.slept).toEqual([]);
  });

  it('gives up after the vendor\'s 5 minutes WITHOUT publishing, and reports it as unconfirmed', async () => {
    const { adapter, calls } = harness({}, { statuses: ['IN_PROGRESS'] });
    const error = await adapter.post(postRequest(), CONTEXT).catch((e) => e);

    expect(error).toBeInstanceOf(InstagramWriteUnconfirmed);
    // Unconfirmed, NOT ambiguous: nothing was published, so there is no risk of
    // a duplicate and the caller is entitled to a definite answer.
    expect(error).not.toBeInstanceOf(InstagramPublishAmbiguous);
    expect(String(error)).toContain('container-not-ready');
    // The container id survives the error: it stays publishable for 24 hours.
    expect(String(error)).toContain('container-1');
    expect(calls.publishes).toHaveLength(0);
    // Never waits past the documented ceiling.
    const totalSlept = calls.slept.reduce((a, b) => a + b, 0);
    expect(totalSlept).toBeLessThanOrEqual(INSTAGRAM_CONTAINER_POLL_MAX_MS);
  });

  it('treats ERROR as a definite failure and does not publish', async () => {
    const { adapter, calls } = harness({}, { statuses: ['ERROR'] });
    await expect(adapter.post(postRequest(), CONTEXT)).rejects.toThrow(/container-error:container-1/);
    expect(calls.publishes).toHaveLength(0);
  });

  it('treats EXPIRED as a definite failure and does not publish', async () => {
    const { adapter, calls } = harness({}, { statuses: ['EXPIRED'] });
    await expect(adapter.post(postRequest(), CONTEXT)).rejects.toThrow(/container-expired:container-1/);
    expect(calls.publishes).toHaveLength(0);
  });

  it('refuses an unrecognised status_code instead of falling through a branch', async () => {
    const { adapter, calls } = harness({
      async containerStatus() {
        return { status_code: 'SOMETHING_NEW' };
      },
    });
    await expect(adapter.post(postRequest(), CONTEXT)).rejects.toThrow(/unrecognised-status_code/);
    expect(calls.publishes).toHaveLength(0);
  });

  it('refuses a container response with no id — nothing publishable was created', async () => {
    const { adapter, calls } = harness({ async createContainer() { return {}; } });
    await expect(adapter.post(postRequest(), CONTEXT)).rejects.toThrow(/no-container-id-in-response/);
    expect(calls.publishes).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Post — the ambiguity case analysis                                         */
/* -------------------------------------------------------------------------- */

describe('an ambiguous publish is resolved by the container, not guessed', () => {
  function failingPublish(statuses: InstagramContainerStatus[]) {
    // ⚠ THE RECORDING IS THE POINT, and getting it wrong made this suite lie
    // once already. An override that only threw removed the very counter the
    // "never retries" assertion reads, so that assertion saw zero calls whether
    // or not a retry happened — a test that could not fail. The attempt is
    // counted FIRST and the throw models the failure to REPORT, which is the
    // dangerous case: the call may or may not have acted.
    const h = harness({}, { statuses: ['FINISHED', ...statuses] });
    const client = h.client as { publishContainer: InstagramWriteClient['publishContainer'] };
    client.publishContainer = async (request) => {
      h.calls.publishes.push(request);
      throw new Error('socket hang up ' + request.creationId);
    };
    return h;
  }

  it('PUBLISHED ⇒ the post EXISTS: retry is UNSAFE', async () => {
    // The case Pages cannot detect at all, and the reason the extra call is
    // worth paying for.
    const { adapter } = failingPublish(['PUBLISHED']);
    const error = await adapter.post(postRequest(), CONTEXT).catch((e) => e);

    expect(error).toBeInstanceOf(InstagramPublishAmbiguous);
    expect((error as InstagramPublishAmbiguous).retrySafe).toBe(false);
    expect((error as InstagramPublishAmbiguous).observedStatus).toBe('PUBLISHED');
    expect((error as InstagramPublishAmbiguous).containerId).toBe('container-1');
  });

  it('FINISHED ⇒ nothing went out: retry IS safe', async () => {
    const { adapter } = failingPublish(['FINISHED']);
    const error = await adapter.post(postRequest(), CONTEXT).catch((e) => e);

    expect(error).toBeInstanceOf(InstagramPublishAmbiguous);
    expect((error as InstagramPublishAmbiguous).retrySafe).toBe(true);
    expect((error as InstagramPublishAmbiguous).observedStatus).toBe('FINISHED');
  });

  it('IN_PROGRESS ⇒ genuinely unresolved: retrySafe stays NULL rather than defaulting', async () => {
    // Neither answer is available, and both defaults are harmful — true
    // duplicates a post, false silently drops one. Null is the honest value.
    const { adapter } = failingPublish(['IN_PROGRESS']);
    const error = await adapter.post(postRequest(), CONTEXT).catch((e) => e);

    expect(error).toBeInstanceOf(InstagramPublishAmbiguous);
    expect((error as InstagramPublishAmbiguous).retrySafe).toBeNull();
    expect((error as InstagramPublishAmbiguous).observedStatus).toBe('IN_PROGRESS');
  });

  it('a FAILING probe leaves the original ambiguity standing, and never masks it', async () => {
    let probes = 0;
    const { adapter } = harness({
      async containerStatus(request) {
        probes += 1;
        if (probes === 1) return { status_code: 'FINISHED' as const };
        throw new Error('probe unreachable');
      },
      async publishContainer() {
        throw new Error('socket hang up');
      },
    });
    const error = await adapter.post(postRequest(), CONTEXT).catch((e) => e);

    expect(error).toBeInstanceOf(InstagramPublishAmbiguous);
    expect((error as InstagramPublishAmbiguous).retrySafe).toBeNull();
    expect((error as InstagramPublishAmbiguous).observedStatus).toBeNull();
    // The ORIGINAL failure is what the caller needs; a diagnostic that failed
    // must not replace the thing it was diagnosing.
    expect(String(error)).toContain('socket hang up');
  });

  it('a publish response with NO id is ambiguous, not a definite failure', async () => {
    // The trap this pins: a response that arrived but carries no id feels like a
    // failure, and treating it as one invites the retry that duplicates a post.
    // Epistemically it is identical to a timeout.
    const { adapter } = harness(
      { async publishContainer() { return {}; } },
      { statuses: ['FINISHED', 'PUBLISHED'] },
    );
    const error = await adapter.post(postRequest(), CONTEXT).catch((e) => e);

    expect(error).toBeInstanceOf(InstagramPublishAmbiguous);
    expect((error as InstagramPublishAmbiguous).retrySafe).toBe(false);
    expect(String(error)).toContain('no-media-id-in-response');
  });

  it('NEVER retries the publish on its own, whatever the container says', async () => {
    // The single most important negative assertion in this file. With no
    // idempotency mechanism, an adapter-initiated retry is how one intended post
    // becomes two public ones — so "a retry would be safe" is reported to the
    // caller and acted on by nobody here.
    const { adapter, calls } = failingPublish(['FINISHED']);
    await adapter.post(postRequest(), CONTEXT).catch(() => undefined);
    expect(calls.publishes).toHaveLength(1);
  });

  it('does not record a dedupe entry for an unconfirmed write', async () => {
    // Recording one would make a later legitimate retry silently return a ref to
    // a post that may not exist.
    const { adapter, calls } = failingPublish(['FINISHED']);
    await adapter.post(postRequest(), CONTEXT).catch(() => undefined);
    await adapter.post(postRequest(), CONTEXT).catch(() => undefined);
    expect(calls.containers).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The status enum itself                                                     */
/* -------------------------------------------------------------------------- */

describe('the container status enum is the vendor\'s, exactly', () => {
  it('accepts the five documented values and nothing else', () => {
    for (const value of ['EXPIRED', 'ERROR', 'FINISHED', 'IN_PROGRESS', 'PUBLISHED']) {
      expect(isInstagramContainerStatus(value)).toBe(true);
    }
    for (const value of ['finished', 'OK', '', null, undefined, 0, {}]) {
      expect(isInstagramContainerStatus(value)).toBe(false);
    }
  });

  it('never requests the PHANTOM singular permission the /replies edge names (D-024)', () => {
    // The edge reference lists `page_read_engagement` among its required
    // permissions. The permissions reference has no such entry — the real one is
    // the plural `pages_read_engagement`. This pins the correction so a future
    // reader copying scopes off that edge page cannot reintroduce it, and it is
    // a POSITIVE-AND-NEGATIVE pair on purpose: asserting only the absence would
    // also pass if the scopes list were empty, which is a different bug wearing
    // the same green.
    const scopes = getSocialPlatform('instagram')!.auth.scopes;
    expect(scopes).toContain('pages_read_engagement');
    expect(scopes).not.toContain('page_read_engagement');
  });

  it('cites the /replies EDGE page, not just the parent comment node (D-031)', () => {
    // Both the phantom permission above and the top-level re-parenting rule are
    // stated ONLY on the edge page. Citing the node alone is how this item got
    // the registry row wrong twice.
    expect(getSocialPlatform('instagram')!.sources).toContain(
      'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies/',
    );
  });

  it('pins the vendor\'s stated polling cadence and ceiling', () => {
    // "We recommend querying a container's status once per minute, for no more
    // than 5 minutes." Quoted, not tuned — a faster poll spends the call budget
    // the storm policy rations.
    expect(INSTAGRAM_CONTAINER_POLL_INTERVAL_MS).toBe(60_000);
    expect(INSTAGRAM_CONTAINER_POLL_MAX_MS).toBe(300_000);
  });
});
