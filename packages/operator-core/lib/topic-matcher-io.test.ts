/**
 * topic-matcher-io.test.ts — the P-008 topic auto-subscribe live-leg WIRING
 * (ambient-semantic-push-2026-07-14): the read → centroid-score → reconcile →
 * hysteresis-tick → actuate → notice pipeline against MOCKED stores (no PG —
 * the end-to-end-vs-real-PG proof is the integration test). The machine's own
 * math is covered by topic-hysteresis.test.ts; here we prove the live plumbing:
 * sustained cursor↔topic overlap writes a REAL (mocked-store) subscription +
 * a typed 'topic-sub' notice to self, and the three contracts that keep it from
 * becoming Clippy — manual subscriptions are never auto-removed, an externally
 * cancelled auto-sub is never re-subscribed (the opt-out), and actuation
 * failures patch the carried state so the edge retries instead of lying.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCursor } from './lexical-cursor';
import { reconcileSubscriptions, topicCentroidText, topicRelevance, type TopicLike } from './topic-matcher-io';
import { DEFAULT_HYSTERESIS_PARAMS, type HysteresisParams, type TopicSubscription } from './topic-hysteresis';
import type { EnqueuePushInput } from './push-delivery-store';
import type { SubscriptionRow, DeliveryMode } from './topic-subscription-store';

// The agent's work note — same fixture family as the sibling matcher tests: a
// WI id, a path, and domain terms give the cursor strong, legible join keys.
const WORK_NOTE = 'debugging psu-launcher.mjs restart loop under compaction — WI-4790 advisory lock';

/** A topic whose centroid shares the note's high-value terms (hot). */
const HOT_TOPIC: TopicLike = {
  slug: 'launcher-compaction-recovery',
  title: 'psu-launcher compaction recovery',
  description: 'psu-launcher.mjs restart loop under compaction — WI-4790 advisory lock recovery runbook',
};

/** A topic sharing no terms with the note (cold). */
const COLD_TOPIC: TopicLike = {
  slug: 'mac-vm-passwords',
  title: null,
  description: 'rotate the mac build VM sudo password quarterly',
};

function subRow(slug: string): SubscriptionRow {
  return { target_kind: 'topic', target_ref: slug } as unknown as SubscriptionRow;
}

function autoSubscribed(topic: string, overrides: Partial<TopicSubscription> = {}): TopicSubscription {
  return {
    topic,
    provenance: 'auto',
    subscribed: true,
    aboveEnterStreak: 0,
    belowExitStreak: 0,
    ticksSinceHit: 0,
    lastRelevance: 0.9,
    subscribedAtTick: 1,
    ...overrides,
  };
}

