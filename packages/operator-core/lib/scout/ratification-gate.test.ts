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
import { readFileSync } from 'node:fs';
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
   * ⚠ THIS IS A BEHAVIOURAL CLAIM ONLY — it says nothing about the live ledger.
   *
   * It used to be labelled a "MEASURED-POPULATION PIN (live read 2026-08-12)" asserting
   * that every `rail='plan'` row had `created_by` NULL, so the guard was forward-acting.
   * Its author anticipated the drift exactly ("if a future change starts stamping an
   * originator on scout-filed rows, this case flips") — but the flip could never reach
   * this test, because it passes `createdBy: null` BY HAND. It measures the pure
   * function, not the population, so it kept passing while the premise went false: as of
   * 2026-09-05 the plan rail holds 27 rows WITH an originator and the guard is LIVE.
   *
   * Kept for the behaviour it does test (a null originator is unprovable, so it may
   * never refuse). The population statement now lives where it can be re-run — see the
   * re-check query in ratification-gate.ts's header.
   */
  it('a null originator can never trigger a refusal (unprovable ⇒ never refuse)', () => {
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

/**
 * D-026 GUARD (blender-su-grade-integration-2026-08-11, WI-38057).
 *
 * D-026 ruled that guard (1) — the dangerous set — is ACCEPTED DOCTRINE, not pending
 * work, because the obvious keyword classifier measured 0.00 precision (30/30 of the
 * live plan-rail corpus flagged, 0 true positives on hand-check). The predictable way
 * that ruling gets undone is not an argument against it but a quiet re-implementation:
 * someone adds a second refusal code here and the accepted gap silently becomes a
 * classifier-as-gate — the exact false guarantee D-026 rejected.
 *
 * So the union is pinned to ONE member. A second refusal code fails this test with the
 * ruling attached, which forces a read of D-026 before the change lands rather than
 * after. This is a source-text guard on purpose: the type is erased at runtime, so a
 * type-level assertion would only be caught by `lint:tsc`, which is a separate verdict
 * an editor can bank before making this edit.
 */
describe('D-026 — the accepted dangerous-set gap stays accepted', () => {
  // Subject path is overridable so falsifiability can be proven against a COPY outside
  // the tree (the repo's tier-2 mutation-probe pattern). Mutating the real file to prove
  // a guard fires is unsafe here: git-sync sweeps the whole working tree on a timer and
  // can commit the mutant while the probe is legitimately holding it.
  const SUBJECT =
    process.env.SCOUT_RATIFICATION_GATE_PATH ??
    new URL('./ratification-gate.ts', import.meta.url);
  const SOURCE = readFileSync(SUBJECT, 'utf8');

  it('exposes exactly ONE refusal code (a second one means guard 1 was re-litigated)', () => {
    const union = /export type ScoutRatificationGateCode =([^;]+);/.exec(SOURCE);
    expect(union, 'ScoutRatificationGateCode declaration not found — did it move?').not.toBeNull();
    const members = union![1]
      .split('|')
      .map((m) => m.trim())
      .filter(Boolean);
    expect(
      members,
      'A new refusal code was added to ScoutRatificationGateCode. If it enforces the ' +
        'DANGEROUS SET, stop: blender-su-grade-integration-2026-08-11 D-026 accepted that ' +
        'gap deliberately, on a measured 0.00-precision baseline for keyword classification ' +
        'over the live plan-rail corpus. Beat that baseline (or show a measured true ' +
        'positive on the rail) and amend D-026 first; do not let a classifier become a gate ' +
        'by accretion.',
    ).toEqual(["'no_self_ratification'"]);
  });

  it('states the acceptance rather than leaving guard 1 to read as pending', () => {
    // The failure this catches is a REVERSION to "tracked as residue"/"known gap"
    // phrasing, which is what sent WI-38057 round the loop a second time.
    expect(SOURCE).toContain('D-026');
    expect(SOURCE).toContain('ACCEPTED AS DOCTRINE');
    expect(SOURCE).toMatch(/NOT PENDING|not pending/);
  });
});
