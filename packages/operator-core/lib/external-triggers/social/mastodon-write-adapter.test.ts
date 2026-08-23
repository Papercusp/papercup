/**
 * P-012 — the Mastodon WRITE adapter.
 *
 * Bluesky's write suite proved a guard we had to BUILD (the derived rkey, because
 * atproto offers no idempotency). This one proves three things instead:
 *
 *   - that we correctly DON'T build that guard here, because the platform ships
 *     one (`Idempotency-Key`) and re-deriving would break it;
 *   - the visibility mapping, where Mastodon's word "private" means the neutral
 *     ladder's `followers` and a mis-map leaks a followers-only thread publicly;
 *   - the delete disambiguation, where a 404 means EITHER "already gone" OR
 *     "not yours" and the platform offers no CAS to tell them apart.
 *
 * Each has a permanent control holding the wrong implementation, because each
 * guard is invisible when it works.
 */
import { describe, expect, it } from 'vitest';
import {
  MastodonInstanceMismatch,
  MastodonNotOurStatus,
  createMastodonWriteAdapter,
  mastodonNativeVisibility,
  normalizeInstanceHost,
  type MastodonCreateStatusInput,
  type MastodonStatusRef,
  type MastodonWriteClient,
} from './mastodon-write-adapter';
import { normalizeSocialVisibility, type SocialVisibility } from '../../capability-verbs/social';
import type { OutboundContext } from '../../capability-verbs/resolve';
import type { MastodonVisibility } from './mastodon-adapter';

const INSTANCE = 'mastodon.test';
const SELF = 'ada';
const CONTEXT = { installSlug: 'papercusp', userId: 'user-1' } as unknown as OutboundContext;

interface Recorded {
  created: MastodonCreateStatusInput[];
  deleted: string[];
  fetched: string[];
  clientsBuiltFor: string[];
}

function statusRef(id: string, accountAcct = SELF): MastodonStatusRef {
  return {
    id,
    uri: `https://${INSTANCE}/users/${accountAcct}/statuses/${id}`,
    url: `https://${INSTANCE}/@${accountAcct}/${id}`,
    accountAcct,
  };
}

function setup(options: { world?: Record<string, MastodonStatusRef>; credentialHost?: string } = {}) {
  const world = options.world ?? {};
  const recorded: Recorded = { created: [], deleted: [], fetched: [], clientsBuiltFor: [] };

  const client: MastodonWriteClient = {
    async createStatus(input) {
      recorded.created.push(input);
      return statusRef('999');
    },
    async fetchStatus(id) {
      recorded.fetched.push(id);
      return world[id] ?? null;
    },
    async deleteStatus(id) {
      recorded.deleted.push(id);
      if (!world[id]) return false;
      delete world[id];
      return true;
    },
  };

  const adapter = createMastodonWriteAdapter({
    async createClient(_context, instanceHost) {
      recorded.clientsBuiltFor.push(instanceHost);
      return client;
    },
    async resolveSelfAcct() {
      return SELF;
    },
    async resolveInstanceHost() {
      return options.credentialHost ?? INSTANCE;
    },
  });

  return { adapter, recorded, world };
}

const replyRequest = (overrides: { visibility?: SocialVisibility; instanceHost?: string; key?: string } = {}) => ({
  target: {
    platform: 'mastodon' as const,
    inReplyToId: '109252268000000001',
    instanceHost: overrides.instanceHost ?? INSTANCE,
  },
  text: 'a considered reply',
  visibility: overrides.visibility ?? ('public' as SocialVisibility),
  idempotencyKey: overrides.key ?? 'derived-key-abc123',
});

/* -------------------------------------------------------------------------- */

