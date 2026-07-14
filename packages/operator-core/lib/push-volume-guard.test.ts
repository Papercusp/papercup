/** push-volume-guard (ambient-semantic-push P-009, plan D-004): the per-class
 *  feed volume guard. Verifies it re-counts the delivered feed independently and
 *  flags over-budget / disallowed-severity / below-floor delivery, that a clean
 *  selectPushes round passes, and the window-level cumulative invariant. */
import { describe, it, expect } from 'vitest';
import {
  makePush,
  selectPushes,
  policyFor,
  DEFAULT_PUSH_POLICIES,
  type MatcherKind,
  type PushObject,
  type SelectPushesResult,
  type KnownContext,
} from './ambient-push';
import { checkPushVolume, checkWindowVolume, deliveredSeveritiesAllowed } from './push-volume-guard';

function push(matcherKind: MatcherKind, ref: string, score = 0.9): PushObject {
  return makePush({ matcherKind, handle: { kind: 'session', ref, query: ['x'] }, teaser: 't ' + ref, score });
}

/** A hand-built selection result (bypasses selectPushes so we can construct
 *  contract VIOLATIONS the pipeline would never itself produce). */
function selection(selected: PushObject[], dropped: PushObject[] = [], sessionClass: 'drone' | 'interactive' | 'gateway' = 'drone'): SelectPushesResult {
  return { selected, dropped: dropped.map((p) => ({ push: p, reason: 'budget-exhausted' as const })), policy: policyFor(sessionClass) };
}

describe('checkPushVolume — budget accounting', () => {
  it('a within-budget round is ok, overflow 0', () => {
    const rep = checkPushVolume({ selection: selection([push('collision', 'a')]), sessionClass: 'drone' });
    expect(rep.ok).toBe(true);
    expect(rep.withinBudget).toBe(true);
    expect(rep.overflow).toBe(0);
    expect(rep.budget).toBe(DEFAULT_PUSH_POLICIES.drone.budget); // 2
  });

  it('reports before/after volume (candidates vs delivered)', () => {
    const rep = checkPushVolume({ selection: selection([push('collision', 'a')], [push('collision', 'b'), push('dead-end', 'c')]), sessionClass: 'drone' });
    expect(rep.deliveredVolume).toBe(1);
    expect(rep.candidateVolume).toBe(3); // 1 delivered + 2 dropped
  });

  it('flags an over-budget delivered feed (independently of selectPushes)', () => {
    // Drone budget is 2 — hand-build a selection that shipped 3.
    const rep = checkPushVolume({ selection: selection([push('collision', 'a'), push('collision', 'b'), push('collision', 'c')]), sessionClass: 'drone' });
    expect(rep.ok).toBe(false);
    expect(rep.overflow).toBe(1);
    expect(rep.violations.map((v) => v.kind)).toContain('over-budget');
  });

  it('counts alreadyDelivered against the budget', () => {
    // 1 delivered now + 2 already this window = 3 > drone budget 2.
    const rep = checkPushVolume({ selection: selection([push('collision', 'a')]), sessionClass: 'drone', alreadyDelivered: 2 });
    expect(rep.totalAgainstBudget).toBe(3);
    expect(rep.remainingBudget).toBe(0);
    expect(rep.ok).toBe(false);
    expect(rep.overflow).toBe(1);
  });
});

describe('checkPushVolume — severity + floor invariants', () => {
  it('flags a disallowed severity delivered to a drone (info is drone-invisible)', () => {
    const rep = checkPushVolume({ selection: selection([push('insight', 'a')]), sessionClass: 'drone' }); // insight = info
    expect(rep.ok).toBe(false);
    expect(rep.violations.some((v) => v.kind === 'severity-not-allowed')).toBe(true);
  });

  it('flags a below-floor push that was delivered anyway', () => {
    const rep = checkPushVolume({ selection: selection([push('collision', 'a', 0.1)]), sessionClass: 'drone' }); // floor 0.4
    expect(rep.violations.some((v) => v.kind === 'below-floor-delivered')).toBe(true);
  });

  it('deliveredSeveritiesAllowed is a focused restatement of the severity gate', () => {
    expect(deliveredSeveritiesAllowed(selection([push('collision', 'a')]), policyFor('drone'))).toBe(true);
    expect(deliveredSeveritiesAllowed(selection([push('insight', 'a')]), policyFor('drone'))).toBe(false);
  });
});

describe('checkPushVolume — a real selectPushes round passes the guard', () => {
  it('over-supplied candidates get trimmed to budget by selectPushes, and the guard agrees', () => {
    const known: KnownContext = { refs: new Set() };
    const candidates = [push('collision', 'a'), push('collision', 'b'), push('dead-end', 'c'), push('dead-end', 'd')];
    const sel = selectPushes({ candidates, sessionClass: 'drone', known }); // budget 2
    expect(sel.selected).toHaveLength(2);

    const rep = checkPushVolume({ selection: sel, sessionClass: 'drone' });
    expect(rep.ok).toBe(true);
    expect(rep.deliveredVolume).toBe(2);
    expect(rep.candidateVolume).toBe(4);
  });
});

describe('checkWindowVolume — cumulative window invariant', () => {
  it('sums delivered across rounds and stays within budget', () => {
    const r = checkWindowVolume([selection([push('collision', 'a')]), selection([push('dead-end', 'b')])], 'drone');
    expect(r.delivered).toBe(2);
    expect(r.withinBudget).toBe(true); // exactly the drone budget of 2
  });

  it('flags a window whose cumulative delivered exceeds the class budget', () => {
    const rounds = [selection([push('collision', 'a')]), selection([push('collision', 'b')]), selection([push('dead-end', 'c')])];
    const r = checkWindowVolume(rounds, 'drone'); // 3 > budget 2
    expect(r.withinBudget).toBe(false);
    expect(r.overflow).toBe(1);
    expect(r.rounds).toBe(3);
  });
});
