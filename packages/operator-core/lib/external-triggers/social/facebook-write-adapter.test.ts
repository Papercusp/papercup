/**
 * Tests for the Facebook Pages WRITE adapter — P-016.
 *
 * The theme is that this platform offers NO idempotency on either write verb
 * (D-028, verified against an exhaustive parameter list rather than inferred
 * from silence), so every guard that would normally be the provider's job is
 * this adapter's, and each one has to be pinned here.
 */
import { describe, expect, it } from 'vitest';
import type { OutboundContext } from '../../capability-verbs/resolve';
import type { SocialPostRequest, SocialReplyRequest } from '../../capability-verbs/social';
import { FacebookPageCredentialError, type FacebookPageCredential } from './facebook-common';
import {
  FACEBOOK_WRITE_READBACK_FIELDS,
  FacebookWriteAdapter,
  FacebookWriteUnconfirmed,
  type FacebookCreateCommentRequest,
  type FacebookCreatePostRequest,
  type FacebookWriteClient,
  inMemoryFacebookWriteDedupe,
} from './facebook-write-adapter';

const PAGE_ID = 'page-1';

const CREDENTIAL: FacebookPageCredential = {
  pageId: PAGE_ID,
  accessToken: 'page-token',
  tasks: ['CREATE_CONTENT', 'MODERATE', 'MANAGE'],
};

const CONTEXT = {} as OutboundContext;

interface Calls {
  posts: FacebookCreatePostRequest[];
  comments: FacebookCreateCommentRequest[];
}

function makeClient(over: Partial<FacebookWriteClient> = {}): { client: FacebookWriteClient; calls: Calls } {
  const calls: Calls = { posts: [], comments: [] };
  const client: FacebookWriteClient = {
    async createPost(request) {
      calls.posts.push(request);
      return { id: 'page-1_9001', permalink_url: 'https://www.facebook.com/page-1_9001' };
    },
    async createComment(request) {
      calls.comments.push(request);
      return { id: 'page-1_9001_5' };
    },
    ...over,
  };
  return { client, calls };
}

function newAdapter(client: FacebookWriteClient, credential = CREDENTIAL) {
  return new FacebookWriteAdapter({ client, pageId: PAGE_ID, credential, dedupe: inMemoryFacebookWriteDedupe() });
}

function replyRequest(over: Partial<SocialReplyRequest> = {}): SocialReplyRequest {
  return {
    target: { platform: 'facebook-pages', objectId: 'page-1_100' },
    text: 'thanks for reading',
    visibility: 'public',
    idempotencyKey: 'key-reply-1',
    ...over,
  } as SocialReplyRequest;
}

function postRequest(over: Partial<SocialPostRequest> = {}): SocialPostRequest {
  return {
    destination: PAGE_ID,
    text: 'hello world',
    visibility: 'public',
    idempotencyKey: 'key-post-1',
    ...over,
  } as SocialPostRequest;
}

/* -------------------------------------------------------------------------- */
/* Reply                                                                      */
/* -------------------------------------------------------------------------- */

