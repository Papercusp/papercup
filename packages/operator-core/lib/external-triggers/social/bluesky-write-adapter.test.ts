/**
 * P-011 — the Bluesky WRITE adapter.
 *
 * The properties under test are the ones that reach a REAL public identity when
 * they are wrong, so several are asserted as "what the adapter SENT", not merely
 * "it resolved". A write adapter that returns a plausible outcome while having
 * posted the wrong bytes is the failure mode worth catching here.
 *
 * Permanent controls at the bottom keep deliberately-wrong implementations in
 * the file: a random rkey (which double-posts on retry) and a plain delete
 * without the CAS (which reports a deletion it cannot have confirmed).
 */
import { describe, expect, it } from 'vitest';
import {
  BLUESKY_POST_COLLECTION,
  createBlueskyWriteAdapter,
  parseBlueskyRecordUri,
  type BlueskyRepoClient,
} from './bluesky-write-adapter';
import { BlueskyXrpcError, blueskyPostRkey } from './bluesky-adapter';
import type { SocialReplyTarget } from '../../capability-verbs/social';
import type { OutboundContext } from '../../capability-verbs/resolve';

const REPO = 'did:plc:owner';
const CONTEXT = { userId: 'user-1', installSlug: 'papercusp', source: {} } as unknown as OutboundContext;
const CREATED_AT = new Date('2026-08-23T00:00:00.000Z');

interface Sent {
  created: Parameters<BlueskyRepoClient['createRecord']>[0][];
  deleted: Parameters<BlueskyRepoClient['deleteRecord']>[0][];
}

function makeClient(overrides: Partial<BlueskyRepoClient> = {}) {
  const sent: Sent = { created: [], deleted: [] };
  const client: BlueskyRepoClient = {
    async createRecord(input) {
      sent.created.push(input);
      return { uri: `at://${input.repo}/${input.collection}/${input.rkey}`, cid: 'bafy-new' };
    },
    async deleteRecord(input) {
      sent.deleted.push(input);
    },
    ...overrides,
  };
  return { client, sent };
}

function makeAdapter(overrides: Partial<BlueskyRepoClient> = {}) {
  const { client, sent } = makeClient(overrides);
  const adapter = createBlueskyWriteAdapter({
    createClient: async () => client,
    resolveRepo: async () => REPO,
    now: () => CREATED_AT,
  });
  return { adapter, sent };
}

const BLUESKY_TARGET: SocialReplyTarget = {
  platform: 'bluesky',
  rootUri: 'at://did:plc:author/app.bsky.feed.post/root1',
  rootCid: 'bafy-root',
  parentUri: 'at://did:plc:author/app.bsky.feed.post/par1',
  parentCid: 'bafy-par',
};

/* -------------------------------------------------------------------------- */

describe('parseBlueskyRecordUri — strict, because a wrong parse deletes the wrong record', () => {
  it('splits a well-formed at-uri', () => {
    expect(parseBlueskyRecordUri('at://did:plc:x/app.bsky.feed.post/3kabc')).toEqual({
      repo: 'did:plc:x',
      collection: 'app.bsky.feed.post',
      rkey: '3kabc',
    });
  });

  it('refuses anything it cannot parse EXACTLY, rather than guessing', () => {
    // Each of these could plausibly be "recovered" by a lenient parser, and each
    // recovery would address a different record than the caller meant.
    for (const bad of [
      'https://bsky.app/profile/x/post/3k',
      'at://did:plc:x/app.bsky.feed.post',
      'at://did:plc:x/app.bsky.feed.post/3k/extra',
      'at:///app.bsky.feed.post/3k',
      'did:plc:x/app.bsky.feed.post/3k',
    ]) {
      expect(() => parseBlueskyRecordUri(bad), bad).toThrow(/bluesky_uri_/);
    }
  });
});

