/**
 * adjacency-cross-feed-io.test.ts — the P-013 adjacency cross-feed live-leg
 * WIRING (ambient-semantic-push-2026-07-14): runAdjacencyTick's shared-snapshot
 * → fold → actuate → save → cross-feed pipeline against MOCKED stores (no PG —
 * the end-to-end-vs-real-PG proof is the integration test). The banded
 * hysteresis math itself is covered by adjacency-cross-feed.test.ts; here we
 * prove the live plumbing: which topics get created/subscribed/unsubscribed,
 * which rows get enqueued to whom, the recorded-slug-not-derived-slug exit
 * contract, and the fail-soft edges.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdjacencyState } from './adjacency-cross-feed';
import type { AdjacencyPeerTopic, SaveAdjacencyStateInput } from './adjacency-state-store';
import type { CollisionLike } from './ambient-push';
import type { EnqueuePushInput } from './push-delivery-store';

const SELF = 'su-self';
const OWNER = 'own-self';
const PEER = 'su-peer';
const PEER_OWNER = 'own-peer';

function candidate(sessionId: string, score: number, terms: string[]): CollisionLike {
  return { sessionId, overlap: { score, sharedTerms: terms.map((term) => ({ term })) } };
}

/** One in-band tick away from the enter edge (default enterDwell 3 ⇒ streak 2). */
function primedState(peer: string, terms: string[]): AdjacencyState[] {
  return [{
    sessionId: peer,
    adjacent: false,
    inBandStreak: 2,
    belowExitStreak: 0,
    ticksSinceSeen: 0,
    lastScore: 0.4,
    lastSharedTerms: terms,
  }];
}

/** An established adjacency (past the enter edge). */
function adjacentState(peer: string, terms: string[]): AdjacencyState[] {
  return [{
    sessionId: peer,
    adjacent: true,
    inBandStreak: 5,
    belowExitStreak: 0,
    ticksSinceSeen: 0,
    lastScore: 0.4,
    lastSharedTerms: terms,
    enteredAtTick: 3,
  }];
}