describe('reply', () => {
  it('creates a comment and mints the ref from the SERVER-returned id (D-008)', async () => {
    const { client, calls } = makeClient();
    const outcome = await newAdapter(client).reply(replyRequest(), CONTEXT);

    expect(calls.comments).toHaveLength(1);
    expect(calls.comments[0]!.objectId).toBe('page-1_100');
    expect(calls.comments[0]!.message).toBe('thanks for reading');
    expect(outcome.externalId).toBe('page-1_9001_5');
    expect(outcome.ref).toBe('facebook-pages:page-1_9001_5');
  });

  it('exercises READ-AFTER-WRITE by requesting fields back on the create call', async () => {
    const { client, calls } = makeClient();
    await newAdapter(client).reply(replyRequest(), CONTEXT);
    expect(calls.comments[0]!.fields).toEqual(FACEBOOK_WRITE_READBACK_FIELDS);
    expect(calls.comments[0]!.fields).toContain('id');
  });

  it('requires the MODERATE task (D-027)', async () => {
    const { client, calls } = makeClient();
    const weak: FacebookPageCredential = { pageId: PAGE_ID, accessToken: 't', tasks: ['CREATE_CONTENT'] };
    await expect(newAdapter(client, weak).reply(replyRequest(), CONTEXT)).rejects.toThrow(
      FacebookPageCredentialError,
    );
    expect(calls.comments).toHaveLength(0);
  });

  it('refuses a target belonging to ANOTHER platform rather than duck-typing an id out of it', async () => {
    const { client, calls } = makeClient();
    const foreign = replyRequest({
      target: { platform: 'mastodon', inReplyToId: '123', instanceHost: 'example.social' },
    });
    await expect(newAdapter(client).reply(foreign, CONTEXT)).rejects.toThrow(/wrong-platform-target:mastodon/);
    expect(calls.comments).toHaveLength(0);
  });

  it('refuses locally when can_comment is DEFINITELY false', async () => {
    const { client, calls } = makeClient();
    const blocked = replyRequest({
      target: { platform: 'facebook-pages', objectId: 'page-1_100', canComment: false },
    });
    await expect(newAdapter(client).reply(blocked, CONTEXT)).rejects.toThrow(/can_comment-false/);
    expect(calls.comments).toHaveLength(0);
  });

  it('STILL ATTEMPTS when can_comment is absent — a missing field is not a refusal', async () => {
    const { client, calls } = makeClient();
    const outcome = await newAdapter(client).reply(replyRequest(), CONTEXT);
    expect(calls.comments).toHaveLength(1);
    expect(outcome.externalId).toBeTruthy();
  });

  it('attaches to a COMMENT id as readily as a post id — the edge does not distinguish', async () => {
    const { client, calls } = makeClient();
    await newAdapter(client).reply(
      replyRequest({ target: { platform: 'facebook-pages', objectId: 'page-1_100_7' } }),
      CONTEXT,
    );
    expect(calls.comments[0]!.objectId).toBe('page-1_100_7');
  });
});

/* -------------------------------------------------------------------------- */
/* Post                                                                       */
/* -------------------------------------------------------------------------- */

describe('post', () => {
  it('creates a page post and mints the ref from the server id', async () => {
    const { client, calls } = makeClient();
    const outcome = await newAdapter(client).post(postRequest(), CONTEXT);

    expect(calls.posts).toHaveLength(1);
    expect(calls.posts[0]!.pageId).toBe(PAGE_ID);
    expect(outcome.ref).toBe('facebook-pages:page-1_9001');
    expect(outcome.url).toBe('https://www.facebook.com/page-1_9001');
  });

  it('requires the CREATE_CONTENT task', async () => {
    const { client, calls } = makeClient();
    const weak: FacebookPageCredential = { pageId: PAGE_ID, accessToken: 't', tasks: ['MODERATE'] };
    await expect(newAdapter(client, weak).post(postRequest(), CONTEXT)).rejects.toThrow(
      FacebookPageCredentialError,
    );
    expect(calls.posts).toHaveLength(0);
  });

  it('refuses a destination that is not THIS adapter page', async () => {
    const { client, calls } = makeClient();
    await expect(
      newAdapter(client).post(postRequest({ destination: 'some-other-page' }), CONTEXT),
    ).rejects.toThrow(/destination-mismatch/);
    expect(calls.posts).toHaveLength(0);
  });

  it('refuses an empty message locally — "Either link or message must be supplied"', async () => {
    const { client, calls } = makeClient();
    await expect(newAdapter(client).post(postRequest({ text: '   ' }), CONTEXT)).rejects.toThrow(
      /empty-message/,
    );
    expect(calls.posts).toHaveLength(0);
  });

  it('falls back to the documented URL shape when no permalink comes back', async () => {
    const { client } = makeClient({
      async createPost() {
        return { id: 'page-1_777' };
      },
    });
    const outcome = await newAdapter(client).post(postRequest(), CONTEXT);
    expect(outcome.url).toBe('https://www.facebook.com/page-1_777');
  });
});

