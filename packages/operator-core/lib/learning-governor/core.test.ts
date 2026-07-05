/**
 * core.test.ts — learning-governor pure decision layer (self-learning-frontier
 * P-003 / FB-01). Pins the generalized gym rule (unregistered / disabled /
 * unbudgeted / exhausted ⇒ refuse; per-cycle budgets gate on existence), the
 * one-number rollup, and the gym/scout registrant mappings.
 */
import { describe, expect, it } from 'vitest';
import {
  LEARNING_GOVERNOR_BUDGET_FLOOR_USD,
  checkLoopVerdict,
  checkScoutWorkspaceCeiling,
  DEFAULT_SCOUT_WORKSPACE_CEILING_USD,
  gymLoopId,
  gymRegistrationInput,
  isScoutLoopId,
  remainingLoopBudgetUsd,
  scoutLoopId,
  scoutRegistrationInput,
  summarizeLearningSpend,
  GYM_REGISTRANT_PRIORITY,
  SCOUT_REGISTRANT_PRIORITY,
  type LearningLoopRegistration,
} from './core';

function reg(overrides: Partial<LearningLoopRegistration> = {}): LearningLoopRegistration {
  return {
    workspaceId: 'w',
    loopId: 'frontier:test-loop',
    displayName: 'Test loop',
    budgetKind: 'lifetime',
    budgetUsd: 10,
    spentUsd: 0,
    priority: 100,
    enabled: true,
    enforcement: 'governor',
    meta: null,
    registeredAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('checkLoopVerdict — the D-004 unattended-refusal rule', () => {
  it('refuses an UNREGISTERED loop (null/undefined registration)', () => {
    expect(checkLoopVerdict(null)).toEqual({ allow: false, reason: 'unregistered', remainingUsd: null });
    expect(checkLoopVerdict(undefined)).toEqual({ allow: false, reason: 'unregistered', remainingUsd: null });
  });

  it('refuses a disabled loop', () => {
    const v = checkLoopVerdict(reg({ enabled: false }));
    expect(v.allow).toBe(false);
    expect(v.reason).toBe('disabled');
  });

  it('refuses an UNBUDGETED loop — the gym null-budget precedent', () => {
    expect(checkLoopVerdict(reg({ budgetUsd: null }))).toEqual({
      allow: false,
      reason: 'unbudgeted',
      remainingUsd: null,
    });
  });

  it('allows a lifetime budget with remaining above the floor, reporting the remainder', () => {
    expect(checkLoopVerdict(reg({ budgetUsd: 10, spentUsd: 4 }))).toEqual({ allow: true, remainingUsd: 6 });
  });

  it('refuses a lifetime budget at or below the floor (exhausted), including overspend', () => {
    const atFloor = checkLoopVerdict(reg({ budgetUsd: 10, spentUsd: 10 - LEARNING_GOVERNOR_BUDGET_FLOOR_USD }));
    expect(atFloor).toEqual({ allow: false, reason: 'exhausted', remainingUsd: LEARNING_GOVERNOR_BUDGET_FLOOR_USD });
    const overspent = checkLoopVerdict(reg({ budgetUsd: 10, spentUsd: 12 }));
    expect(overspent.reason).toBe('exhausted');
    expect(overspent.remainingUsd).toBe(-2);
  });

  it('honors a floor override', () => {
    expect(checkLoopVerdict(reg({ budgetUsd: 10, spentUsd: 8 }), 5).reason).toBe('exhausted');
    expect(checkLoopVerdict(reg({ budgetUsd: 10, spentUsd: 8 }), 1).allow).toBe(true);
  });

  it('allows a per-cycle budget regardless of accumulated ledger spend (the loop caps each run)', () => {
    const v = checkLoopVerdict(reg({ budgetKind: 'per-cycle', budgetUsd: 1, spentUsd: 500 }));
    expect(v).toEqual({ allow: true, remainingUsd: 1 });
  });

  it('still refuses a per-cycle loop with no cap', () => {
    expect(checkLoopVerdict(reg({ budgetKind: 'per-cycle', budgetUsd: null })).reason).toBe('unbudgeted');
  });
});

describe('remainingLoopBudgetUsd', () => {
  it('lifetime = budget − spent; per-cycle = the cap; null budget = null', () => {
    expect(remainingLoopBudgetUsd(reg({ budgetUsd: 10, spentUsd: 3 }))).toBe(7);
    expect(remainingLoopBudgetUsd(reg({ budgetKind: 'per-cycle', budgetUsd: 1, spentUsd: 3 }))).toBe(1);
    expect(remainingLoopBudgetUsd(reg({ budgetUsd: null }))).toBeNull();
  });
});

describe('summarizeLearningSpend — the one visible number', () => {
  it('sums spend across every registrant, totals lifetime caps only, names unbudgeted loops', () => {
    const s = summarizeLearningSpend([
      reg({ loopId: 'gym:papercup', budgetUsd: 20, spentUsd: 5 }),
      reg({ loopId: 'blender:papercup', budgetKind: 'per-cycle', budgetUsd: 1, spentUsd: 2.5 }),
      reg({ loopId: 'frontier:replay', budgetUsd: null, spentUsd: 0 }),
    ]);
    expect(s.totalSpentUsd).toBe(7.5);
    expect(s.totalLifetimeBudgetUsd).toBe(20); // the per-cycle cap does not bound a total
    expect(s.loopCount).toBe(3);
    expect(s.unbudgetedLoopIds).toEqual(['frontier:replay']);
    expect(s.loops.map((l) => l.loopId)).toEqual(['gym:papercup', 'blender:papercup', 'frontier:replay']);
    expect(s.loops[0].remainingUsd).toBe(15);
  });

  it('reports null total budget when nothing has a lifetime cap', () => {
    const s = summarizeLearningSpend([reg({ budgetKind: 'per-cycle', budgetUsd: 1 })]);
    expect(s.totalLifetimeBudgetUsd).toBeNull();
  });

  it('handles an empty registry', () => {
    expect(summarizeLearningSpend([])).toEqual({
      totalSpentUsd: 0,
      totalLifetimeBudgetUsd: null,
      loopCount: 0,
      unbudgetedLoopIds: [],
      loops: [],
    });
  });
});

describe('registrant mappings — gym + scout become governor sub-budgets, zero behavior change', () => {
  it('gym autoloop row → lifetime mirror with budget AND spent overwritten (gym stays authoritative)', () => {
    const input = gymRegistrationInput({
      workspaceId: 'w',
      harnessSlug: 'papercup',
      enabled: true,
      budgetUsd: 25,
      spentUsd: 3.2,
    });
    expect(input).toEqual({
      workspaceId: 'w',
      loopId: 'gym:papercup',
      displayName: 'Gym autoloop (papercup)',
      budgetKind: 'lifetime',
      budgetUsd: 25,
      spentUsd: 3.2,
      priority: GYM_REGISTRANT_PRIORITY,
      enabled: true,
      enforcement: 'native',
    });
  });

  it('mirrors a null gym budget honestly (the row shows unbudgeted on the ledger too)', () => {
    const input = gymRegistrationInput({ workspaceId: 'w', harnessSlug: 'h', enabled: false, budgetUsd: null, spentUsd: 0 });
    expect(input.budgetUsd).toBeNull();
    expect(input.enabled).toBe(false);
  });

  it('scout → per-cycle mirror with spent PRESERVED (the governor is its only loop-level spend store)', () => {
    const input = scoutRegistrationInput({ workspaceId: 'w', harnessSlug: 'papercup', perCycleBudgetUsd: 1.5 });
    expect(input).toEqual({
      workspaceId: 'w',
      loopId: 'blender:papercup',
      displayName: 'Scout cadence (papercup)',
      budgetKind: 'per-cycle',
      budgetUsd: 1.5,
      priority: SCOUT_REGISTRANT_PRIORITY,
      enabled: true,
      enforcement: 'native',
    });
    expect('spentUsd' in input).toBe(false);
  });

  it('loop-id helpers are stable', () => {
    expect(gymLoopId('x')).toBe('gym:x');
    expect(scoutLoopId('x')).toBe('blender:x');
  });
});

describe('checkScoutWorkspaceCeiling — the P-051 aggregate scout gate (D-005)', () => {
  const scout = (hive: string, spentUsd: number) => reg({ loopId: scoutLoopId(hive), spentUsd });

  it('isScoutLoopId distinguishes scout:<hive> from other registrants', () => {
    expect(isScoutLoopId('blender:alpha')).toBe(true);
    expect(isScoutLoopId('gym:alpha')).toBe(false);
    expect(isScoutLoopId('frontier:transfer-harness')).toBe(false);
  });

  it('UNDER cap ⇒ proceed', () => {
    const v = checkScoutWorkspaceCeiling([scout('a', 1), scout('b', 2)], 10);
    expect(v.allow).toBe(true);
    expect(v.reason).toBeUndefined();
    expect(v.totalScoutSpentUsd).toBe(3);
    expect(v.remainingUsd).toBe(7);
    expect(v.scoutLoopCount).toBe(2);
  });

  it('OVER cap ⇒ refuse with workspace-ceiling-exceeded', () => {
    const v = checkScoutWorkspaceCeiling([scout('a', 6), scout('b', 5)], 10);
    expect(v.allow).toBe(false);
    expect(v.reason).toBe('workspace-ceiling-exceeded');
    expect(v.totalScoutSpentUsd).toBe(11);
    expect(v.remainingUsd).toBe(-1);
  });

  it('the ceiling SUMS ACROSS HIVES — three hives each under their own cap can still breach the aggregate', () => {
    // Each hive is a modest per-cycle spender; together they exceed the workspace cap.
    const v = checkScoutWorkspaceCeiling([scout('a', 4), scout('b', 4), scout('c', 4)], 10);
    expect(v.totalScoutSpentUsd).toBe(12);
    expect(v.allow).toBe(false);
    expect(v.scoutLoopCount).toBe(3);
  });

  it('exactly AT the cap ⇒ refuse (strictly-under semantics, like checkScoutBudget)', () => {
    expect(checkScoutWorkspaceCeiling([scout('a', 10)], 10).allow).toBe(false);
    expect(checkScoutWorkspaceCeiling([scout('a', 9.99)], 10).allow).toBe(true);
  });

  it('IGNORES gym + frontier registrants — only scout:<hive> spend counts toward the ceiling', () => {
    const v = checkScoutWorkspaceCeiling(
      [
        scout('a', 3),
        reg({ loopId: gymLoopId('a'), spentUsd: 50 }), // gym spend must NOT count
        reg({ loopId: 'frontier:transfer-harness', spentUsd: 50 }), // nor frontier
      ],
      10,
    );
    expect(v.totalScoutSpentUsd).toBe(3); // gym/frontier excluded
    expect(v.scoutLoopCount).toBe(1);
    expect(v.allow).toBe(true);
  });

  it('no scout registrants ⇒ zero sum, allow', () => {
    const v = checkScoutWorkspaceCeiling([reg({ loopId: gymLoopId('a'), spentUsd: 99 })], 10);
    expect(v.totalScoutSpentUsd).toBe(0);
    expect(v.scoutLoopCount).toBe(0);
    expect(v.allow).toBe(true);
  });

  it('defaults to DEFAULT_SCOUT_WORKSPACE_CEILING_USD when no cap is passed', () => {
    const v = checkScoutWorkspaceCeiling([scout('a', DEFAULT_SCOUT_WORKSPACE_CEILING_USD + 1)]);
    expect(v.ceilingUsd).toBe(DEFAULT_SCOUT_WORKSPACE_CEILING_USD);
    expect(v.allow).toBe(false);
  });
});
