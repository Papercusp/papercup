/**
 * P-018 — Threads shared concerns.
 *
 * The cases that carry weight here are the two GATES, because both protect
 * against a failure the provider will not report. Threads documents no error
 * codes at all, so a missing scope and an unowned root post both produce
 * outcomes that are indistinguishable from success or from an empty account
 * once the call has gone out. Every assertion below is therefore about
 * refusing BEFORE the call, and each is paired with a control showing what the
 * permissive alternative would have allowed through.
 */
import { describe, expect, it } from 'vitest';
import {
  assertThreadsCredential,
  assertThreadsMayReply,
  isThreadsCredential,
  parseThreadsPublishingLimit,
  threadsGraphUrl,
  threadsHasQuotaFor,
  threadsPublishRetryable,
  ThreadsCredentialError,
  ThreadsReplyNotPermitted,
  THREADS_CONTAINER_TTL_MS,
  THREADS_CONTAINER_SETTLE_MS,
  THREADS_GRAPH_ORIGIN,
  THREADS_SCOPE_MANAGE_REPLIES,
  THREADS_SCOPE_READ_REPLIES,
  type ThreadsCredential,
} from './threads-common';

const USER_ID = '17841400000000000';
const CREDENTIAL: ThreadsCredential = {
  userId: USER_ID,
  accessToken: 'TH|never-emit-this',
  scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_replies', 'threads_read_replies'],
};

describe('the host is a THIRD one, not a Facebook or Instagram host', () => {
  it('builds URLs against graph.threads.net at v1.0', () => {
    expect(threadsGraphUrl('/me/threads')).toBe('https://graph.threads.net/v1.0/me/threads');
    expect(threadsGraphUrl('me/threads')).toBe('https://graph.threads.net/v1.0/me/threads');
  });

  it('is NOT graph.facebook.com — the mistake a shared Meta app identity invites', () => {
    expect(THREADS_GRAPH_ORIGIN).not.toContain('facebook.com');
    expect(THREADS_GRAPH_ORIGIN).not.toContain('instagram.com');
    expect(threadsGraphUrl('/me/threads')).not.toContain('facebook');
  });
});

describe('assertThreadsCredential — the D-027 rail', () => {
  it('accepts a well-formed credential holding the scope', () => {
    expect(() => assertThreadsCredential(CREDENTIAL, USER_ID, THREADS_SCOPE_READ_REPLIES)).not.toThrow();
  });

  it('REFUSES a credential missing threads_read_replies', () => {
    // The scope the Threads OVERVIEW never names. Building from that page yields
    // exactly this credential, and the call it would have made returns EMPTY
    // rather than erroring — "this profile has no replies", forever.
    const withoutReadReplies: ThreadsCredential = {
      ...CREDENTIAL,
      scopes: ['threads_basic', 'threads_content_publish', 'threads_manage_replies'],
    };
    expect(() => assertThreadsCredential(withoutReadReplies, USER_ID, THREADS_SCOPE_READ_REPLIES)).toThrow(
      ThreadsCredentialError,
    );
    try {
      assertThreadsCredential(withoutReadReplies, USER_ID, THREADS_SCOPE_READ_REPLIES);
    } catch (e) {
      expect((e as ThreadsCredentialError).missingScope).toBe(THREADS_SCOPE_READ_REPLIES);
    }
  });

  it('CONTROL: a permissive check would have let that call through as healthy', () => {
    const withoutReadReplies = { ...CREDENTIAL, scopes: ['threads_basic'] };
    // What "just make the call and see" gets you: a credential that looks fine.
    expect(isThreadsCredential(withoutReadReplies)).toBe(true);
    // ...and the pre-call assertion is the only thing that separates the two.
    expect(() => assertThreadsCredential(withoutReadReplies, USER_ID, THREADS_SCOPE_READ_REPLIES)).toThrow();
  });

  it('refuses a credential for a DIFFERENT account', () => {
    expect(() => assertThreadsCredential(CREDENTIAL, 'someone-else', THREADS_SCOPE_READ_REPLIES)).toThrow(
      /wrong_account/,
    );
  });

  it('refuses a malformed credential', () => {
    expect(() => assertThreadsCredential({ userId: USER_ID }, USER_ID, THREADS_SCOPE_READ_REPLIES)).toThrow(
      /malformed/,
    );
    expect(() => assertThreadsCredential(null, USER_ID, THREADS_SCOPE_READ_REPLIES)).toThrow(/malformed/);
  });
});

