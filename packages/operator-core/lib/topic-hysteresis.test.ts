/** topic-hysteresis (ambient-semantic-push P-008, plan D-009): the auto-sub /
 *  auto-UNsub state machine. Pure; the live actuation (real topics:subscribe/
 *  unsubscribe transport) is a deferred seam. Verifies each of D-009's five
 *  parts: hysteresis gap + asymmetric dwell, staleness backstop, provenance
 *  guard, bounded set, and the visible typed notice. */
import { describe, it, expect } from 'vitest';
import {
  hysteresisTick,
  validateHysteresisParams,
  DEFAULT_HYSTERESIS_PARAMS,
  type HysteresisParams,
  type TopicSubscription,
  type SubscriptionNotice,
} from './topic-hysteresis';

/** Fold a sequence of per-tick (relevance, hit?) samples for a single topic
 *  through the machine, returning the final state + every notice emitted. */
function runTopic(
  topic: string,
  samples: Array<{ rel: number; hit?: boolean }>,
  opts: { params?: HysteresisParams; initial?: TopicSubscription[] } = {},
): { subs: TopicSubscription[]; notices: SubscriptionNotice[] } {
  let subs = opts.initial ?? [];
  const notices: SubscriptionNotice[] = [];
  samples.forEach((s, i) => {
    const res = hysteresisTick({
      subscriptions: subs,
      relevanceByTopic: new Map([[topic, s.rel]]),
      hitTopics: s.hit ? new Set([topic]) : new Set(),
      tick: i,
      params: opts.params,
    });
    subs = res.subscriptions;
    notices.push(...res.notices);
  });
  return { subs, notices };
}

const rep = (rel: number, n: number, hit = false) => Array.from({ length: n }, () => ({ rel, hit }));

describe('validateHysteresisParams', () => {
  it('accepts the sane defaults', () => {
    expect(validateHysteresisParams(DEFAULT_HYSTERESIS_PARAMS)).toEqual([]);
  });
  it('flags a missing hysteresis gap and a non-asymmetric dwell', () => {
    const w = validateHysteresisParams({ ...DEFAULT_HYSTERESIS_PARAMS, exitThreshold: 0.6, exitDwell: 2 });
    expect(w.some((m) => /gap/.test(m))).toBe(true);
    expect(w.some((m) => /asymmetric|dwell/.test(m))).toBe(true);
  });
});

describe('D-009 §1 — hysteresis (enter/exit thresholds + asymmetric dwell)', () => {
  it('subscribes only after relevance holds ≥ enter for the full enter-dwell', () => {
    // enterDwell 3: two ticks high is not enough, the third subscribes.
    const two = runTopic('T', rep(0.6, 2, true));
    expect(two.subs[0].subscribed).toBe(false);
    expect(two.notices).toHaveLength(0);

    const three = runTopic('T', rep(0.6, 3, true));
    expect(three.subs[0].subscribed).toBe(true);
    expect(three.notices.map((n) => n.kind)).toEqual(['subscribed']);
  });

  it('a dip below enter resets the enter-dwell streak (must be CONSECUTIVE)', () => {
    const { subs } = runTopic('T', [{ rel: 0.6, hit: true }, { rel: 0.6, hit: true }, { rel: 0.1, hit: true }, { rel: 0.6, hit: true }, { rel: 0.6, hit: true }]);
    expect(subs[0].subscribed).toBe(false); // never 3 in a row
  });

  it('the gap holds a subscription: relevance between exit and enter never unsubscribes', () => {
    // Subscribe (3× 0.6), then sit at 0.35 (≥ exit 0.25, < enter 0.5) for a long time.
    const { subs, notices } = runTopic('T', [...rep(0.6, 3, true), ...rep(0.35, 15, true)]);
    expect(subs[0].subscribed).toBe(true);
    expect(notices.filter((n) => n.kind === 'unsubscribed')).toHaveLength(0);
  });

  it('unsubscribes after relevance stays < exit for the full exit-dwell (drift)', () => {
    // Subscribe, then 6 ticks < exit (still hitting, so staleness does not fire first).
    const { subs, notices } = runTopic('T', [...rep(0.6, 3, true), ...rep(0.1, 6, true)]);
    expect(subs[0].subscribed).toBe(false);
    const unsub = notices.find((n) => n.kind === 'unsubscribed')!;
    expect(unsub.reason).toMatch(/drift/);
  });
});

