/** push-utilization (ambient-semantic-push P-011, plan D-005 / carry D-001):
 *  the utilization LEDGER + advisory eviction scorer. Pure; the live outcome
 *  probe (route-change / lock-taken / fact-read extraction) is a deferred seam.
 *  Verifies the funnel (pushed → pulled? → acted?), the per-matcher dashboard
 *  rows, and that the retire/tune/keep call is advisory-only + never fabricates
 *  a "not pulled" from a pending push. */
import { describe, it, expect } from 'vitest';
import { makePush, policyFor, type MatcherKind, type PushObject, type SelectPushesResult } from './ambient-push';
import {
  pushKey,
  buildLedger,
  scorePushUtilization,
  DEFAULT_UTILIZATION_PARAMS,
  type LedgerEntry,
  type PushOutcome,
  type ActedSignalKind,
} from './push-utilization';

function mkPushObj(matcherKind: MatcherKind, ref = 'r'): PushObject {
  return makePush({ matcherKind, handle: { kind: 'session', ref, query: ['alpha'] }, teaser: 'teaser ' + ref, score: 0.9 });
}

function deliveredEntry(matcherKind: MatcherKind, outcome: PushOutcome | null, ref = 'r'): LedgerEntry {
  const push = mkPushObj(matcherKind, ref);
  return { pushKey: pushKey(push), push, matcherKind, sessionClass: 'drone', delivery: { kind: 'delivered' }, outcome, observedAt: 0 };
}

/** N delivered entries for a matcher, `engaged` of them engaged. `via` picks how
 *  engagement is expressed: 'pull' (pulled), 'act' (acted-on-teaser, not pulled). */
function manyDelivered(matcherKind: MatcherKind, observed: number, engaged: number, via: 'pull' | 'act' = 'pull'): LedgerEntry[] {
  const out: LedgerEntry[] = [];
  for (let i = 0; i < observed; i++) {
    const isEngaged = i < engaged;
    const outcome: PushOutcome =
      via === 'pull'
        ? { pulled: isEngaged, acted: false }
        : { pulled: false, acted: isEngaged, ...(isEngaged ? { actionKind: 'route-change' as ActedSignalKind } : {}) };
    out.push(deliveredEntry(matcherKind, outcome, 'r' + i));
  }
  return out;
}

describe('pushKey', () => {
  it('is deterministic and joins the same push to itself', () => {
    expect(pushKey(mkPushObj('collision', 's1'))).toBe(pushKey(mkPushObj('collision', 's1')));
  });
  it('separates different matchers / refs / peer sources', () => {
    expect(pushKey(mkPushObj('collision', 's1'))).not.toBe(pushKey(mkPushObj('dead-end', 's1')));
    expect(pushKey(mkPushObj('collision', 's1'))).not.toBe(pushKey(mkPushObj('collision', 's2')));
  });
});

describe('buildLedger — join a selection round to outcomes', () => {
  const selection: SelectPushesResult = {
    selected: [mkPushObj('collision', 'peerA'), mkPushObj('insight', 'docB')],
    dropped: [
      { push: mkPushObj('collision', 'peerC'), reason: 'budget-exhausted' },
      { push: mkPushObj('insight', 'docD'), reason: 'severity-gated' },
    ],
    policy: policyFor('drone'),
  };

  it('delivered entries pick up their outcome from the map; dropped entries carry reason + null outcome', () => {
    const outcomes = new Map<string, PushOutcome>([[pushKey(mkPushObj('collision', 'peerA')), { pulled: true, acted: false }]]);
    const entries = buildLedger({ selection, sessionClass: 'drone', outcomes, now: () => 123 });

    expect(entries).toHaveLength(4);
    const delivered = entries.filter((e) => e.delivery.kind === 'delivered');
    const dropped = entries.filter((e) => e.delivery.kind === 'dropped');
    expect(delivered).toHaveLength(2);
    expect(dropped).toHaveLength(2);

    const peerA = delivered.find((e) => e.push.handle.ref === 'peerA')!;
    expect(peerA.outcome).toEqual({ pulled: true, acted: false });
    const docB = delivered.find((e) => e.push.handle.ref === 'docB')!;
    expect(docB.outcome).toBeNull(); // no outcome in the map → pending
    expect(peerA.observedAt).toBe(123);

    for (const d of dropped) expect(d.outcome).toBeNull();
    expect((dropped.find((e) => e.push.handle.ref === 'peerC')!.delivery as { reason: string }).reason).toBe('budget-exhausted');
  });

  it('with no outcomes map, every delivered entry is pending (outcome null)', () => {
    const entries = buildLedger({ selection, sessionClass: 'interactive' });
    for (const e of entries.filter((x) => x.delivery.kind === 'delivered')) expect(e.outcome).toBeNull();
  });
});