describe('reply — the record the lexicon actually requires', () => {
  it('sends BOTH root and parent strong refs, into the right collection', async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.reply({ target: BLUESKY_TARGET, text: 'hi', visibility: 'public', idempotencyKey: 'k' }, CONTEXT);

    expect(sent.created).toHaveLength(1);
    const input = sent.created[0]!;
    expect(input.repo).toBe(REPO);
    expect(input.collection).toBe(BLUESKY_POST_COLLECTION);
    expect(input.record.reply).toEqual({
      root: { uri: BLUESKY_TARGET.rootUri, cid: 'bafy-root' },
      parent: { uri: BLUESKY_TARGET.parentUri, cid: 'bafy-par' },
    });
    expect(input.record.$type).toBe(BLUESKY_POST_COLLECTION);
  });

  it('asks the PDS to validate the record rather than trusting our own shape', async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.reply({ target: BLUESKY_TARGET, text: 'hi', visibility: 'public', idempotencyKey: 'k' }, CONTEXT);
    expect(sent.created[0]!.validate).toBe(true);
  });

  it('returns a canonical ref and a real public URL', async () => {
    const { adapter } = makeAdapter();
    const outcome = await adapter.reply(
      { target: BLUESKY_TARGET, text: 'hi', visibility: 'public', idempotencyKey: 'k' },
      CONTEXT,
    );
    expect(outcome.ref).toBe(`bluesky:${outcome.externalId}`);
    expect(outcome.url).toContain(`/profile/${REPO}/post/`);
  });

  it('refuses a target from a DIFFERENT platform instead of coercing it', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.reply(
        { target: { platform: 'mastodon', inReplyToId: '1', instanceHost: 'h' }, text: 'x', visibility: 'public', idempotencyKey: 'k' },
        CONTEXT,
      ),
    ).rejects.toThrow(/wrong_target/);
  });
});

describe('post — a create with no parent', () => {
  it('sends no reply field at all', async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.post!({ destination: 'bluesky:self', text: 'hello', visibility: 'public', idempotencyKey: 'k' }, CONTEXT);
    expect(sent.created[0]!.record.reply).toBeUndefined();
    expect(sent.created[0]!.record.text).toBe('hello');
  });
});

describe('the double-post guard — the only one this platform offers', () => {
  it('sends the SAME rkey for a retry of identical content', async () => {
    // atproto documents no idempotency mechanism, so this is what stops an
    // ambiguous timeout from publishing twice to a real public identity.
    const { adapter, sent } = makeAdapter();
    const request = { target: BLUESKY_TARGET, text: 'once', visibility: 'public' as const, idempotencyKey: 'k' };
    await adapter.reply(request, CONTEXT);
    await adapter.reply(request, CONTEXT);
    expect(sent.created).toHaveLength(2);
    expect(sent.created[0]!.rkey).toBe(sent.created[1]!.rkey);
    expect(sent.created[0]!.rkey).toBe(blueskyPostRkey({ text: 'once', replyTo: { uri: BLUESKY_TARGET.parentUri, cid: 'bafy-par' } }));
  });

  it('sends the same createdAt for a retry, so the record is byte-identical', async () => {
    // If createdAt were minted per call, the retry would differ from the
    // original and the rkey guard would be collapsing two DIFFERENT records.
    const { adapter, sent } = makeAdapter();
    const request = { target: BLUESKY_TARGET, text: 'once', visibility: 'public' as const, idempotencyKey: 'k' };
    await adapter.reply(request, CONTEXT);
    await adapter.reply(request, CONTEXT);
    expect(sent.created[0]!.record).toEqual(sent.created[1]!.record);
  });

  it('uses a DIFFERENT rkey for different text', async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.reply({ target: BLUESKY_TARGET, text: 'a', visibility: 'public', idempotencyKey: 'k' }, CONTEXT);
    await adapter.reply({ target: BLUESKY_TARGET, text: 'b', visibility: 'public', idempotencyKey: 'k' }, CONTEXT);
    expect(sent.created[0]!.rkey).not.toBe(sent.created[1]!.rkey);
  });
});