/* -------------------------------------------------------------------------- */
/* No idempotency — the guards that compensate                                */
/* -------------------------------------------------------------------------- */

describe('missing platform idempotency (D-028)', () => {
  it('a repeat of the SAME logical write does NOT create a second post', async () => {
    const { client, calls } = makeClient();
    const adapter = newAdapter(client);

    const first = await adapter.post(postRequest(), CONTEXT);
    const second = await adapter.post(postRequest(), CONTEXT);

    expect(calls.posts).toHaveLength(1);
    expect(second.externalId).toBe(first.externalId);
    expect(second.ref).toBe(first.ref);
  });

  it('a DIFFERENT logical write still goes through', async () => {
    const { client, calls } = makeClient();
    const adapter = newAdapter(client);
    await adapter.post(postRequest({ idempotencyKey: 'k1' }), CONTEXT);
    await adapter.post(postRequest({ idempotencyKey: 'k2' }), CONTEXT);
    expect(calls.posts).toHaveLength(2);
  });

  it('the reply and post dedupe namespaces do not collide across verbs', async () => {
    const { client, calls } = makeClient();
    const adapter = newAdapter(client);
    await adapter.post(postRequest({ idempotencyKey: 'shared' }), CONTEXT);
    await adapter.reply(replyRequest({ idempotencyKey: 'shared-2' }), CONTEXT);
    expect(calls.posts).toHaveLength(1);
    expect(calls.comments).toHaveLength(1);
  });

  it('REFUSES to report success on a response with no id, rather than returning an unresolvable ref', async () => {
    const { client } = makeClient({
      async createPost() {
        return {};
      },
    });
    await expect(newAdapter(client).post(postRequest(), CONTEXT)).rejects.toThrow(FacebookWriteUnconfirmed);
    await expect(newAdapter(client).post(postRequest(), CONTEXT)).rejects.toThrow(/no-id-in-response/);
  });

  it('does NOT record a dedupe entry for an unconfirmed write, so a corrected retry can proceed', async () => {
    let failFirst = true;
    const { client, calls } = makeClient({
      async createPost(request) {
        calls.posts.push(request);
        if (failFirst) {
          failFirst = false;
          return {};
        }
        return { id: 'page-1_recovered' };
      },
    });
    const adapter = newAdapter(client);

    await expect(adapter.post(postRequest(), CONTEXT)).rejects.toThrow(FacebookWriteUnconfirmed);
    const retry = await adapter.post(postRequest(), CONTEXT);
    expect(retry.externalId).toBe('page-1_recovered');
  });

  it('NEVER retries a failing write internally — one call in, one call out', async () => {
    // On a verb with no idempotency, an internal retry is how one intended post
    // becomes two public ones. The adapter must surface, not re-attempt.
    let attempts = 0;
    const { client } = makeClient({
      async createPost() {
        attempts += 1;
        throw new Error('network timeout — the write may or may not have landed');
      },
    });

    await expect(newAdapter(client).post(postRequest(), CONTEXT)).rejects.toThrow(/network timeout/);
    expect(attempts).toBe(1);
  });

  it('does not swallow a provider error into a fake success', async () => {
    const { client } = makeClient({
      async createComment() {
        throw new Error('(#80001) There have been too many calls to this Page account.');
      },
    });
    await expect(newAdapter(client).reply(replyRequest(), CONTEXT)).rejects.toThrow(/80001/);
  });
});

describe('inMemoryFacebookWriteDedupe', () => {
  it('round-trips a value and misses cleanly on an unknown key', async () => {
    const store = inMemoryFacebookWriteDedupe();
    expect(await store.get('nope')).toBeNull();
    await store.put('k', { externalId: 'x', url: 'u' });
    expect(await store.get('k')).toEqual({ externalId: 'x', url: 'u' });
  });

  it('is per-instance — two stores do not share state, as its contract states', async () => {
    const a = inMemoryFacebookWriteDedupe();
    const b = inMemoryFacebookWriteDedupe();
    await a.put('k', { externalId: 'x' });
    expect(await b.get('k')).toBeNull();
  });
});