async function withMocks(opts: {
  cursorNote?: string | null; // null ⇒ no cursor row yet
  topics?: TopicLike[];
  realSubs?: string[]; // initially-active real topic subscriptions
  carry?: { tick: number; subscriptions: TopicSubscription[] };
  subscribeImpl?: () => Promise<void>;
}) {
  vi.resetModules();

  // In-memory carry state + real-subscription set, so multi-tick tests behave
  // like the real stores (a successful subscribe shows up in the next tick's
  // listTopicSubscriptions, exactly as PG would).
  const state = {
    tick: opts.carry?.tick ?? 0,
    subscriptions: (opts.carry?.subscriptions ?? []).map((s) => ({ ...s })),
  };
  const realSubs = new Set(opts.realSubs ?? []);

  const subscribeTopicFor = vi.fn<(owner: string, slug: string, mode: DeliveryMode) => Promise<void>>(
    opts.subscribeImpl ??
      (async (_owner, slug) => {
        realSubs.add(slug);
      }),
  );
  const unsubscribeTopicFor = vi.fn<(owner: string, slug: string) => Promise<void>>(async (_owner, slug) => {
    realSubs.delete(slug);
  });
  const listLiveTopics = vi.fn<(limit: number) => Promise<TopicLike[]>>(async () => opts.topics ?? []);
  const listTopicSubscriptions = vi.fn<(owner: string) => Promise<SubscriptionRow[]>>(async () =>
    [...realSubs].map(subRow),
  );
  const loadTopicState = vi.fn(async () => ({
    tick: state.tick,
    subscriptions: state.subscriptions.map((s) => ({ ...s })),
  }));
  const saveTopicState = vi.fn(
    async (input: { sessionId: string; ownerId: string | null; tick: number; subscriptions: TopicSubscription[] }) => {
      state.tick = input.tick;
      state.subscriptions = input.subscriptions;
    },
  );
  const enqueuePush = vi.fn<(input: EnqueuePushInput) => Promise<number>>(async () => 1);

  const hasCursor = opts.cursorNote != null;
  const cursor = buildCursor(hasCursor ? [opts.cursorNote!] : []);

  vi.doMock('./session-cursor-store', () => ({
    getSessionCursorRow: async () => (hasCursor ? ({ session_id: 'su-self' } as unknown) : null),
    rowToCursor: () => cursor,
  }));
  vi.doMock('./topic-hysteresis-store', () => ({ loadTopicState, saveTopicState }));
  vi.doMock('./topic-subscription-store', () => ({
    listLiveTopics,
    listTopicSubscriptions,
    subscribeTopicFor,
    unsubscribeTopicFor,
  }));
  vi.doMock('./push-delivery-store', () => ({ enqueuePush }));

  const mod = await import('./topic-matcher-io');
  return {
    mod,
    state,
    realSubs,
    subscribeTopicFor,
    unsubscribeTopicFor,
    listLiveTopics,
    listTopicSubscriptions,
    loadTopicState,
    saveTopicState,
    enqueuePush,
  };
}

const FAST: HysteresisParams = { ...DEFAULT_HYSTERESIS_PARAMS, enterDwell: 2, exitDwell: 2, stalenessTicks: 50 };

describe('pure helpers', () => {
  it('topicCentroidText folds slug, word-split slug, title, and description', () => {
    const text = topicCentroidText(HOT_TOPIC);
    expect(text).toContain('launcher-compaction-recovery');
    expect(text).toContain('launcher compaction recovery'); // the word-split form
    expect(text).toContain('WI-4790');
  });

  it('topicRelevance scores a term-sharing topic above enter and a disjoint one at ~0', () => {
    const cursor = buildCursor([WORK_NOTE]);
    const map = topicRelevance(cursor, [HOT_TOPIC, COLD_TOPIC]);
    expect(map.get(HOT_TOPIC.slug)!.score).toBeGreaterThanOrEqual(DEFAULT_HYSTERESIS_PARAMS.enterThreshold);
    expect(map.get(COLD_TOPIC.slug)!.score).toBe(0);
    expect(map.get(HOT_TOPIC.slug)!.sharedTerms.map((t) => t.term)).toContain('WI-4790');
  });

  it('reconcileSubscriptions: untracked real row → manual+subscribed; tracked-unsubscribed real row → manual; auto row gone → the opt-out marker', () => {
    const carried: TopicSubscription[] = [
      autoSubscribed('externally-cancelled'), // subscribed in carry, but NOT a real row any more
      autoSubscribed('still-real'),
      { ...autoSubscribed('tracked-only'), subscribed: false, provenance: 'auto', aboveEnterStreak: 1 },
    ];
    const out = reconcileSubscriptions(carried, new Set(['still-real', 'tracked-only', 'human-added']));
    const by = new Map(out.map((s) => [s.topic, s]));

    // The human's own subscription enters tracking as manual+subscribed.
    expect(by.get('human-added')).toMatchObject({ provenance: 'manual', subscribed: true });
    // A topic we merely tracked but someone subscribed for real → manual.
    expect(by.get('tracked-only')).toMatchObject({ provenance: 'manual', subscribed: true });
    // An auto-sub cancelled outside the machine → permanent opt-out (manual+off).
    expect(by.get('externally-cancelled')).toMatchObject({ provenance: 'manual', subscribed: false });
    // An auto-sub whose real row is intact stays auto.
    expect(by.get('still-real')).toMatchObject({ provenance: 'auto', subscribed: true });
  });
});