describe('assertThreadsMayReply — the D-039 ownership gate', () => {
  it('permits replying under a root post this profile OWNS', () => {
    expect(() => assertThreadsMayReply(CREDENTIAL, USER_ID)).not.toThrow();
  });

  it('REFUSES replying under someone else\'s root post', () => {
    // "You are the owner of the root thread post" OR threads_keyword_search /
    // threads_manage_mentions. Holding threads_manage_replies — which this
    // credential does — satisfies neither branch.
    expect(CREDENTIAL.scopes).toContain(THREADS_SCOPE_MANAGE_REPLIES);
    expect(() => assertThreadsMayReply(CREDENTIAL, 'someone-else')).toThrow(ThreadsReplyNotPermitted);
  });

  it('REFUSES an UNKNOWN owner rather than assuming it is ours', () => {
    // The posture is deliberately the opposite of the canReply/canComment flags
    // on other platforms: those are permissions the provider affirmatively
    // DENIED, so absent means "not reported" and attempting is right. This is a
    // precondition we must ESTABLISH, so absent means "unknown" — and attempting
    // on an unknown publishes a public reply on the strength of a guess.
    expect(() => assertThreadsMayReply(CREDENTIAL, null)).toThrow(/root_owner_unknown/);
    expect(() => assertThreadsMayReply(CREDENTIAL, undefined)).toThrow(/root_owner_unknown/);
    expect(() => assertThreadsMayReply(CREDENTIAL, '')).toThrow(/root_owner_unknown/);
  });

  it('the refusal NAMES what would lift it, so it is actionable', () => {
    try {
      assertThreadsMayReply(CREDENTIAL, 'someone-else');
      throw new Error('expected a refusal');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('threads_keyword_search');
      expect(msg).toContain('threads_manage_mentions');
      expect((e as ThreadsReplyNotPermitted).rootPostOwnerId).toBe('someone-else');
    }
  });

  it('a profile HOLDING threads_manage_mentions may reply to an unowned root', () => {
    // The other branch of the vendor's OR. Not requested by this integration,
    // but the gate must implement the rule rather than a subset of it — an
    // ownership-only check would be wrong the moment the scope is granted.
    const mentions: ThreadsCredential = { ...CREDENTIAL, scopes: [...CREDENTIAL.scopes, 'threads_manage_mentions'] };
    expect(() => assertThreadsMayReply(mentions, 'someone-else')).not.toThrow();
    // ...and even an unknown owner is fine once the scope entitles it.
    expect(() => assertThreadsMayReply(mentions, null)).not.toThrow();
  });

  it('threads_keyword_search satisfies it too', () => {
    const keyword: ThreadsCredential = { ...CREDENTIAL, scopes: [...CREDENTIAL.scopes, 'threads_keyword_search'] };
    expect(() => assertThreadsMayReply(keyword, 'someone-else')).not.toThrow();
  });
});

