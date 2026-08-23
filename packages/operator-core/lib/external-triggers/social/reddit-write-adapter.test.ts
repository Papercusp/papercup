/**
 * Reddit write adapter tests — P-013.
 *
 * These assert what was SENT, not merely that a call returned. The failure this
 * guards is a double-post under the owner's real identity, which no assertion
 * about a return value can detect.
 */
import { describe, expect, it, vi } from 'vitest';

import type { OutboundContext } from '../../capability-verbs/resolve';
import type { SocialReplyTarget } from '../../capability-verbs/social';
import {
  createRedditWriteAdapter,
  parseRedditDestination,
  RedditDuplicateSubmission,
  type RedditThingState,
  type RedditWriteClient,
} from './reddit-write-adapter';

const CONTEXT = { accountLabel: 'u/papercusp_bot' } as unknown as OutboundContext;

const TARGET: SocialReplyTarget = {
  platform: 'reddit',
  parentFullname: 't3_abc123',
  subreddit: 'papercusp',
};

interface Recorder {
  client: RedditWriteClient;
  comments: { thingId: string; text: string }[];
  submits: Parameters<RedditWriteClient['submit']>[0][];
  deletes: string[];
  infos: string[][];
}

function recorder(
  over: {
    submit?: RedditWriteClient['submit'];
    info?: RedditWriteClient['info'] | null;
    things?: RedditThingState[];
  } = {},
): Recorder {
  const comments: Recorder['comments'] = [];
  const submits: Recorder['submits'] = [];
  const deletes: string[] = [];
  const infos: string[][] = [];
  let seq = 0;

  const client: RedditWriteClient = {
    async comment(params) {
      comments.push(params);
      seq += 1;
      return { name: `t1_new${seq}`, permalink: `/r/papercusp/comments/abc123/x/new${seq}/` };
    },
    submit:
      over.submit ??
      (async (params) => {
        submits.push(params);
        seq += 1;
        return { name: `t3_new${seq}`, url: `https://www.reddit.com/r/${params.sr}/comments/new${seq}/` };
      }),
    async del(params) {
      deletes.push(params.id);
    },
  };
  if (over.submit) {
    const inner = over.submit;
    client.submit = async (params) => {
      submits.push(params);
      return inner(params);
    };
  }
  if (over.info !== null) {
    client.info =
      over.info ??
      (async (fullnames) => {
        infos.push(fullnames);
        return over.things ?? fullnames.map((name) => ({ name, author: 'papercusp_bot' }));
      });
  }
  return { client, comments, submits, deletes, infos };
}

function adapterFor(rec: Recorder) {
  return createRedditWriteAdapter({ createClient: async () => rec.client });
}

/* -------------------------------------------------------------------------- */