describe('delete — CAS is what makes the answer honest', () => {
  it('deletes by (repo, collection, rkey) with swapRecord set to the CID', async () => {
    const { adapter, sent } = makeAdapter();
    const outcome = await adapter.delete!(
      { ref: { platform: 'bluesky', externalId: BLUESKY_TARGET.parentUri }, target: BLUESKY_TARGET, idempotencyKey: 'k' },
      CONTEXT,
    );
    expect(outcome.deleted).toBe(true);
    expect(sent.deleted[0]).toEqual({
      repo: 'did:plc:author',
      collection: BLUESKY_POST_COLLECTION,
      rkey: 'par1',
      swapRecord: 'bafy-par',
    });
  });

  it('reports deleted:false — NOT an error — when the CAS says it was not there', async () => {
    // deleteRecord is documented as "delete, or ensure it doesn't exist", so
    // without the CAS this case would have returned an indistinguishable
    // success. InvalidSwap is the platform telling us the truth.
    const { adapter } = makeAdapter({
      async deleteRecord() {
        throw new BlueskyXrpcError(400, 'InvalidSwap', 'record not found');
      },
    });
    const outcome = await adapter.delete!(
      { ref: { platform: 'bluesky', externalId: BLUESKY_TARGET.parentUri }, target: BLUESKY_TARGET, idempotencyKey: 'k' },
      CONTEXT,
    );
    expect(outcome.deleted).toBe(false);
    expect(outcome.detail).toMatch(/already removed|edited since/);
  });

  it('propagates a NON-InvalidSwap error instead of reporting deleted:false', async () => {
    // An auth failure is not "nothing to delete". Collapsing the two would
    // report a broken credential as a successfully-absent post.
    const { adapter } = makeAdapter({
      async deleteRecord() {
        throw new BlueskyXrpcError(401, 'AuthenticationRequired');
      },
    });
    await expect(
      adapter.delete!(
        { ref: { platform: 'bluesky', externalId: BLUESKY_TARGET.parentUri }, target: BLUESKY_TARGET, idempotencyKey: 'k' },
        CONTEXT,
      ),
    ).rejects.toThrow(/AuthenticationRequired/);
  });
});

/* -------------------------------------------------------------------------- */
/* Controls — deliberately WRONG implementations, kept permanently             */
/* -------------------------------------------------------------------------- */

describe('controls — the wrong implementations, kept so the guards stay proven', () => {
  it('CONTROL: a random rkey double-posts on retry, which the real adapter does not', () => {
    // The whole reason blueskyPostRkey is derived. Kept as a control because the
    // random version passes every OTHER test in this file — it creates a valid
    // post, returns a valid ref, and only misbehaves on the retry nobody tests.
    const randomRkey = () => `pc${Math.random().toString(36).slice(2)}`;
    expect(randomRkey()).not.toBe(randomRkey());
    expect(blueskyPostRkey({ text: 'once' })).toBe(blueskyPostRkey({ text: 'once' }));
  });

  it('CONTROL: a delete without swapRecord cannot tell success from already-gone', async () => {
    // Demonstrated against the same fake: a plain delete resolves identically
    // whether or not the record was there, so any `deleted:true` it returned
    // would be a claim it had no evidence for.
    const seen: unknown[] = [];
    const naive: BlueskyRepoClient['deleteRecord'] = async (input) => {
      seen.push(input);
      // "…or ensure it doesn't exist": resolves either way, exactly as documented.
    };
    await naive({ repo: REPO, collection: BLUESKY_POST_COLLECTION, rkey: 'gone' });
    await naive({ repo: REPO, collection: BLUESKY_POST_COLLECTION, rkey: 'present' });
    expect(seen).toHaveLength(2);
    // Neither call carried a CID, so nothing distinguishes the two outcomes.
    expect(seen.every((input) => (input as { swapRecord?: string }).swapRecord === undefined)).toBe(true);
  });
});