async function withMocks(opts: {
  carry?: { tick: number; states: AdjacencyState[]; topics: Record<string, AdjacencyPeerTopic> };
  subscribeImpl?: () => Promise<void>;
}) {
  vi.resetModules();
  const enqueuePush = vi.fn<(input: EnqueuePushInput) => Promise<number>>(async () => 1);
  const saveAdjacencyState = vi.fn<(input: SaveAdjacencyStateInput) => Promise<void>>(async () => {});
  const loadAdjacencyState = vi.fn(async () => opts.carry ?? { tick: 0, states: [], topics: {} });
  const ensureTopicFor = vi.fn(async () => ({}) as never);
  const subscribeTopicFor = vi.fn(opts.subscribeImpl ?? (async () => {}));
  const unsubscribeTopicFor = vi.fn(async () => {});

  vi.doMock('./adjacency-state-store', () => ({
    loadAdjacencyState,
    saveAdjacencyState,
    pruneAdjacencyState: async () => 0,
  }));
  vi.doMock('./topic-subscription-store', () => ({
    ensureTopicFor,
    subscribeTopicFor,
    unsubscribeTopicFor,
  }));
  vi.doMock('./push-delivery-store', () => ({ enqueuePush }));

  const mod = await import('./adjacency-cross-feed-io');
  return { mod, enqueuePush, saveAdjacencyState, ensureTopicFor, subscribeTopicFor, unsubscribeTopicFor };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runAdjacencyTick — shared snapshot → fold → actuate → save → cross-feed', () => {
  it('no owner identity ⇒ ran:false, nothing touched', async () => {
    const { mod, enqueuePush, saveAdjacencyState } = await withMocks({});
    const r = await mod.runAdjacencyTick({ selfSessionId: SELF, selfOwnerId: null, snapshot: [] });
    expect(r.ran).toBe(false);
    expect(enqueuePush).not.toHaveBeenCalled();
    expect(saveAdjacencyState).not.toHaveBeenCalled();
  });

  it('on the ENTER edge: ensures + subscribes the derived shared topic, notices self, records the peer topic', async () => {
    const { mod, enqueuePush, saveAdjacencyState, ensureTopicFor, subscribeTopicFor } = await withMocks({
      carry: { tick: 9, states: primedState(PEER, ['WI-4790', 'launcher']), topics: {} },
    });
    const r = await mod.runAdjacencyTick({
      selfSessionId: SELF,
      selfOwnerId: OWNER,
      snapshot: [candidate(PEER, 0.4, ['WI-4790', 'launcher'])],
      ownerBySession: new Map([[PEER, PEER_OWNER]]),
    });

    expect(r).toMatchObject({ ran: true, tick: 10, entered: 1, subscribed: 1, enqueued: 1 });
    expect(ensureTopicFor).toHaveBeenCalledTimes(1);
    expect(ensureTopicFor.mock.calls[0]![0]).toMatchObject({ slug: 'adj:wi-4790+launcher' });
    expect(subscribeTopicFor).toHaveBeenCalledWith(OWNER, 'adj:wi-4790+launcher', 'digest');

    // The self notice rides the rail as an info 'topic-sub' row.
    expect(enqueuePush).toHaveBeenCalledTimes(1);
    const notice = enqueuePush.mock.calls[0]![0];
    expect(notice).toMatchObject({
      targetOwnerId: OWNER,
      targetSessionId: SELF,
      matcherKind: 'topic-sub',
      severity: 'info',
      handleKind: 'topic',
      handleRef: 'adj:wi-4790+launcher',
    });
    expect(notice.teaser).toContain('adjacency: entered');
    expect(notice.teaser).toContain(PEER);

    // The peer topic is RECORDED (slug + enter terms + peer owner) for exits + cross-feed.
    const saved = saveAdjacencyState.mock.calls[0]![0];
    expect(saved.topics[PEER]).toEqual({
      topic: 'adj:wi-4790+launcher',
      terms: ['WI-4790', 'launcher'],
      peerOwnerId: PEER_OWNER,
    });
    expect(saved.states.find((s) => s.sessionId === PEER)?.adjacent).toBe(true);
  });

  it('an escalated EXIT unsubscribes the slug RECORDED at enter, not the drifted re-derived name', async () => {
    const recorded: AdjacencyPeerTopic = { topic: 'adj:wi-4790+launcher', terms: ['WI-4790', 'launcher'], peerOwnerId: PEER_OWNER };
    const { mod, enqueuePush, saveAdjacencyState, unsubscribeTopicFor } = await withMocks({
      carry: { tick: 20, states: adjacentState(PEER, ['WI-4790', 'launcher']), topics: { [PEER]: recorded } },
    });
    // The pair converged hard AND the shared terms drifted since enter — the
    // fold's exit notice re-derives 'adj:compaction+restart', but the live leg
    // must unsubscribe what it actually subscribed.
    const r = await mod.runAdjacencyTick({
      selfSessionId: SELF,
      selfOwnerId: OWNER,
      snapshot: [candidate(PEER, 0.9, ['compaction', 'restart'])],
    });

    expect(r).toMatchObject({ ran: true, exited: 1, unsubscribed: 1 });
    expect(unsubscribeTopicFor).toHaveBeenCalledWith(OWNER, 'adj:wi-4790+launcher');

    const notice = enqueuePush.mock.calls[0]![0];
    expect(notice.handleRef).toBe('adj:wi-4790+launcher');
    expect(notice.teaser).toContain('adjacency: exited');
    expect(notice.teaser).toContain('escalated-to-collision');

    // The recorded topic is cleared from the carried map.
    const saved = saveAdjacencyState.mock.calls[0]![0];
    expect(saved.topics[PEER]).toBeUndefined();
  });

  it('cross-feeds an ON-TOPIC journal note to the adjacent peer\'s owner; an off-topic note never posts', async () => {
    const recorded: AdjacencyPeerTopic = { topic: 'adj:wi-4790+launcher', terms: ['WI-4790', 'launcher'], peerOwnerId: PEER_OWNER };
    const carry = { tick: 20, states: adjacentState(PEER, ['WI-4790', 'launcher']), topics: { [PEER]: recorded } };

    const on = await withMocks({ carry });
    const r1 = await on.mod.runAdjacencyTick({
      selfSessionId: SELF,
      selfOwnerId: OWNER,
      snapshot: [candidate(PEER, 0.4, ['WI-4790', 'launcher'])],
      journalNote: 'isolated the WI-4790 launcher restart loop to the advisory lock',
    });
    expect(r1).toMatchObject({ crossFed: 1, enqueued: 1 });
    const post = on.enqueuePush.mock.calls[0]![0];
    expect(post).toMatchObject({
      targetOwnerId: PEER_OWNER,
      targetSessionId: PEER,
      matcherKind: 'topic-sub',
      severity: 'info',
      handleKind: 'topic',
      handleRef: 'adj:wi-4790+launcher',
      sourceSessionId: SELF,
    });
    expect(post.teaser).toContain(`[adj:wi-4790+launcher] ${SELF}:`);

    const off = await withMocks({ carry });
    const r2 = await off.mod.runAdjacencyTick({
      selfSessionId: SELF,
      selfOwnerId: OWNER,
      snapshot: [candidate(PEER, 0.4, ['WI-4790', 'launcher'])],
      journalNote: 'designing the quarterly billing dashboard layout',
    });
    expect(r2).toMatchObject({ crossFed: 0, enqueued: 0 });
    expect(off.enqueuePush).not.toHaveBeenCalled();
  });

  it('a subscribe failure is fail-soft: no entered notice, but the tick saves and the peer topic is still recorded for the cross-feed', async () => {
    const { mod, enqueuePush, saveAdjacencyState } = await withMocks({
      carry: { tick: 9, states: primedState(PEER, ['WI-4790', 'launcher']), topics: {} },
      subscribeImpl: async () => { throw new Error('coord_topics unavailable'); },
    });
    const r = await mod.runAdjacencyTick({
      selfSessionId: SELF,
      selfOwnerId: OWNER,
      snapshot: [candidate(PEER, 0.4, ['WI-4790', 'launcher'])],
      ownerBySession: new Map([[PEER, PEER_OWNER]]),
    });

    expect(r).toMatchObject({ ran: true, entered: 1, subscribed: 0, enqueued: 0 });
    expect(enqueuePush).not.toHaveBeenCalled(); // applied-only notice contract
    const saved = saveAdjacencyState.mock.calls[0]![0];
    expect(saved.topics[PEER]?.topic).toBe('adj:wi-4790+launcher'); // cross-feed still possible
  });

  it('a shared slug held by TWO adjacent peers is only unsubscribed when the last one exits', async () => {
    const PEER_B = 'su-peer-b';
    const slug: AdjacencyPeerTopic = { topic: 'adj:wi-4790+launcher', terms: ['WI-4790', 'launcher'], peerOwnerId: PEER_OWNER };
    const { mod, unsubscribeTopicFor } = await withMocks({
      carry: {
        tick: 20,
        states: [...adjacentState(PEER, ['WI-4790', 'launcher']), ...adjacentState(PEER_B, ['WI-4790', 'launcher'])],
        topics: { [PEER]: slug, [PEER_B]: { ...slug, peerOwnerId: 'own-peer-b' } },
      },
    });
    // PEER escalates out; PEER_B stays in-band ⇒ the shared slug stays subscribed.
    const r = await mod.runAdjacencyTick({
      selfSessionId: SELF,
      selfOwnerId: OWNER,
      snapshot: [candidate(PEER, 0.9, ['WI-4790', 'launcher']), candidate(PEER_B, 0.4, ['WI-4790', 'launcher'])],
    });
    expect(r).toMatchObject({ exited: 1, unsubscribed: 0 });
    expect(unsubscribeTopicFor).not.toHaveBeenCalled();
  });
});
