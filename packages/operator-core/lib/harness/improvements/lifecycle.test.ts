/**
 * lifecycle.test.ts — the idea lifecycle state machine (self-learning-central
 * P-030/P-031, verified by Phase 7 / P-060).
 *
 * The recurrence-decay OUTCOME edge for the product/local class:
 *   - decay (signature stopped recurring ≥14 days) → verified(worked)
 *   - re-surface (signature recurred) → recurred(regressed) — the REOPEN
 * and the reopen path continues recurred → triaged (re-triage the regression).
 */

import { describe, it, expect } from 'vitest';
import {
  initializeIdeaLifecycle,
  updateIdeaLifecycle,
  isValidTransition,
  checkDecayOutcome,
  type IdeaLifecyclePayload,
  type IdeaLifecycleState,
} from './lifecycle';

function applied(p: Partial<IdeaLifecyclePayload> = {}): IdeaLifecyclePayload {
  return {
    state: 'applied',
    stateUpdatedAt: '2026-06-01T00:00:00.000Z',
    ideaType: 'product',
    triageDecision: 'place',
    ...p,
  };
}

describe('initializeIdeaLifecycle', () => {
  it('starts every captured idea at open with a timestamp', () => {
    const l = initializeIdeaLifecycle();
    expect(l.state).toBe('open');
    expect(Number.isNaN(Date.parse(l.stateUpdatedAt))).toBe(false);
  });
});

describe('updateIdeaLifecycle', () => {
  it('moves state and merges the triage context', () => {
    const l = updateIdeaLifecycle(initializeIdeaLifecycle(), 'triaged', {
      triageDecision: 'place',
      triageReason: 'product idea, target harness:sheets',
      ideaType: 'product',
    });
    expect(l.state).toBe('triaged');
    expect(l.triageDecision).toBe('place');
    expect(l.ideaType).toBe('product');
  });

  it('preserves earlier context fields across later transitions', () => {
    const triaged = updateIdeaLifecycle(initializeIdeaLifecycle(), 'triaged', {
      triageDecision: 'place',
      ideaType: 'product',
    });
    const appliedNow = updateIdeaLifecycle(triaged, 'applied');
    expect(appliedNow.state).toBe('applied');
    expect(appliedNow.triageDecision).toBe('place'); // carried forward
    expect(appliedNow.ideaType).toBe('product');
  });
});

describe('isValidTransition — the P-031 state machine', () => {
  const states: IdeaLifecycleState[] = ['open', 'triaged', 'applied', 'verified', 'recurred'];
  const allowed: Array<[IdeaLifecycleState, IdeaLifecycleState]> = [
    ['open', 'triaged'], // Queen decides
    ['triaged', 'triaged'], // Queen changes her decision pre-apply
    ['triaged', 'applied'], // implemented
    ['applied', 'verified'], // friction decayed
    ['applied', 'recurred'], // friction re-surfaced
    ['verified', 'recurred'], // re-surfaced after apparent decay
    ['recurred', 'triaged'], // re-triage the regression (the reopen)
    ['recurred', 'applied'], // re-applied after the regression fix
  ];

  it.each(allowed)('%s → %s is valid', (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  it('rejects every transition NOT in the allowed set (exhaustive)', () => {
    const allowedKeys = new Set(allowed.map(([f, t]) => `${f}>${t}`));
    for (const from of states) {
      for (const to of states) {
        if (allowedKeys.has(`${from}>${to}`)) continue;
        expect(isValidTransition(from, to), `${from} → ${to} must be invalid`).toBe(false);
      }
    }
  });

  it('there is no skipping triage: open can never jump straight to applied/verified', () => {
    expect(isValidTransition('open', 'applied')).toBe(false);
    expect(isValidTransition('open', 'verified')).toBe(false);
    expect(isValidTransition('open', 'recurred')).toBe(false);
  });
});

describe('checkDecayOutcome — the recurrence-decay outcome edge (P-030, D-003)', () => {
  it('REOPENS a regressed item: applied product idea whose signature recurred → recurred(regressed)', () => {
    // count > 1: the friction signature was captured again after the apply —
    // the watchdog's dedupScope:'open' re-filed the regression.
    const out = checkDecayOutcome(applied(), { count: 2, decayDays: 3, resolvedCount: 1 });
    expect(out).not.toBeNull();
    expect(out!.state).toBe('recurred');
    expect(out!.decayResult).toBe('regressed');
    // …and the reopen continues into re-triage (the loop closes).
    expect(isValidTransition(out!.state, 'triaged')).toBe(true);
  });

  it('verifies a decayed item: signature did NOT recur for ≥14 days → verified(worked)', () => {
    const out = checkDecayOutcome(applied(), { count: 1, decayDays: 21, resolvedCount: 1 });
    expect(out).not.toBeNull();
    expect(out!.state).toBe('verified');
    expect(out!.decayResult).toBe('worked');
    expect(out!.decayDays).toBe(21);
  });

  it('stays silent before the decay window closes (count=1, <14 days)', () => {
    expect(checkDecayOutcome(applied(), { count: 1, decayDays: 5, resolvedCount: 1 })).toBeNull();
  });

  it('class asymmetry (D-003): process NEVER decay-VERIFIES (earns gym A/B) but DOES mark recurred', () => {
    const processIdea = applied({ ideaType: 'process' });
    // Positive verification by decay is product-only — quiet 30 days is still null.
    expect(checkDecayOutcome(processIdea, { count: 1, decayDays: 30, resolvedCount: 1 })).toBeNull();
    // Regression evidence is class-independent: a re-surfaced signature marks recurred.
    const out = checkDecayOutcome(processIdea, { count: 2, decayDays: 3, resolvedCount: 1 });
    expect(out).not.toBeNull();
    expect(out!.state).toBe('recurred');
    expect(out!.decayResult).toBe('regressed');
  });

  it('only an APPLIED idea has a decay outcome (open/triaged/verified are not re-judged)', () => {
    for (const state of ['open', 'triaged', 'verified', 'recurred'] as const) {
      const l = applied({ state });
      expect(checkDecayOutcome(l, { count: 2, decayDays: 3, resolvedCount: 1 })).toBeNull();
    }
  });

  it('no recurrence data → no outcome (the Queen needs the digest signal first)', () => {
    expect(checkDecayOutcome(applied())).toBeNull();
  });
});
