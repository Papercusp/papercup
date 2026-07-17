/**
 * spec-pool-preview.test.ts — unit table for evaluateCollapseGuard (WI-5212).
 *
 * The threshold cases below are the REAL numbers from the 2026-07-16/17 incidents, so a
 * future threshold tweak that would have let either starvation through fails loudly here.
 */
import { describe, expect, it } from 'vitest';
import { evaluateCollapseGuard } from './spec-pool-preview';

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