describe('D-009 §2 — staleness backstop', () => {
  it('unsubscribes a still-somewhat-relevant topic that gets no hit for stalenessTicks', () => {
    const params: HysteresisParams = { ...DEFAULT_HYSTERESIS_PARAMS, stalenessTicks: 5 };
    // Subscribe with hits, then hold at 0.4 (≥ exit, so drift never fires) with NO hits.
    const { subs, notices } = runTopic('T', [...rep(0.6, 3, true), ...rep(0.4, 5, false)], { params });
    expect(subs[0].subscribed).toBe(false);
    expect(notices.find((n) => n.kind === 'unsubscribed')!.reason).toMatch(/staleness/);
  });

  it('REGRESSION: a long-tracked topic gets a FRESH staleness clock at subscribe (no 2-tick flap)', () => {
    // Hits only land on subscribed topics, so a topic that hovers mid-band
    // (≥ exit, < enter) for ≥ stalenessTicks before finally subscribing used to
    // carry that clock in and get stale-kicked the very next tick — then re-earn
    // the dwell and flap forever, spamming subscribe/unsubscribe notice pairs.
    const params: HysteresisParams = { ...DEFAULT_HYSTERESIS_PARAMS, stalenessTicks: 5 };
    const { subs, notices } = runTopic('T', [...rep(0.4, 8, false), ...rep(0.7, 7, false)], { params });
    expect(notices.filter((n) => n.kind === 'subscribed')).toHaveLength(1); // once, not a flap
    // No hit ever landed: the backstop STILL fires — but timed from the subscribe,
    // not from tracking start (subscribe at tick 10; stale at tick 15).
    const cleared = notices.filter((n) => n.kind === 'unsubscribed');
    expect(cleared).toHaveLength(1);
    expect(cleared[0].reason).toMatch(/staleness/);
    expect(subs[0].subscribed).toBe(false);
  });
});

describe('D-009 §3 — provenance guard (manual is never auto-removed)', () => {
  const manual: TopicSubscription = {
    topic: 'M', provenance: 'manual', subscribed: true,
    aboveEnterStreak: 0, belowExitStreak: 0, ticksSinceHit: 0, lastRelevance: 0.6,
  };

  it('a manual subscription that drifts is FLAGGED, not unsubscribed', () => {
    const { subs, notices } = runTopic('M', rep(0.1, 6, true), { initial: [manual] });
    expect(subs[0].subscribed).toBe(true); // still subscribed
    expect(subs[0].provenance).toBe('manual');
    const flags = notices.filter((n) => n.kind === 'manual-removal-suggested');
    expect(flags).toHaveLength(1); // fired once, not every tick
    expect(notices.some((n) => n.kind === 'unsubscribed')).toBe(false);
  });

  it('re-suggests after a recovery + fresh drift', () => {
    const { notices } = runTopic('M', [...rep(0.1, 6, true), ...rep(0.6, 1, true), ...rep(0.1, 6, true)], { initial: [manual] });
    expect(notices.filter((n) => n.kind === 'manual-removal-suggested')).toHaveLength(2);
  });
});

describe('D-009 §4 — bounded set (overflow evicts the weakest auto-sub)', () => {
  it('caps the auto-subscribed set and evicts the lowest-relevance topic', () => {
    const params: HysteresisParams = { ...DEFAULT_HYSTERESIS_PARAMS, maxAutoSubscriptions: 2 };
    let subs: TopicSubscription[] = [];
    const notices: SubscriptionNotice[] = [];
    // Drive A=0.9, B=0.8, C=0.6 together for 3 ticks so all meet enter-dwell the same tick.
    for (let t = 0; t < 3; t++) {
      const res = hysteresisTick({
        subscriptions: subs,
        relevanceByTopic: new Map([['A', 0.9], ['B', 0.8], ['C', 0.6]]),
        hitTopics: new Set(['A', 'B', 'C']),
        tick: t,
        params,
      });
      subs = res.subscriptions;
      notices.push(...res.notices);
    }
    const on = new Set(subs.filter((s) => s.subscribed).map((s) => s.topic));
    expect(on).toEqual(new Set(['A', 'B'])); // C (weakest) evicted
    const evict = notices.find((n) => n.kind === 'overflow-evicted')!;
    expect(evict.topic).toBe('C');
  });
});

describe('D-009 §5 — visible notice + cheap re-subscription; and purity', () => {
  it('every change is a fully-explainable typed notice', () => {
    const { notices } = runTopic('T', [...rep(0.6, 3, true), ...rep(0.1, 6, true)]);
    for (const n of notices) {
      expect(n.reason.length).toBeGreaterThan(0);
      expect(n.topic).toBe('T');
      expect(['subscribed', 'unsubscribed', 'overflow-evicted', 'manual-removal-suggested']).toContain(n.kind);
    }
  });

  it('re-subscription after an unsub is cheap — the enter-dwell just reapplies', () => {
    const { subs, notices } = runTopic('T', [...rep(0.6, 3, true), ...rep(0.1, 6, true), ...rep(0.6, 3, true)]);
    expect(subs[0].subscribed).toBe(true);
    expect(notices.filter((n) => n.kind === 'subscribed')).toHaveLength(2); // subscribed twice
  });

  it('does not mutate the input state (pure)', () => {
    const initial: TopicSubscription[] = [
      { topic: 'T', provenance: 'auto', subscribed: true, aboveEnterStreak: 3, belowExitStreak: 0, ticksSinceHit: 0, lastRelevance: 0.6 },
    ];
    const snapshot = JSON.parse(JSON.stringify(initial));
    hysteresisTick({ subscriptions: initial, relevanceByTopic: new Map([['T', 0.05]]), tick: 1 });
    expect(initial).toEqual(snapshot); // untouched
  });

  it('a fully-drifted, unsubscribed auto candidate is pruned from the tracked set', () => {
    // A topic that samples 0 and never subscribes drifts out and is dropped.
    const { subs } = runTopic('T', rep(0, DEFAULT_HYSTERESIS_PARAMS.exitDwell + 1));
    expect(subs.find((s) => s.topic === 'T')).toBeUndefined();
  });
});