describe('runTopicTick — cursor → centroids → reconcile → tick → actuate → notice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns ran:false and touches no store when self has no owner identity', async () => {
    const { mod, listLiveTopics, enqueuePush, saveTopicState } = await withMocks({ cursorNote: WORK_NOTE });
    const r = await mod.runTopicTick({ selfSessionId: 'su-self', selfOwnerId: null });
    expect(r.ran).toBe(false);
    expect(listLiveTopics).not.toHaveBeenCalled();
    expect(enqueuePush).not.toHaveBeenCalled();
    expect(saveTopicState).not.toHaveBeenCalled();
  });

  it('returns ran:false when self has no cursor yet', async () => {
    const { mod, saveTopicState } = await withMocks({ cursorNote: null, topics: [HOT_TOPIC] });
    const r = await mod.runTopicTick({ selfSessionId: 'su-self', selfOwnerId: 'own-self' });
    expect(r.ran).toBe(false);
    expect(saveTopicState).not.toHaveBeenCalled();
  });

  it('auto-subscribes after the enter dwell: real (digest) subscription + one typed notice to self', async () => {
    const t = await withMocks({ cursorNote: WORK_NOTE, topics: [HOT_TOPIC, COLD_TOPIC] });
    const tickArgs = { selfSessionId: 'su-self', selfOwnerId: 'own-self', params: FAST };

    const first = await t.mod.runTopicTick(tickArgs); // streak 1 < enterDwell 2
    expect(first).toMatchObject({ ran: true, tick: 1, subscribed: 0, enqueued: 0 });
    expect(t.subscribeTopicFor).not.toHaveBeenCalled();

    const second = await t.mod.runTopicTick(tickArgs); // streak 2 ⇒ the enter edge
    expect(second).toMatchObject({ ran: true, tick: 2, subscribed: 1, enqueued: 1 });
    expect(t.subscribeTopicFor).toHaveBeenCalledTimes(1);
    expect(t.subscribeTopicFor).toHaveBeenCalledWith('own-self', HOT_TOPIC.slug, 'digest');

    const call = t.enqueuePush.mock.calls[0]![0];
    expect(call).toMatchObject({
      targetOwnerId: 'own-self',
      targetSessionId: 'su-self',
      matcherKind: 'topic-sub',
      severity: 'info', // SEVERITY_BY_MATCHER — drones never see it (D-004)
      handleKind: 'topic',
      handleRef: HOT_TOPIC.slug,
      score: t.mod.TOPIC_NOTICE_SCORE,
      sourceSessionId: null,
    });
    expect(call.teaser).toContain("subscribed '" + HOT_TOPIC.slug);
    expect(call.handleQuery).toContain('WI-4790'); // the legible "why" rides the re-pull query

    // Persisted state: the hot topic is subscribed auto; the cold one was pruned.
    const by = new Map(t.state.subscriptions.map((s) => [s.topic, s]));
    expect(by.get(HOT_TOPIC.slug)).toMatchObject({ provenance: 'auto', subscribed: true });
    expect(by.has(COLD_TOPIC.slug)).toBe(false);
  });

  it('never auto-removes a MANUAL subscription — flags it once, subscription row untouched', async () => {
    const t = await withMocks({
      cursorNote: WORK_NOTE, // shares nothing with the cold topic below
      topics: [COLD_TOPIC],
      realSubs: [COLD_TOPIC.slug], // a subscription this machine did not create
    });
    const tickArgs = { selfSessionId: 'su-self', selfOwnerId: 'own-self', params: FAST };

    await t.mod.runTopicTick(tickArgs); // drift streak 1
    const second = await t.mod.runTopicTick(tickArgs); // streak 2 ⇒ exit dwell met
    expect(second.suggested).toBe(1);
    const third = await t.mod.runTopicTick(tickArgs); // latched — no repeat
    expect(third.suggested).toBe(0);

    expect(t.unsubscribeTopicFor).not.toHaveBeenCalled();
    expect(t.realSubs.has(COLD_TOPIC.slug)).toBe(true);
    // Exactly one notice across all three ticks: the one suggestion.
    expect(t.enqueuePush).toHaveBeenCalledTimes(1);
    expect(t.enqueuePush.mock.calls[0]![0].teaser).toContain('manual-removal-suggested');
  });

  it('auto-unsubscribes on sustained drift: real row cancelled + typed notice', async () => {
    const t = await withMocks({
      cursorNote: WORK_NOTE, // disjoint from the cold topic ⇒ relevance 0
      topics: [COLD_TOPIC],
      realSubs: [COLD_TOPIC.slug],
      carry: { tick: 4, subscriptions: [autoSubscribed(COLD_TOPIC.slug)] }, // OUR auto-sub
    });
    const tickArgs = { selfSessionId: 'su-self', selfOwnerId: 'own-self', params: FAST };

    const first = await t.mod.runTopicTick(tickArgs); // drift streak 1
    expect(first.unsubscribed).toBe(0);
    const second = await t.mod.runTopicTick(tickArgs); // streak 2 ⇒ the exit edge
    expect(second.unsubscribed).toBe(1);
    expect(second.enqueued).toBe(1);

    expect(t.unsubscribeTopicFor).toHaveBeenCalledTimes(1);
    expect(t.unsubscribeTopicFor).toHaveBeenCalledWith('own-self', COLD_TOPIC.slug);
    expect(t.realSubs.has(COLD_TOPIC.slug)).toBe(false);
    expect(t.enqueuePush.mock.calls[0]![0].teaser).toContain("unsubscribed '" + COLD_TOPIC.slug);
  });

  it('an externally cancelled auto-sub becomes a permanent opt-out — never re-subscribed however hot', async () => {
    const t = await withMocks({
      cursorNote: WORK_NOTE,
      topics: [HOT_TOPIC], // still maximally relevant
      realSubs: [], // …but the human cancelled the row out from under us
      carry: { tick: 7, subscriptions: [autoSubscribed(HOT_TOPIC.slug, { aboveEnterStreak: 5 })] },
    });
    const tickArgs = { selfSessionId: 'su-self', selfOwnerId: 'own-self', params: FAST };

    for (let i = 0; i < 3; i++) await t.mod.runTopicTick(tickArgs);

    expect(t.subscribeTopicFor).not.toHaveBeenCalled();
    expect(t.unsubscribeTopicFor).not.toHaveBeenCalled();
    const by = new Map(t.state.subscriptions.map((s) => [s.topic, s]));
    expect(by.get(HOT_TOPIC.slug)).toMatchObject({ provenance: 'manual', subscribed: false });
  });

  it('patches the carried state on a subscribe failure so the edge retries (and never lies about the rows)', async () => {
    const t = await withMocks({
      cursorNote: WORK_NOTE,
      topics: [HOT_TOPIC],
      subscribeImpl: async () => {
        throw new Error('pg down');
      },
    });
    const params: HysteresisParams = { ...FAST, enterDwell: 1 };
    const tickArgs = { selfSessionId: 'su-self', selfOwnerId: 'own-self', params };

    const first = await t.mod.runTopicTick(tickArgs); // enter edge, actuation throws
    expect(first.ran).toBe(true);
    expect(first.subscribed).toBe(0);
    expect(first.enqueued).toBe(0); // no notice for a change that did not apply
    const by = new Map(t.state.subscriptions.map((s) => [s.topic, s]));
    expect(by.get(HOT_TOPIC.slug)).toMatchObject({ subscribed: false }); // patched, not lying

    await t.mod.runTopicTick(tickArgs); // the edge retries
    expect(t.subscribeTopicFor).toHaveBeenCalledTimes(2);
  });

  it('boundedTopicTick degrades to the zero result instead of throwing', async () => {
    const { mod } = await withMocks({ cursorNote: WORK_NOTE, topics: [HOT_TOPIC] });
    const r = await mod.boundedTopicTick({ selfSessionId: 'su-self', selfOwnerId: null });
    expect(r.ran).toBe(false);
  });
});
