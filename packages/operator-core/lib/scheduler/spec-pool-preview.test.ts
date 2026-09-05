/**
 * spec-pool-preview.test.ts — unit table for evaluateCollapseGuard (WI-5212).
 *
 * The threshold cases below are the REAL numbers from the 2026-07-16/17 incidents, so a
 * future threshold tweak that would have let either starvation through fails loudly here.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCollapseGuard,
  evaluateGoalFenceGuard,
  filterNodesEqual,
  hasGuaranteedPositiveGoalFence,
  isProvableSuperset,
} from './spec-pool-preview';
import type { FilterNode } from './claim-spec';

describe('evaluateCollapseGuard — refusal shapes', () => {
  it('REFUSES matched=0 of a nonempty pool (starvation #1: kind scope with zero rows)', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 321,
      previousMatched: null,
      previousSource: 'default',
      confirm: false,
    });
    expect(v.refuse).toBe(true);
    expect(v.errors[0]).toContain('0 of 321');
    expect(v.errors[0]).toContain('starved-fleet');
  });

  it('REFUSES an authored revision cratering 321 → 3 (near-miss #3: the NULL-poisoned plan fence)', () => {
    const v = evaluateCollapseGuard({
      matched: 3,
      pool: 321,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(true);
    expect(v.errors[0]).toContain('321 to 3');
    expect(v.errors[0]).toContain('EI-13306');
  });

  it('PASSES the healthy rev-6 fence (322 pool, 321 → 308 matched)', () => {
    const v = evaluateCollapseGuard({
      matched: 308,
      pool: 322,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
    expect(v.warning).toBeUndefined();
  });

  it('does NOT refuse an empty pool (0 of 0 = drained backlog, not a starving spec)', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 0,
      previousMatched: null,
      previousSource: 'default',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
  });

  it('does NOT refuse narrowing from the DEFAULT spec (authoring a deliberate lane) — warns instead', () => {
    const v = evaluateCollapseGuard({
      matched: 3,
      pool: 321,
      previousMatched: null,
      previousSource: 'default',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
    expect(v.warning).toContain('narrow lane');
  });

  it('does NOT refuse a revision of a small lane (previous < 20 rows has no meaningful ratio)', () => {
    const v = evaluateCollapseGuard({
      matched: 1,
      pool: 321,
      previousMatched: 10,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
    expect(v.warning).toContain('narrow lane');
  });

  it('boundary: previous=20 → threshold is max(5, ceil(1))=5; matched=4 refuses, matched=5 passes', () => {
    const base = { pool: 321, previousMatched: 20, previousSource: 'authored' as const, confirm: false };
    expect(evaluateCollapseGuard({ ...base, matched: 4 }).refuse).toBe(true);
    expect(evaluateCollapseGuard({ ...base, matched: 5 }).refuse).toBe(false);
  });

  it('confirmCollapse:true overrides BOTH refusal shapes and downgrades to a warning', () => {
    const zero = evaluateCollapseGuard({
      matched: 0,
      pool: 321,
      previousMatched: null,
      previousSource: 'default',
      confirm: true,
    });
    expect(zero.refuse).toBe(false);
    expect(zero.warning).toContain('confirmed by caller');

    const collapse = evaluateCollapseGuard({
      matched: 3,
      pool: 321,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: true,
    });
    expect(collapse.refuse).toBe(false);
    expect(collapse.warning).toContain('confirmed by caller');
  });

  it('confirmCollapse:true on a HEALTHY spec adds no warning (no cry-wolf)', () => {
    const v = evaluateCollapseGuard({
      matched: 300,
      pool: 321,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: true,
    });
    expect(v.refuse).toBe(false);
    expect(v.warning).toBeUndefined();
  });
});

describe('evaluateCollapseGuard — EI-18653814284166347 (superset blindness + no-delta refusal)', () => {
  const planLeaf: FilterNode = { field: 'plan', op: '=', value: 'p2p-release-lane' };
  const tagsLeaf: FilterNode = { field: 'tags', op: '=', value: 'p2p-release' };
  const rev6Filter: FilterNode = { all: [planLeaf] };
  const rev7SupersetFilter: FilterNode = { any: [rev6Filter, tagsLeaf] };

  it('REPRO: rev6→rev7 superset, both matching 0/1211 — the guard used to wrongly refuse this', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 1211,
      previousMatched: 0,
      previousSource: 'authored',
      confirm: false,
      filter: rev7SupersetFilter,
      previousFilter: rev6Filter,
    });
    expect(v.refuse).toBe(false);
  });

  it('defect #1 alone (no filter info supplied): matched=0, previousMatched=0 — no delta, do not refuse', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 1211,
      previousMatched: 0,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(false);
  });

  it('still REFUSES a genuine 0-match FIRST occurrence (previousMatched>0 → real narrowing, not a no-delta case)', () => {
    const v = evaluateCollapseGuard({
      matched: 0,
      pool: 1211,
      previousMatched: 500,
      previousSource: 'authored',
      confirm: false,
    });
    expect(v.refuse).toBe(true);
  });

  it('defect #2 alone: a provable superset with a HEALTHY previousMatched still short-circuits (never refuses)', () => {
    const v = evaluateCollapseGuard({
      matched: 2,
      pool: 1211,
      previousMatched: 500,
      previousSource: 'authored',
      confirm: false,
      filter: rev7SupersetFilter,
      previousFilter: rev6Filter,
    });
    expect(v.refuse).toBe(false);
  });

  it('does NOT short-circuit an unrelated any:[...] that does not literally contain the incumbent filter', () => {
    const unrelatedAny: FilterNode = { any: [tagsLeaf, { field: 'kind', op: '=', value: 'bug' }] };
    const v = evaluateCollapseGuard({
      matched: 3,
      pool: 1211,
      previousMatched: 321,
      previousSource: 'authored',
      confirm: false,
      filter: unrelatedAny,
      previousFilter: rev6Filter,
    });
    expect(v.refuse).toBe(true); // falls through to the ordinary revision-collapse check
  });
});

describe('evaluateGoalFenceGuard — EI-22389918023611568', () => {
  const goal: FilterNode = { field: 'goal', op: '=', value: 'goal-813959' };
  const kind: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] };

  it('REFUSES a widening replacement that drops an incumbent positive goal fence', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: { all: [goal, kind] },
      candidateFilter: kind,
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict.refuse).toBe(true);
    expect(verdict.errors[0]).toContain('DROPS the incumbent positive goal fence');
    expect(verdict.errors[0]).toContain('confirmGoalFenceDrop:true');
  });

  it('allows a replacement that retains the positive goal predicate', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goal,
      candidateFilter: { all: [goal, kind] },
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict).toEqual({ refuse: false, errors: [] });
  });

  it('does not mistake an OR arm for a guaranteed fence', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goal,
      candidateFilter: { any: [goal, kind] },
      previousSource: 'authored',
      confirm: false,
    });
    expect(verdict.refuse).toBe(true);
  });

  it('does not guard first authoring from the DEFAULT lane', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: undefined,
      candidateFilter: kind,
      previousSource: 'default',
      confirm: false,
    });
    expect(verdict).toEqual({ refuse: false, errors: [] });
  });

  it('requires a non-empty positive value for a useful goal fence', () => {
    expect(hasGuaranteedPositiveGoalFence({ field: 'goal', op: '=', value: '' })).toBe(false);
    expect(hasGuaranteedPositiveGoalFence({ field: 'goal', op: 'in', value: [] })).toBe(false);
    expect(hasGuaranteedPositiveGoalFence({ field: 'goal', op: 'in', value: ['', '  '] })).toBe(false);
    expect(hasGuaranteedPositiveGoalFence(goal)).toBe(true);
    expect(hasGuaranteedPositiveGoalFence({ not: goal })).toBe(false);
  });

  it('allows an explicitly acknowledged transition and emits the exclusion warning', () => {
    const verdict = evaluateGoalFenceGuard({
      previousFilter: goal,
      candidateFilter: kind,
      previousSource: 'authored',
      confirm: true,
    });
    expect(verdict.refuse).toBe(false);
    expect(verdict.warning).toContain('explicitly confirmed');
    expect(verdict.warning).toContain('EXCLUSION fence');
  });
});

describe('isProvableSuperset / filterNodesEqual', () => {
  const leaf: FilterNode = { field: 'kind', op: '=', value: 'bug' };
  const other: FilterNode = { field: 'tags', op: '=', value: 'p2p' };

  it('filterNodesEqual: identical leaves equal; different field/op/value do not', () => {
    expect(filterNodesEqual(leaf, { ...leaf })).toBe(true);
    expect(filterNodesEqual(leaf, other)).toBe(false);
    expect(filterNodesEqual(leaf, { field: 'kind', op: '!=', value: 'bug' })).toBe(false);
    expect(filterNodesEqual({ field: 'kind', op: 'in', value: ['a', 'b'] }, { field: 'kind', op: 'in', value: ['a', 'b'] })).toBe(true);
    expect(filterNodesEqual({ field: 'kind', op: 'in', value: ['a', 'b'] }, { field: 'kind', op: 'in', value: ['a', 'c'] })).toBe(false);
  });

  it('isProvableSuperset: true when candidate is any:[X, ...] and X equals previous', () => {
    expect(isProvableSuperset({ any: [leaf, other] }, leaf)).toBe(true);
  });

  it('isProvableSuperset: false when candidate is any:[...] but none of its children equal previous', () => {
    expect(isProvableSuperset({ any: [other] }, leaf)).toBe(false);
  });

  it('isProvableSuperset: false when candidate is not an any node at all (e.g. all:[...])', () => {
    expect(isProvableSuperset({ all: [leaf, other] }, leaf)).toBe(false);
  });

  it('isProvableSuperset: recurses into a nested any', () => {
    expect(isProvableSuperset({ any: [{ any: [leaf] }, other] }, leaf)).toBe(true);
  });
});