describe('container lifecycle constants — verified on THREADS pages, not inherited', () => {
  it('the container TTL is 24 hours', () => {
    // "The container was not published within 24 hours and has expired." Read on
    // Threads' own troubleshooting page. It MATCHES Instagram's figure, which is
    // why it had to be verified rather than assumed — a match confirmed is a
    // fact, a match assumed is a coincidence waiting to break.
    expect(THREADS_CONTAINER_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('the pre-publish settle wait is 30s — a THREADS-ONLY constant', () => {
    // Instagram documents no equivalent. This is the one place the two flows
    // genuinely differ in cadence despite looking identical.
    expect(THREADS_CONTAINER_SETTLE_MS).toBe(30_000);
  });
});

describe('threadsPublishRetryable — a THREE-state answer (D-033)', () => {
  it('PUBLISHED means DO NOT RETRY — the post exists', () => {
    expect(threadsPublishRetryable('PUBLISHED')).toBe(false);
  });

  it('EXPIRED and ERROR mean nothing was published, so a retry is safe', () => {
    expect(threadsPublishRetryable('EXPIRED')).toBe(true);
    expect(threadsPublishRetryable('ERROR')).toBe(true);
  });

  it('IN_PROGRESS and FINISHED are UNDETERMINED — null, never false', () => {
    // The distinction that matters: `false` says "we know not to retry",
    // `null` says "we do not know". Collapsing them would either double-post or
    // silently drop, depending which way the collapse went.
    expect(threadsPublishRetryable('IN_PROGRESS')).toBeNull();
    expect(threadsPublishRetryable('FINISHED')).toBeNull();
    expect(threadsPublishRetryable(null)).toBeNull();
  });

  it('CONTROL: a boolean-only API cannot express the case that matters', () => {
    // Any two-state encoding must map IN_PROGRESS to true or false. Mapping to
    // true double-posts a publish still in flight; mapping to false strands a
    // write that never happened. Both are wrong, which is why the type is
    // `boolean | null`.
    const states = ['PUBLISHED', 'EXPIRED', 'ERROR', 'IN_PROGRESS', 'FINISHED'] as const;
    const undetermined = states.filter((s) => threadsPublishRetryable(s) === null);
    expect(undetermined).toEqual(['IN_PROGRESS', 'FINISHED']);
  });
});

describe('parseThreadsPublishingLimit — absent is never zero', () => {
  const body = {
    data: [
      {
        quota_usage: 12,
        config: { quota_total: 250, quota_duration: 86400 },
        reply_quota_usage: 40,
        reply_config: { quota_total: 1000, quota_duration: 86400 },
      },
    ],
  };

  it('reads both buckets out of the documented envelope', () => {
    expect(parseThreadsPublishingLimit(body)).toEqual({
      postsUsed: 12,
      postsQuota: 250,
      repliesUsed: 40,
      repliesQuota: 1000,
    });
  });

  it('accepts an un-enveloped object too', () => {
    // The shape is documented by example only; refusing the bare form would turn
    // a cosmetic difference into total loss of the one budget signal Threads has.
    expect(parseThreadsPublishingLimit(body.data[0]).postsQuota).toBe(250);
  });

  it('a MISSING figure stays null — it must never read as zero-used', () => {
    // Zero-used looks like a full allowance and would authorise exactly the
    // burst the check exists to prevent.
    const partial = parseThreadsPublishingLimit({ data: [{ config: { quota_total: 250 } }] });
    expect(partial.postsUsed).toBeNull();
    expect(partial.postsQuota).toBe(250);
    expect(partial.repliesUsed).toBeNull();
  });

  it('survives junk without throwing', () => {
    for (const junk of [null, undefined, 'nope', 42, [], { data: [] }]) {
      expect(parseThreadsPublishingLimit(junk)).toEqual({
        postsUsed: null,
        postsQuota: null,
        repliesUsed: null,
        repliesQuota: null,
      });
    }
  });
});

describe('threadsHasQuotaFor — the two buckets are NOT fungible (D-030)', () => {
  const limit = { postsUsed: 250, postsQuota: 250, repliesUsed: 40, repliesQuota: 1000 };

  it('an exhausted POST bucket does not block a REPLY', () => {
    // Threads declares separate rolling allowances — 250 posts, 1,000 replies —
    // so rationing a reply against the publishing bucket would refuse writes the
    // vendor permits.
    expect(threadsHasQuotaFor(limit, 'post')).toBe(false);
    expect(threadsHasQuotaFor(limit, 'reply')).toBe(true);
  });

  it('an exhausted REPLY bucket does not block a POST', () => {
    const flipped = { postsUsed: 1, postsQuota: 250, repliesUsed: 1000, repliesQuota: 1000 };
    expect(threadsHasQuotaFor(flipped, 'reply')).toBe(false);
    expect(threadsHasQuotaFor(flipped, 'post')).toBe(true);
  });

  it('UNKNOWN is null, not permitted and not refused', () => {
    expect(threadsHasQuotaFor({ postsUsed: null, postsQuota: 250, repliesUsed: 1, repliesQuota: 1000 }, 'post')).toBeNull();
    expect(threadsHasQuotaFor({ postsUsed: 1, postsQuota: null, repliesUsed: 1, repliesQuota: 1000 }, 'post')).toBeNull();
  });
});