describe('reply — /api/comment', () => {
  it('sends the parent fullname as thing_id and returns the created ref', async () => {
    const rec = recorder();
    const outcome = await adapterFor(rec).reply(
      { target: TARGET, text: 'hello', visibility: 'public', idempotencyKey: 'k1' },
      CONTEXT,
    );
    expect(rec.comments).toEqual([{ thingId: 't3_abc123', text: 'hello' }]);
    expect(outcome.externalId).toBe('t1_new1');
    expect(outcome.ref).toBe('reddit:t1_new1');
    expect(outcome.url).toBe('https://www.reddit.com/r/papercusp/comments/abc123/x/new1/');
  });

  it('accepts a comment parent as well as a link parent', async () => {
    const rec = recorder();
    await adapterFor(rec).reply(
      {
        target: { platform: 'reddit', parentFullname: 't1_par', subreddit: 'papercusp' },
        text: 'nested',
        visibility: 'public',
        idempotencyKey: 'k1',
      },
      CONTEXT,
    );
    expect(rec.comments[0]!.thingId).toBe('t1_par');
  });

  it('REFUSES a t4_ message parent — that would send a private message', async () => {
    // /api/comment routes on the parent's type: a t4_ parent creates a MESSAGE
    // under `privatemessages` scope. A content reply silently becoming a DM is
    // the worst available failure here, so it is refused by kind rather than
    // left to whatever scope the token happens to carry.
    const rec = recorder();
    await expect(
      adapterFor(rec).reply(
        {
          target: { platform: 'reddit', parentFullname: 't4_msg1', subreddit: '' },
          text: 'oops',
          visibility: 'public',
          idempotencyKey: 'k1',
        },
        CONTEXT,
      ),
    ).rejects.toThrow(/reddit_reply_parent_kind_unsupported:t4/);
    expect(rec.comments).toEqual([]);
  });

  it('refuses a malformed parent rather than posting somewhere unintended', async () => {
    const rec = recorder();
    await expect(
      adapterFor(rec).reply(
        {
          target: { platform: 'reddit', parentFullname: 'abc123', subreddit: 'papercusp' },
          text: 'x',
          visibility: 'public',
          idempotencyKey: 'k1',
        },
        CONTEXT,
      ),
    ).rejects.toThrow(/reddit_reply_parent_malformed/);
    expect(rec.comments).toEqual([]);
  });

  it('refuses another platform’s target', async () => {
    const rec = recorder();
    await expect(
      adapterFor(rec).reply(
        {
          target: { platform: 'mastodon', inReplyToId: '1', instanceHost: 'h' },
          text: 'x',
          visibility: 'public',
          idempotencyKey: 'k1',
        },
        CONTEXT,
      ),
    ).rejects.toThrow(/reddit_write_target_mismatch:mastodon/);
    expect(rec.comments).toEqual([]);
  });
});

