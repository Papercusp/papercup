/**
 * YouTube write adapter tests — P-015 stage 4.
 *
 * These assert what was SENT, not merely that a call returned. The failure this
 * guards is a duplicate reply under the owner's real identity, on a public
 * video, which no assertion about a return value can detect.
 *
 * The reply-coordinate half is tested through `resolveYouTubeReplyTarget`
 * directly. That is deliberate, not a shortcut: YouTube's registry row is
 * owner-blocked, so `resolveSocialReplyCoordinates` throws before reaching the
 * youtube branch, and a test that went through the public function would be
 * asserting the WALL rather than the derivation. Both are tested — separately,
 * and each says which one it is.
 */
import { describe, expect, it } from 'vitest';

import type { OutboundContext } from '../../capability-verbs/resolve';
import {
  resolveSocialReplyCoordinates,
  resolveYouTubeReplyTarget,
  type SocialReplyRequest,
  type SocialReplyTarget,
} from '../../capability-verbs/social';
import { SocialPlatformUnusableError } from './platform-registry';
import {
  createYouTubeWriteAdapter,
  isTerminalYouTubeWriteError,
  youtubeCommentUrl,
  YouTubeWriteError,
  YOUTUBE_COMMENT_INSERT_SCOPE,
  YOUTUBE_COMMENT_INSERT_UNITS,
  YOUTUBE_TERMINAL_WRITE_REASONS,
  type YouTubeWriteClient,
} from './youtube-write-adapter';

const CONTEXT = { accountLabel: 'papercusp@example.com' } as unknown as OutboundContext;

const TARGET: SocialReplyTarget = {
  platform: 'youtube',
  parentCommentId: 'Ugz_top_level_1',
  videoId: 'vid42',
  canReply: true,
};

interface Recorder {
  client: YouTubeWriteClient;
  inserts: { parentId: string; textOriginal: string }[];
  clientBuilds: number;
}

function recorder(over: { insert?: YouTubeWriteClient['insertComment'] } = {}): Recorder {
  const inserts: Recorder['inserts'] = [];
  let seq = 0;
  const rec: Recorder = {
    clientBuilds: 0,
    inserts,
    client: {
      async insertComment(params) {
        inserts.push({ parentId: params.parentId, textOriginal: params.textOriginal });
        if (over.insert) return over.insert(params);
        seq += 1;
        return { id: `UgzReply${seq}`, parentId: params.parentId };
      },
    },
  };
  return rec;
}

function adapterFor(rec: Recorder) {
  return createYouTubeWriteAdapter({
    async createClient() {
      rec.clientBuilds += 1;
      return rec.client;
    },
  });
}

function replyRequest(over: Partial<SocialReplyRequest> = {}): SocialReplyRequest {
  return {
    target: TARGET,
    text: 'thanks for watching',
    visibility: 'public',
    idempotencyKey: 'key-1',
    ...over,
  } as SocialReplyRequest;
}

/* -------------------------------------------------------------------------- */
/* What gets sent                                                             */
/* -------------------------------------------------------------------------- */