describe('scorePushUtilization — per-matcher aggregate', () => {
  it('counts delivered / observed / pulled / acted / engaged / ignored', () => {
    const entries = [
      deliveredEntry('collision', { pulled: true, acted: true, actionKind: 'lock-taken' }, 'a'),
      deliveredEntry('collision', { pulled: true, acted: false }, 'b'),
      deliveredEntry('collision', { pulled: false, acted: false }, 'c'), // observed, ignored
      deliveredEntry('collision', null, 'd'), // pending — excluded from observed
    ];
    const { matchers } = scorePushUtilization(entries);
    const col = matchers.find((m) => m.matcherKind === 'collision')!;
    expect(col.delivered).toBe(4);
    expect(col.observed).toBe(3); // the pending one is excluded
    expect(col.pulled).toBe(2);
    expect(col.acted).toBe(1);
    expect(col.engaged).toBe(2); // a (pull+act) and b (pull); c ignored
    expect(col.ignored).toBe(1); // c
    expect(col.actedByKind['lock-taken']).toBe(1);
  });

  it('computes pull/act/engagement rates over OBSERVED (pending never inflates the denominator)', () => {
    const entries = [
      deliveredEntry('dead-end', { pulled: true, acted: false }, 'a'),
      deliveredEntry('dead-end', { pulled: false, acted: false }, 'b'),
      deliveredEntry('dead-end', null, 'c'), // pending
    ];
    const de = scorePushUtilization(entries).matchers.find((m) => m.matcherKind === 'dead-end')!;
    expect(de.observed).toBe(2);
    expect(de.pullRate).toBe(0.5);
    expect(de.engagementRate).toBe(0.5);
    expect(de.actRate).toBe(0);
  });

  it('leaves rates null when nothing was observed (never a fabricated 0)', () => {
    const entries = [deliveredEntry('insight', null, 'a'), { ...deliveredEntry('insight', null, 'b'), delivery: { kind: 'dropped', reason: 'severity-gated' } as const }];
    const ins = scorePushUtilization(entries).matchers.find((m) => m.matcherKind === 'insight')!;
    expect(ins.observed).toBe(0);
    expect(ins.pullRate).toBeNull();
    expect(ins.engagementRate).toBeNull();
  });

  it('tallies drops by reason and computes deliveryRate = delivered / (delivered + dropped)', () => {
    const entries = [
      deliveredEntry('collision', { pulled: true, acted: false }, 'a'),
      { ...deliveredEntry('collision', null, 'b'), delivery: { kind: 'dropped', reason: 'not-novel' } as const },
      { ...deliveredEntry('collision', null, 'c'), delivery: { kind: 'dropped', reason: 'below-floor' } as const },
      { ...deliveredEntry('collision', null, 'd'), delivery: { kind: 'dropped', reason: 'not-novel' } as const },
    ];
    const col = scorePushUtilization(entries).matchers.find((m) => m.matcherKind === 'collision')!;
    expect(col.totalDropped).toBe(3);
    expect(col.droppedByReason['not-novel']).toBe(2);
    expect(col.droppedByReason['below-floor']).toBe(1);
    expect(col.deliveryRate).toBeCloseTo(1 / 4);
  });

  it('orders dashboard rows by ship/severity (collision first, insight last)', () => {
    const entries = [deliveredEntry('insight', null, 'a'), deliveredEntry('collision', null, 'b'), deliveredEntry('topic-sub', null, 'c'), deliveredEntry('dead-end', null, 'd')];
    const order = scorePushUtilization(entries).matchers.map((m) => m.matcherKind);
    expect(order).toEqual(['collision', 'dead-end', 'topic-sub', 'insight']);
  });

  it('rolls up totals across matchers', () => {
    const entries = [...manyDelivered('collision', 4, 3), ...manyDelivered('insight', 2, 0)];
    const { totals } = scorePushUtilization(entries);
    expect(totals.delivered).toBe(6);
    expect(totals.observed).toBe(6);
    expect(totals.pulled).toBe(3);
    expect(totals.engaged).toBe(3);
  });
});

describe('scorePushUtilization — advisory recommendation (D-005, human-ratified)', () => {
  it('insufficient data below minObserved → gather-more-data, never retire', () => {
    const rec = scorePushUtilization(manyDelivered('collision', 19, 0)).recommendations.find((r) => r.matcherKind === 'collision')!;
    expect(rec.verdict).toBe('insufficient-data');
    expect(rec.suggestedAction).toBe('gather-more-data');
  });

  it('healthy engagement (≥ 0.5) → keep', () => {
    const rec = scorePushUtilization(manyDelivered('collision', 20, 10)).recommendations.find((r) => r.matcherKind === 'collision')!;
    expect(rec.verdict).toBe('healthy');
    expect(rec.suggestedAction).toBe('keep');
    expect(rec.engagementRate).toBe(0.5);
  });

  it('very low engagement (< 0.2) → retire', () => {
    const rec = scorePushUtilization(manyDelivered('insight', 20, 3)).recommendations.find((r) => r.matcherKind === 'insight')!;
    expect(rec.verdict).toBe('underutilized');
    expect(rec.suggestedAction).toBe('retire');
  });

  it('middling engagement (in [0.2, 0.5)) → tune, not retire', () => {
    const rec = scorePushUtilization(manyDelivered('topic-sub', 20, 6)).recommendations.find((r) => r.matcherKind === 'topic-sub')!;
    expect(rec.verdict).toBe('underutilized');
    expect(rec.suggestedAction).toBe('tune');
  });

  it('acting on the teaser alone (no pull) still counts as engagement', () => {
    const report = scorePushUtilization(manyDelivered('collision', 20, 20, 'act'));
    const col = report.matchers.find((m) => m.matcherKind === 'collision')!;
    expect(col.pullRate).toBe(0); // nobody pulled
    expect(col.actRate).toBe(1);
    expect(col.engagementRate).toBe(1);
    expect(report.recommendations.find((r) => r.matcherKind === 'collision')!.suggestedAction).toBe('keep');
  });

  it('honors custom params (a stricter healthy bar flips keep → tune)', () => {
    const strict = { ...DEFAULT_UTILIZATION_PARAMS, healthyEngagementRate: 0.8 };
    const rec = scorePushUtilization(manyDelivered('collision', 20, 10), strict).recommendations.find((r) => r.matcherKind === 'collision')!;
    expect(rec.suggestedAction).toBe('tune'); // 0.5 now below the 0.8 bar
  });

  it('stamps advisoryOnly true on the report and every recommendation', () => {
    const report = scorePushUtilization(manyDelivered('collision', 20, 10));
    expect(report.advisoryOnly).toBe(true);
    for (const r of report.recommendations) expect(r.advisoryOnly).toBe(true);
  });
});