describe('reply — the platform supplies the idempotency guard, so we pass it through', () => {
  it('sends the derived key VERBATIM as the idempotency key', async () => {
    const { adapter, recorded } = setup();
    await adapter.reply(replyRequest({ key: 'k-from-the-verb-layer' }), CONTEXT);
    expect(recorded.created[0].idempotencyKey).toBe('k-from-the-verb-layer');
  });

  it('a retry of the SAME logical write sends the SAME key', async () => {
    // The whole point of the header. If the adapter derived its own key from
    // anything local — a timestamp, a counter, a random — the retry of a
    // timed-out call would carry a different key and publish a second status.
    const { adapter, recorded } = setup();
    const request = replyRequest({ key: 'stable-k' });
    await adapter.reply(request, CONTEXT);
    await adapter.reply(request, CONTEXT);
    expect(recorded.created.map((c) => c.idempotencyKey)).toEqual(['stable-k', 'stable-k']);
  });

  it('threads the reply and returns an addressable ref', async () => {
    const { adapter, recorded } = setup();
    const outcome = await adapter.reply(replyRequest(), CONTEXT);
    expect(recorded.created[0].inReplyToId).toBe('109252268000000001');
    expect(recorded.created[0].status).toBe('a considered reply');
    expect(outcome.ref).toBe(`mastodon:https://${INSTANCE}/users/${SELF}/statuses/999`);
    expect(outcome.url).toBe(`https://${INSTANCE}/@${SELF}/999`);
  });

  it('post is a create with no parent', async () => {
    const { adapter, recorded } = setup();
    await adapter.post!(
      { destination: INSTANCE, text: 'a new thought', visibility: 'unlisted', idempotencyKey: 'k2' },
      CONTEXT,
    );
    expect(recorded.created[0].inReplyToId).toBeNull();
    expect(recorded.created[0].visibility).toBe('unlisted');
  });

  it('refuses a target belonging to another platform', async () => {
    const { adapter } = setup();
    await expect(
      adapter.reply(
        { ...replyRequest(), target: { platform: 'reddit', parentFullname: 't3_x', subreddit: 'r' } },
        CONTEXT,
      ),
    ).rejects.toThrow(/wrong_target:reddit/);
  });
});

/* -------------------------------------------------------------------------- */