describe('comments.insert is called with the two required snippet fields', () => {
  it('sends parentId and textOriginal', async () => {
    const rec = recorder();
    const outcome = await adapterFor(rec).reply(replyRequest(), CONTEXT);

    expect(rec.inserts).toEqual([{ parentId: 'Ugz_top_level_1', textOriginal: 'thanks for watching' }]);
    expect(outcome.externalId).toBe('UgzReply1');
    expect(outcome.ref).toBe('youtube:UgzReply1');
    expect(outcome.url).toBe('https://www.youtube.com/watch?v=vid42&lc=UgzReply1');
  });

  it('writes textOriginal, never textDisplay', async () => {
    // textDisplay is a READ projection the server builds (it rewrites links into
    // titles), so writing to it would be writing to a rendered view.
    const rec = recorder();
    await adapterFor(rec).reply(replyRequest({ text: 'see https://example.com' }), CONTEXT);
    expect(rec.inserts[0]!.textOriginal).toBe('see https://example.com');
  });

  it('omits the url when the stored document carried no videoId', async () => {
    // A fabricated permalink that 404s is worse than none: it reads as a
    // delivery receipt.
    const rec = recorder();
    const outcome = await adapterFor(rec).reply(
      replyRequest({ target: { platform: 'youtube', parentCommentId: 'Ugz_top_level_1' } }),
      CONTEXT,
    );
    expect(outcome.url).toBeUndefined();
    expect(youtubeCommentUrl(null, 'x')).toBeUndefined();
    expect(youtubeCommentUrl('v', 'x')).toBe('https://www.youtube.com/watch?v=v&lc=x');
  });

  it('refuses a target belonging to another platform', async () => {
    const rec = recorder();
    await expect(
      adapterFor(rec).reply(
        replyRequest({ target: { platform: 'reddit', parentFullname: 't3_x', subreddit: 's' } }),
        CONTEXT,
      ),
    ).rejects.toThrow(/youtube_write_target_mismatch:reddit/);
    expect(rec.inserts).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Local refusals that save a 50-unit round trip                              */
/* -------------------------------------------------------------------------- */

describe('documented 400s are asserted locally rather than paid for', () => {
  it('refuses canReply:false instead of spending 50 units on operationNotSupported', async () => {
    // The vendor page defines operationNotSupported as the caller being unable
    // to reply, and names snippet.canReply as the remedy. The read adapter
    // already stores that flag on every payload.
    const rec = recorder();
    await expect(
      adapterFor(rec).reply(
        replyRequest({ target: { platform: 'youtube', parentCommentId: 'Ugz1', canReply: false } }),
        CONTEXT,
      ),
    ).rejects.toThrow(/youtube_reply_not_permitted:Ugz1/);
    expect(rec.inserts).toHaveLength(0);
    expect(rec.clientBuilds).toBe(0); // not even a credential fetch
  });

  it('still attempts the reply when canReply is ABSENT', async () => {
    // Refusing on absence would silently disable replies for every document
    // stored before the field existed.
    const rec = recorder();
    await adapterFor(rec).reply(
      replyRequest({ target: { platform: 'youtube', parentCommentId: 'Ugz1' } }),
      CONTEXT,
    );
    expect(rec.inserts).toHaveLength(1);
  });

  it('refuses an empty body instead of paying for commentTextRequired', async () => {
    const rec = recorder();
    await expect(adapterFor(rec).reply(replyRequest({ text: '   ' }), CONTEXT)).rejects.toThrow(
      /youtube_reply_text_empty/,
    );
    expect(rec.inserts).toHaveLength(0);
  });

  it('refuses a missing parentId instead of paying for parentIdMissing', async () => {
    const rec = recorder();
    await expect(
      adapterFor(rec).reply(replyRequest({ target: { platform: 'youtube', parentCommentId: '' } }), CONTEXT),
    ).rejects.toThrow(/youtube_reply_parent_missing/);
    expect(rec.inserts).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The double-post guard                                                      */
/* -------------------------------------------------------------------------- */

describe('the double-post guard — YouTube supplies NO idempotency of its own', () => {
  it('collapses a SEQUENTIAL retry into one insert', async () => {
    const rec = recorder();
    const adapter = adapterFor(rec);
    const first = await adapter.reply(replyRequest(), CONTEXT);
    const second = await adapter.reply(replyRequest(), CONTEXT);

    expect(rec.inserts).toHaveLength(1);
    expect(second).toEqual(first);
  });

  it('collapses a CONCURRENT retry into one insert', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rec = recorder({
      insert: async (params) => {
        await gate;
        return { id: 'UgzOnly', parentId: params.parentId };
      },
    });
    const adapter = adapterFor(rec);

    const a = adapter.reply(replyRequest(), CONTEXT);
    const b = adapter.reply(replyRequest(), CONTEXT);
    release();
    const [first, second] = await Promise.all([a, b]);

    expect(rec.inserts).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it('sends a SECOND insert for a genuinely different reply', async () => {
    // The guard must collapse retries, not distinct writes.
    const rec = recorder();
    const adapter = adapterFor(rec);
    await adapter.reply(replyRequest({ idempotencyKey: 'key-1' }), CONTEXT);
    await adapter.reply(replyRequest({ idempotencyKey: 'key-2', text: 'a different reply' }), CONTEXT);
    expect(rec.inserts).toHaveLength(2);
  });

  it('does NOT cache a failure — a retry after a transient error really retries', async () => {
    // Caching failures would turn one blip into a permanently unsendable reply.
    let attempt = 0;
    const rec = recorder({
      insert: async (params) => {
        attempt += 1;
        if (attempt === 1) throw new YouTubeWriteError(500, 'backendError');
        return { id: 'UgzAfterRetry', parentId: params.parentId };
      },
    });
    const adapter = adapterFor(rec);

    await expect(adapter.reply(replyRequest(), CONTEXT)).rejects.toThrow(/backendError/);
    const outcome = await adapter.reply(replyRequest(), CONTEXT);
    expect(outcome.externalId).toBe('UgzAfterRetry');
    expect(rec.inserts).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

describe('terminal vs retryable write errors', () => {
  it('treats the documented permanent 400s/403s/404 as terminal', () => {
    for (const reason of [
      'commentTextRequired',
      'commentTextTooLong',
      'operationNotSupported',
      'parentCommentIsPrivate',
      'parentIdMissing',
      'parentCommentNotFound',
      'ineligibleAccount',
      'forbidden',
    ]) {
      expect(isTerminalYouTubeWriteError(new YouTubeWriteError(400, reason)), reason).toBe(true);
    }
  });

  it('does NOT treat processingFailure as terminal', () => {
    // The vendor page describes it as the server being unable to process the
    // request, so a retry can legitimately succeed.
    expect(isTerminalYouTubeWriteError(new YouTubeWriteError(400, 'processingFailure'))).toBe(false);
  });

  it('defaults an UNRECOGNISED reason to non-terminal', () => {
    // An allow-list of terminal reasons costs one wasted retry on a new reason;
    // a deny-list would silently drop a reply that would have gone through.
    expect(isTerminalYouTubeWriteError(new YouTubeWriteError(400, 'someFutureReason'))).toBe(false);
    expect(isTerminalYouTubeWriteError(new Error('boom'))).toBe(false);
  });

  it('keeps the reason as a field, not only inside the message', () => {
    // A substring match against a human-readable message is how the retry
    // distinction gets lost the first time Google rewords one.
    const error = new YouTubeWriteError(403, 'forbidden', 'The request might not be properly authorized.');
    expect(error.reason).toBe('forbidden');
    expect(error.status).toBe(403);
    expect(YOUTUBE_TERMINAL_WRITE_REASONS.has(error.reason)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Facts pinned from the vendor page                                          */
/* -------------------------------------------------------------------------- */

describe('vendor facts this adapter is built on', () => {
  it('records the 50-unit call cost, which stage 5 derives a per-verb cap from', () => {
    // A cap derived from quotaUnitsPerDay alone would treat a reply as costing
    // the same as a poll — off by 50x, in the direction that spends the whole
    // day's budget in 200 replies.
    expect(YOUTUBE_COMMENT_INSERT_UNITS).toBe(50);
  });

  it('records force-ssl as the only accepted scope', () => {
    expect(YOUTUBE_COMMENT_INSERT_SCOPE).toBe('https://www.googleapis.com/auth/youtube.force-ssl');
  });

  it('declares neither post nor delete', () => {
    // comments.insert REQUIRES snippet.parentId, so it can only create a reply.
    // A missing method here means "the platform does not declare this verb",
    // which assertSocialWriteAllowed refuses before the adapter is ever reached.
    const adapter = createYouTubeWriteAdapter({ async createClient() { return recorder().client; } });
    expect(adapter.post).toBeUndefined();
    expect(adapter.delete).toBeUndefined();
    expect(adapter.platform).toBe('youtube');
  });
});

/* -------------------------------------------------------------------------- */
/* Reply coordinates                                                          */
/* -------------------------------------------------------------------------- */

describe('resolveYouTubeReplyTarget — the parent is always the TOP-LEVEL comment', () => {
  it('uses the document’s own id when it IS a top-level comment', () => {
    const target = resolveYouTubeReplyTarget({ videoId: 'vid42', canReply: true }, 'Ugz_top');
    expect(target).toEqual({ platform: 'youtube', parentCommentId: 'Ugz_top', videoId: 'vid42', canReply: true });
  });

  it('uses replyToId when the document is itself a REPLY', () => {
    // YouTube's comment model is two-level: a thread has one top-level comment
    // and a flat list of replies. Replying to a reply still addresses the
    // parent, so the reply's own id would be the wrong parentId.
    const target = resolveYouTubeReplyTarget(
      { replyToId: 'Ugz_top', videoId: 'vid42' },
      'Ugz_a_reply',
    );
    expect(target.parentCommentId).toBe('Ugz_top');
  });

  it('omits canReply entirely when the stored payload has no such field', () => {
    // Defaulting false would disable replies for every pre-existing document;
    // defaulting true would manufacture a permission the provider never granted.
    const target = resolveYouTubeReplyTarget({ videoId: 'v' }, 'Ugz_top');
    expect('canReply' in target).toBe(false);
  });

  it('carries a definite canReply:false through, so the write adapter can refuse', () => {
    expect(resolveYouTubeReplyTarget({ canReply: false }, 'Ugz_top').canReply).toBe(false);
  });

  it('ignores a non-boolean canReply rather than coercing it', () => {
    expect('canReply' in resolveYouTubeReplyTarget({ canReply: 'yes' }, 'Ugz_top')).toBe(false);
  });

  it('omits videoId rather than emitting an empty string', () => {
    expect('videoId' in resolveYouTubeReplyTarget({}, 'Ugz_top')).toBe(false);
  });

  it('refuses when there is no parent to address at all', () => {
    expect(() => resolveYouTubeReplyTarget({}, '')).toThrow(/social_reply_coordinates_missing:youtube/);
  });

  it('feeds the write adapter a target it accepts end to end', async () => {
    // The round trip the Reddit suite added after discovering that a payload can
    // look well-formed and still fail at every attempt to reply.
    const rec = recorder();
    const target = resolveYouTubeReplyTarget({ replyToId: 'Ugz_top', videoId: 'vid42', canReply: true }, 'Ugz_reply');
    const outcome = await adapterFor(rec).reply(
      { target, text: 'hello', visibility: 'public', idempotencyKey: 'k' } as SocialReplyRequest,
      CONTEXT,
    );
    expect(rec.inserts[0]!.parentId).toBe('Ugz_top');
    expect(outcome.url).toBe('https://www.youtube.com/watch?v=vid42&lc=UgzReply1');
  });
});

describe('the owner-consent wall still stands in front of all of it', () => {
  it('refuses a youtube reply at resolveSocialReplyCoordinates while the row is blockedOn', async () => {
    // This asserts the WALL, not the derivation — the two are separate tests on
    // purpose. If this ever starts passing, the owner has consented and the
    // registry row's blockedOn was cleared; the derivation above is what then
    // runs, which is why it is tested independently rather than waiting.
    // Pinned on the TYPED reason, not a loose message match: a broad regex would
    // also pass if the call blew up for some unrelated reason, which is exactly
    // how a test that proves nothing looks like a test that passes.
    let caught: unknown;
    try {
      resolveSocialReplyCoordinates({
        source: 'youtube',
        externalId: 'Ugz_top',
        payload: { videoId: 'vid42', canReply: true },
      } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SocialPlatformUnusableError);
    expect((caught as SocialPlatformUnusableError).reason).toBe('owner-blocked');
    expect((caught as SocialPlatformUnusableError).platformId).toBe('youtube');
  });
});
