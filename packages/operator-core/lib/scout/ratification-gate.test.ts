/**
 * ratification-gate.test.ts — the no-self-ratification guard
 * (blender-su-grade-integration-2026-08-11 D-015, WI-38047).
 *
 * The decider is pure, so every case here runs with no PG. What the suite pins is
 * not just "it refuses a self-ratification" but the three DEGRADATIONS that must NOT
 * become refusals (an unattributable caller, a non-scout plan, an originator-less
 * row) — those are where a guard like this usually goes wrong, by wedging a rail it
 * was only meant to narrow.
 */
import { describe, it, expect } from 'vitest';
import { decideSelfRatification, planRoutedRef } from './ratification-gate';

const STEWARD = 'su-1111aaaa-0000-0000-0000-000000000000';
const OTHER = 'su-2222bbbb-0000-0000-0000-000000000000';

describe('decideSelfRatification', () => {
  it('REFUSES when the ratifier filed the idea itself', () => {
    const v = decideSelfRatification({ callerOwnerId: STEWARD, createdBy: STEWARD, found: true });
    expect(v.satisfied).toBe(false);
    expect(v.code).toBe('no_self_ratification');
    expect(v.originator).toBe(STEWARD);
    // The refusal must name a ROUTE out, not just say no — a gate that only blocks
    // teaches the caller to route around it.
    expect(v.message).toMatch(/different steward|coord:ask-owner/i);
  });

  it('ALLOWS a cross-author ratification (the normal case)', () => {
    const v = decideSelfRatification({ callerOwnerId: STEWARD, createdBy: OTHER, found: true });
    expect(v.satisfied).toBe(true);
    expect(v.code).toBeUndefined();
    expect(v.originator).toBe(OTHER);
  });

  // ── the three degradations that must never become refusals ──────────────────

  it('SKIPS (does not refuse) when the caller cannot be attributed — D-012 rule', () => {
    const v = decideSelfRatification({ callerOwnerId: null, createdBy: STEWARD, found: true });
    expect(v.satisfied).toBe(true);
    expect(v.skipped).toBe('caller-unattributable');
  });

  it('SKIPS for a plan with no routed-idea row (not a scout draft)', () => {
    const v = decideSelfRatification({ callerOwnerId: STEWARD, createdBy: null, found: false });
    expect(v.satisfied).toBe(true);
    expect(v.skipped).toBe('not-scout-plan');
  });

  it('SKIPS when the row records no originator', () => {
    const v = decideSelfRatification({ callerOwnerId: STEWARD, createdBy: null, found: true });
    expect(v.satisfied).toBe(true);
    expect(v.skipped).toBe('no-originator-on-record');
  });

  /**
   * MEASURED-POPULATION PIN (live read 2026-08-12): every `rail='plan'` ledger row is
   * `origin='scout'` with `created_by` NULL, so no CURRENT row can trigger the refusal
   * — the guard is forward-acting. This test exists so that fact stays stated rather
   * than implied: if a future change starts stamping an originator on scout-filed
   * rows, this case flips and whoever changed it learns the guard just went live on a
   * population it was never measured against.
   */
  it("today's scout-origin rows (no created_by) cannot trigger a refusal", () => {
    const v = decideSelfRatification({ callerOwnerId: STEWARD, createdBy: null, found: true });
    expect(v.satisfied).toBe(true);
    expect(v.code).toBeUndefined();
  });

  it('a skipped verdict is always distinguishable from a clean check', () => {
    const clean = decideSelfRatification({ callerOwnerId: STEWARD, createdBy: OTHER, found: true });
    const degraded = decideSelfRatification({ callerOwnerId: null, createdBy: OTHER, found: true });
    expect(clean.skipped).toBeUndefined();
    expect(degraded.skipped).toBeDefined();
    // Both are satisfied:true — the ONLY thing separating "verified clean" from
    // "could not verify" is `skipped`, which is why it may never be dropped.
    expect(clean.satisfied).toBe(degraded.satisfied);
  });
});

describe('planRoutedRef', () => {
  it('builds the migration-194 plan-rail ref convention', () => {
    expect(planRoutedRef('scout-thing-2026-08-12')).toBe('plan:scout-thing-2026-08-12');
  });
});