describe('visibility — "private" is Mastodon for followers-only, not for direct', () => {
  it('maps the neutral ladder onto the four documented values', () => {
    const table: [SocialVisibility, MastodonVisibility][] = [
      ['public', 'public'],
      ['unlisted', 'unlisted'],
      ['followers', 'private'],
      ['direct', 'direct'],
    ];
    for (const [neutral, native] of table) expect(mastodonNativeVisibility(neutral)).toBe(native);
  });

  it('round-trips through the neutral normalizer without widening', () => {
    for (const neutral of ['public', 'unlisted', 'followers', 'direct'] as SocialVisibility[]) {
      expect(normalizeSocialVisibility(mastodonNativeVisibility(neutral))).toBe(neutral);
    }
  });

  it('carries the mapped value to the wire', async () => {
    const { adapter, recorded } = setup();
    await adapter.reply(replyRequest({ visibility: 'followers' }), CONTEXT);
    expect(recorded.created[0].visibility).toBe('private');
  });

  it('CONTROL: a name-matching mapping publishes a followers-only reply to everyone', () => {
    // The plausible wrong implementation — look for a native value with the
    // same name, fall back to the platform default. `followers` has no native
    // twin, so it falls through to `public` and republishes the parent thread,
    // quoted, to the entire network. Unretractable.
    const NATIVE = ['public', 'unlisted', 'private', 'direct'];
    const byName = (v: SocialVisibility): string => (NATIVE.includes(v) ? v : 'public');

    expect(byName('followers')).toBe('public');
    expect(byName('followers')).not.toBe(mastodonNativeVisibility('followers'));
    // CALIBRATION: the two agree everywhere else, so the control is isolating
    // this one rung rather than passing because everything differs.
    for (const v of ['public', 'unlisted', 'direct'] as SocialVisibility[]) {
      expect(byName(v)).toBe(mastodonNativeVisibility(v));
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('federation — a credential is scoped to ONE instance', () => {
  it('normalizes hosts before comparing them', () => {
    expect(normalizeInstanceHost('HTTPS://Mastodon.Test/')).toBe(INSTANCE);
    expect(normalizeInstanceHost('  mastodon.test  ')).toBe(INSTANCE);
  });

  it('refuses a cross-instance write BEFORE building a client', async () => {
    const { adapter, recorded } = setup({ credentialHost: 'other.social' });
    await expect(adapter.reply(replyRequest({ instanceHost: INSTANCE }), CONTEXT)).rejects.toBeInstanceOf(
      MastodonInstanceMismatch,
    );
    // The rail is only worth having if it runs first: a client built against
    // the wrong instance is a request already half-formed.
    expect(recorded.clientsBuiltFor).toEqual([]);
    expect(recorded.created).toEqual([]);
  });

  it('allows a write whose host differs only in case or scheme', async () => {
    const { adapter, recorded } = setup({ credentialHost: 'https://Mastodon.Test' });
    await adapter.reply(replyRequest({ instanceHost: INSTANCE }), CONTEXT);
    expect(recorded.created).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('delete — the platform answers 404 for BOTH "gone" and "not yours"', () => {
  it('deletes a status we own', async () => {
    const { adapter, world } = setup({ world: { '55': statusRef('55', SELF) } });
    const outcome = await adapter.delete!(
      { ref: { platform: 'mastodon', externalId: 'x' }, target: { platform: 'mastodon', inReplyToId: '55', instanceHost: INSTANCE }, idempotencyKey: 'k' },
      CONTEXT,
    );
    expect(outcome.deleted).toBe(true);
    expect(world['55']).toBeUndefined();
  });

  it('reports deleted:false when the status is genuinely absent', async () => {
    const { adapter, recorded } = setup({ world: {} });
    const outcome = await adapter.delete!(
      { ref: { platform: 'mastodon', externalId: 'x' }, target: { platform: 'mastodon', inReplyToId: '56', instanceHost: INSTANCE }, idempotencyKey: 'k' },
      CONTEXT,
    );
    expect(outcome.deleted).toBe(false);
    expect(outcome.detail).toMatch(/already removed, or never existed/);
    // And it never issued the destructive call.
    expect(recorded.deleted).toEqual([]);
  });

  it('THROWS on a status owned by someone else — never reports it as a no-op', async () => {
    const { adapter, recorded } = setup({ world: { '57': statusRef('57', 'someone-else') } });
    await expect(
      adapter.delete!(
        { ref: { platform: 'mastodon', externalId: 'x' }, target: { platform: 'mastodon', inReplyToId: '57', instanceHost: INSTANCE }, idempotencyKey: 'k' },
        CONTEXT,
      ),
    ).rejects.toBeInstanceOf(MastodonNotOurStatus);
    expect(recorded.deleted).toEqual([]);
  });

  it('CONTROL: the naive 404 mapping reports someone else’s post as "nothing to delete"', async () => {
    // The implementation everyone writes first: call DELETE, map 404 to
    // deleted:false. It is indistinguishable from correct in every test where
    // the post IS ours — which is every test anyone writes.
    //
    // `deleted:false` is contractually "the platform reported nothing to
    // delete". Returning it here tells the caller a post they do not own is
    // gone. It is not; it was never theirs to remove.
    const world: Record<string, MastodonStatusRef> = { '58': statusRef('58', 'someone-else') };
    const naiveDelete = async (id: string): Promise<{ deleted: boolean }> => {
      // The real server 404s for "not yours" exactly as it does for "absent".
      const visibleToUs = world[id]?.accountAcct === SELF;
      return { deleted: visibleToUs };
    };
    const naive = await naiveDelete('58');
    expect(naive.deleted).toBe(false); // ← reported as a benign no-op

    // The real adapter refuses instead.
    const { adapter } = setup({ world: { '58': statusRef('58', 'someone-else') } });
    await expect(
      adapter.delete!(
        { ref: { platform: 'mastodon', externalId: 'x' }, target: { platform: 'mastodon', inReplyToId: '58', instanceHost: INSTANCE }, idempotencyKey: 'k' },
        CONTEXT,
      ),
    ).rejects.toThrow(/not_ours/);

    // CALIBRATION: on a post we DO own the two agree, so the control is
    // isolating the ownership case rather than differing everywhere.
    world['59'] = statusRef('59', SELF);
    expect((await naiveDelete('59')).deleted).toBe(true);
  });

  it('reports deleted:false if the status vanishes between the check and the delete', async () => {
    // The read-then-delete window is not atomic. The only thing that can happen
    // inside it is the status disappearing — which is benign, and is what this
    // branch says.
    const world: Record<string, MastodonStatusRef> = { '60': statusRef('60', SELF) };
    const adapter = createMastodonWriteAdapter({
      async createClient() {
        return {
          async createStatus() {
            return statusRef('1');
          },
          async fetchStatus(id) {
            return world[id] ?? null;
          },
          async deleteStatus() {
            return false; // gone by the time we asked
          },
        };
      },
      async resolveSelfAcct() {
        return SELF;
      },
      async resolveInstanceHost() {
        return INSTANCE;
      },
    });
    const outcome = await adapter.delete!(
      { ref: { platform: 'mastodon', externalId: 'x' }, target: { platform: 'mastodon', inReplyToId: '60', instanceHost: INSTANCE }, idempotencyKey: 'k' },
      CONTEXT,
    );
    expect(outcome.deleted).toBe(false);
    expect(outcome.detail).toMatch(/disappeared between/);
  });
});