describe('the double-post guard — reddit gives `reply` nothing, so it is ours', () => {
  it('collapses a SEQUENTIAL retry onto the first comment', async () => {
    const rec = recorder();
    const adapter = adapterFor(rec);
    const request = { target: TARGET, text: 'once', visibility: 'public' as const, idempotencyKey: 'k1' };
    const first = await adapter.reply(request, CONTEXT);
    const second = await adapter.reply(request, CONTEXT);
    expect(rec.comments.length).toBe(1);
    expect(second).toEqual(first);
  });

  it('collapses a CONCURRENT retry — only one request is ever sent', async () => {
    // The shape that actually happens: an ambiguous timeout, and the caller
    // fires again before the first has settled. A memo keyed on the completed
    // outcome alone would miss this and double-post.
    const rec = recorder();
    const adapter = adapterFor(rec);
    const request = { target: TARGET, text: 'once', visibility: 'public' as const, idempotencyKey: 'k1' };
    const [a, b] = await Promise.all([adapter.reply(request, CONTEXT), adapter.reply(request, CONTEXT)]);
    expect(rec.comments.length).toBe(1);
    expect(a).toEqual(b);
  });

  it('does NOT collapse two genuinely different writes', async () => {
    const rec = recorder();
    const adapter = adapterFor(rec);
    await adapter.reply({ target: TARGET, text: 'a', visibility: 'public', idempotencyKey: 'k1' }, CONTEXT);
    await adapter.reply({ target: TARGET, text: 'b', visibility: 'public', idempotencyKey: 'k2' }, CONTEXT);
    expect(rec.comments.map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('does not memoize a FAILURE — a retry after an error really retries', async () => {
    // Caching the rejection would turn one transient 503 into a permanent
    // refusal to ever publish that reply.
    let calls = 0;
    const rec = recorder();
    rec.client.comment = async (params) => {
      calls += 1;
      if (calls === 1) throw new Error('503 service unavailable');
      rec.comments.push(params);
      return { name: 't1_new1' };
    };
    const adapter = adapterFor(rec);
    const request = { target: TARGET, text: 'x', visibility: 'public' as const, idempotencyKey: 'k1' };
    await expect(adapter.reply(request, CONTEXT)).rejects.toThrow(/503/);
    const retried = await adapter.reply(request, CONTEXT);
    expect(retried.externalId).toBe('t1_new1');
    expect(calls).toBe(2);
  });
});

describe('post — /api/submit', () => {
  it('submits a self-post to the parsed subreddit with the parsed title', async () => {
    const rec = recorder();
    await adapterFor(rec).post!(
      { destination: 'reddit:r/papercusp#Release notes', text: 'body', visibility: 'public', idempotencyKey: 'k1' },
      CONTEXT,
    );
    expect(rec.submits).toEqual([
      { sr: 'papercusp', kind: 'self', title: 'Release notes', text: 'body', resubmit: false },
    ]);
  });

  it('sends resubmit:false, keeping reddit’s native duplicate check ARMED', async () => {
    // The one native idempotency mechanism this platform has. A client that
    // hardcoded resubmit:true would disable it, which is precisely the mistake
    // the registry row's "no documented idempotency mechanism" invites.
    const rec = recorder();
    await adapterFor(rec).post!(
      { destination: 'r/papercusp#Title', text: 'body', visibility: 'public', idempotencyKey: 'k1' },
      CONTEXT,
    );
    expect(rec.submits[0]!.resubmit).toBe(false);
  });

  it('treats reddit’s duplicate refusal as SUCCESS-EQUIVALENT, not a failure', async () => {
    // Retrying against this refusal would loop forever: it can never change.
    const rec = recorder({
      submit: async () => {
        throw new RedditDuplicateSubmission('that link has already been submitted', 't3_existing');
      },
    });
    const outcome = await adapterFor(rec).post!(
      { destination: 'r/papercusp#Title', text: 'body', visibility: 'public', idempotencyKey: 'k1' },
      CONTEXT,
    );
    expect(outcome.externalId).toBe('t3_existing');
    expect(outcome.ref).toBe('reddit:t3_existing');
  });

  it('re-raises a duplicate refusal that does not name the existing post', async () => {
    // Without an id there is nothing honest to hand back, and inventing a
    // success would report a publish that this adapter cannot point at.
    const rec = recorder({
      submit: async () => {
        throw new RedditDuplicateSubmission('duplicate', null);
      },
    });
    await expect(
      adapterFor(rec).post!(
        { destination: 'r/papercusp#Title', text: 'body', visibility: 'public', idempotencyKey: 'k1' },
        CONTEXT,
      ),
    ).rejects.toThrow(RedditDuplicateSubmission);
  });

  it('collapses a retried post the same way a retried reply is collapsed', async () => {
    const rec = recorder();
    const adapter = adapterFor(rec);
    const request = {
      destination: 'r/papercusp#Title',
      text: 'body',
      visibility: 'public' as const,
      idempotencyKey: 'k1',
    };
    await adapter.post!(request, CONTEXT);
    await adapter.post!(request, CONTEXT);
    expect(rec.submits.length).toBe(1);
  });
});

describe('destination parsing — a submission REQUIRES a title', () => {
  it('parses r/<sub>#<title>, with or without the platform prefix', () => {
    expect(parseRedditDestination('reddit:r/papercusp#Hello')).toEqual({ subreddit: 'papercusp', title: 'Hello' });
    expect(parseRedditDestination('r/papercusp#Hello')).toEqual({ subreddit: 'papercusp', title: 'Hello' });
    expect(parseRedditDestination('/r/papercusp#Hello')).toEqual({ subreddit: 'papercusp', title: 'Hello' });
  });

  it('keeps a title containing a # intact', () => {
    expect(parseRedditDestination('r/papercusp#Release #3').title).toBe('Release #3');
  });

  it('REFUSES a destination with no title rather than inventing one', () => {
    // An adapter-invented title is published under the owner's real name and is
    // the first thing a human reads. There is no safe default.
    expect(() => parseRedditDestination('r/papercusp')).toThrow(/reddit_destination_malformed/);
    expect(() => parseRedditDestination('r/papercusp#')).toThrow(/reddit_destination_malformed/);
    expect(() => parseRedditDestination('#title-only')).toThrow(/reddit_destination_malformed/);
  });
});

describe('delete — /api/del is idempotent but SILENT', () => {
  it('confirms with /api/info first, then deletes and attests it', async () => {
    const rec = recorder();
    const outcome = await adapterFor(rec).delete!(
      { ref: { platform: 'reddit', externalId: 't3_abc123' }, target: TARGET, idempotencyKey: 'k1' } as never,
      CONTEXT,
    );
    expect(rec.infos).toEqual([['t3_abc123']]);
    expect(rec.deletes).toEqual(['t3_abc123']);
    expect(outcome.deleted).toBe(true);
  });

  it('reports deleted:false — and does NOT call del — when it is already gone', async () => {
    const rec = recorder({ things: [{ name: 't3_abc123', author: '[deleted]' }] });
    const outcome = await adapterFor(rec).delete!(
      { ref: { platform: 'reddit', externalId: 't3_abc123' }, target: TARGET, idempotencyKey: 'k1' } as never,
      CONTEXT,
    );
    expect(outcome.deleted).toBe(false);
    expect(outcome.detail).toMatch(/nothing was there/);
    expect(rec.deletes).toEqual([]);
  });

  it('reports deleted:false when /api/info returns no such thing', async () => {
    const rec = recorder({ things: [] });
    const outcome = await adapterFor(rec).delete!(
      { ref: { platform: 'reddit', externalId: 't3_gone' }, target: TARGET, idempotencyKey: 'k1' } as never,
      CONTEXT,
    );
    expect(outcome.deleted).toBe(false);
    expect(rec.deletes).toEqual([]);
  });

  it('under-claims rather than over-claims when the client has no /api/info', async () => {
    // /api/del is @noresponse: an empty body whether it removed something or
    // resolved nothing at all. With no way to confirm, `deleted:false` plus a
    // reason is the honest answer — the contract forbids a success the caller
    // would read as "I deleted it".
    const rec = recorder({ info: null });
    const outcome = await adapterFor(rec).delete!(
      { ref: { platform: 'reddit', externalId: 't3_abc123' }, target: TARGET, idempotencyKey: 'k1' } as never,
      CONTEXT,
    );
    expect(outcome.deleted).toBe(false);
    expect(outcome.detail).toMatch(/cannot be attested/);
    expect(rec.deletes).toEqual(['t3_abc123']); // the delete WAS issued
  });

  it('is not routed through the retry-collapse memo', async () => {
    // Delete is idempotent by construction on reddit's side (`was_deleted`
    // guard, early return on an unresolvable thing), so memoizing it would only
    // serve a stale answer to a caller asking again after the state changed.
    const rec = recorder();
    const adapter = adapterFor(rec);
    const request = {
      ref: { platform: 'reddit', externalId: 't3_abc123' },
      target: TARGET,
      idempotencyKey: 'k1',
    } as never;
    await adapter.delete!(request, CONTEXT);
    await adapter.delete!(request, CONTEXT);
    expect(rec.deletes.length).toBe(2);
  });

  it('refuses another platform’s target', async () => {
    const rec = recorder();
    await expect(
      adapterFor(rec).delete!(
        {
          ref: { platform: 'reddit', externalId: 't3_abc123' },
          target: { platform: 'bluesky', rootUri: 'a', rootCid: 'b', parentUri: 'c', parentCid: 'd' },
          idempotencyKey: 'k1',
        } as never,
        CONTEXT,
      ),
    ).rejects.toThrow(/reddit_write_target_mismatch:bluesky/);
    expect(rec.deletes).toEqual([]);
  });
});

describe('the client is built per write, not cached across calls', () => {
  it('calls createClient on every write — reddit bearers expire after one hour', async () => {
    const rec = recorder();
    const createClient = vi.fn(async () => rec.client);
    const adapter = createRedditWriteAdapter({ createClient });
    await adapter.reply({ target: TARGET, text: 'a', visibility: 'public', idempotencyKey: 'k1' }, CONTEXT);
    await adapter.reply({ target: TARGET, text: 'b', visibility: 'public', idempotencyKey: 'k2' }, CONTEXT);
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});
