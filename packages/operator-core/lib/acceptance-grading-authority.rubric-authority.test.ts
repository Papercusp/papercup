/**
 * R-2 of generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 (P-003):
 *
 *   "The grading authority for a plan-acceptance obligation is resolved solely from that
 *    plan's own rubric, so a plan whose rubric requires independence rejects a grade
 *    produced by the plan's implementer."
 *
 * Its falsifier has TWO arms, and both are exercised here:
 *   (a) a rubric requiring independence ACCEPTS a grade from its own implementer, or
 *   (b) a rubric permitting owner-authorized grading is REFUSED an owner grade.
 *
 * These are the pure decision functions, so the branches are tested directly rather than
 * through a database. `plan-acceptance-gate.test.ts` covers the wiring at the ship gate.
 */
import { describe, expect, it } from 'vitest';
import {
  gradingAuthorityAdmits,
  isOwnerFiledGrading,
  rubricGradingAuthority,
} from './acceptance-grading-authority';
import { RUBRIC_GRADING_AUTHORITIES } from './agent-tools/plans/rubric-template';

const OWNER = 'pc-admin-coord-ui';

describe('rubricGradingAuthority — the rubric is the only authority source (D-002)', () => {
  it('defaults to independent when the rubric declares nothing', () => {
    expect(rubricGradingAuthority({})).toBe('independent');
    expect(rubricGradingAuthority({ gradingAuthority: undefined })).toBe('independent');
    expect(rubricGradingAuthority({ gradingAuthority: null })).toBe('independent');
  });

  it('returns the declared authority when the rubric declares one', () => {
    expect(rubricGradingAuthority({ gradingAuthority: 'independent' })).toBe('independent');
    expect(rubricGradingAuthority({ gradingAuthority: 'owner-authorized' })).toBe('owner-authorized');
  });

  it('reads a missing rubric as independent rather than throwing', () => {
    expect(rubricGradingAuthority(null)).toBe('independent');
    expect(rubricGradingAuthority(undefined)).toBe('independent');
  });

  /**
   * CONTROL for the fail-closed claim, and the reason this is an equality test rather
   * than `rubric.gradingAuthority ?? 'independent'`.
   *
   * `??` only substitutes for null/undefined, so an unrecognized value (a legacy row, a
   * typo that bypassed the schema, a future third authority read by an older build)
   * passes straight THROUGH it. Downstream that value matches neither branch, which at
   * this seam reads as "independence not required" — the direction that admits a
   * self-graded plan. The deliberately-wrong implementation below is kept here as a
   * live control: it must disagree with the real resolver on exactly that input, or the
   * real one has silently regressed to the permissive shape.
   */
  it('fails CLOSED on an unrecognized authority, where a ?? default would leak it', () => {
    const rogue = { gradingAuthority: 'anyone-at-all' as never };

    expect(rubricGradingAuthority(rogue)).toBe('independent');

    const naivelyDefaulted = (r: { gradingAuthority?: string | null }) => r.gradingAuthority ?? 'independent';
    expect(naivelyDefaulted(rogue)).toBe('anyone-at-all');
    expect(naivelyDefaulted(rogue)).not.toBe(rubricGradingAuthority(rogue));
  });

  it('resolves every member of the derived union to itself (no member left unhandled)', () => {
    for (const authority of RUBRIC_GRADING_AUTHORITIES) {
      expect(rubricGradingAuthority({ gradingAuthority: authority })).toBe(authority);
    }
  });
});

describe('isOwnerFiledGrading — verified owner provenance, not a caller claim', () => {
  it('is true only for a card created by the owner authority id', () => {
    expect(isOwnerFiledGrading({ createdBy: OWNER }, OWNER)).toBe(true);
    expect(isOwnerFiledGrading({ createdBy: 'su-somebody' }, OWNER)).toBe(false);
  });

  it('treats absent/empty provenance as NOT owner-filed', () => {
    expect(isOwnerFiledGrading({ createdBy: null }, OWNER)).toBe(false);
    expect(isOwnerFiledGrading({ createdBy: undefined }, OWNER)).toBe(false);
    expect(isOwnerFiledGrading({}, OWNER)).toBe(false);
    // An empty createdBy must not match an empty ownerAuthorityId and manufacture an
    // owner grade out of two missing values.
    expect(isOwnerFiledGrading({ createdBy: '' }, '')).toBe(false);
  });
});

describe('gradingAuthorityAdmits — R-2 arms (a) and (b)', () => {
  it('admits an independent grading under EITHER authority', () => {
    for (const authority of RUBRIC_GRADING_AUTHORITIES) {
      expect(gradingAuthorityAdmits({ authority, isIndependent: true, isOwnerFiled: false })).toBe(true);
    }
  });

  // R-2 falsifier arm (a): this is the behavior whose ABSENCE falsifies the bar.
  it("REJECTS the implementer's own grade when the rubric requires independence", () => {
    expect(
      gradingAuthorityAdmits({ authority: 'independent', isIndependent: false, isOwnerFiled: false }),
    ).toBe(false);
  });

  // R-2 falsifier arm (b): refusing an owner grade under owner-authorized falsifies it.
  it('ADMITS an owner-filed grade when the rubric permits owner-authorized grading', () => {
    expect(
      gradingAuthorityAdmits({ authority: 'owner-authorized', isIndependent: false, isOwnerFiled: true }),
    ).toBe(true);
  });

  it('does NOT let owner-authorized open the gate to a non-owner implementer', () => {
    // The widening is scoped to the OWNER. An implementer who is not the owner stays
    // excluded, or 'owner-authorized' would degrade into "self-grading permitted".
    expect(
      gradingAuthorityAdmits({ authority: 'owner-authorized', isIndependent: false, isOwnerFiled: false }),
    ).toBe(false);
  });

  it('ignores owner provenance when the rubric requires independence', () => {
    // An owner-filed card does not need this branch under 'independent': an owner outside
    // the implementer lineage already satisfies isIndependent. Admitting it HERE would
    // silently widen independence-required plans, so the flag must not be consulted.
    expect(
      gradingAuthorityAdmits({ authority: 'independent', isIndependent: false, isOwnerFiled: true }),
    ).toBe(false);
  });
});
