/**
 * rubrics-shipped-subject-guard.test.ts — EI-22078741539479611.
 *
 * A NEW acceptance rubric for an already-SHIPPED plan re-opens a settled ship gate
 * (the ship retired the plan's rubric; a fresh contract makes the plan read "shipped"
 * and "cannot be marked shipped" at once, and routes a redundant grading pass to a
 * peer). The decision and its refusal text are pure so this suite needs no PG; the
 * SQL that feeds them (`assertAcceptanceLinksResolve` reading the subject plan's
 * status) is a one-column widening of a query the integration suite already covers.
 *
 * FALSIFIABILITY: the positive case is paired with one control per input, each
 * flipping exactly one field, so a constant-return mutant fails on at least one side.
 */
import { describe, it, expect } from 'vitest';
import { acceptanceProposeReopensShippedPlan, shippedSubjectPlanRefusal } from './rubrics';

describe('acceptanceProposeReopensShippedPlan — the refusal predicate', () => {
  const reopens = { kind: 'acceptance', storedExists: false, subjectPlanStatus: 'shipped' } as const;

  it('refuses a NEW acceptance rubric whose subject plan is shipped', () => {
    expect(acceptanceProposeReopensShippedPlan(reopens)).toBe(true);
  });

  it('CONTROL: a standard-kind rubric is never refused on plan status', () => {
    expect(acceptanceProposeReopensShippedPlan({ ...reopens, kind: 'standard' })).toBe(false);
  });

  it('CONTROL: re-proposing an EXISTING rubricRef is left to the stored-lifecycle guard', () => {
    // EI-21909559308315843: a content-only edit of a retired rubric stays legal.
    expect(acceptanceProposeReopensShippedPlan({ ...reopens, storedExists: true })).toBe(false);
  });

  it('CONTROL: an unshipped subject plan takes its acceptance rubric as before', () => {
    for (const status of ['draft', 'ready', 'active', 'awaiting-acceptance', 'superseded', null]) {
      expect(acceptanceProposeReopensShippedPlan({ ...reopens, subjectPlanStatus: status })).toBe(false);
    }
  });
});

describe('shippedSubjectPlanRefusal — the teaching message', () => {
  const base = { rubricId: 'acceptance-plan-x-r2', subjectPlan: 'plan-x-2026-09-01' };

  it('names the code, the plan, the new rubric, and the retired record it protects', () => {
    const msg = shippedSubjectPlanRefusal({ ...base, retiredRubricId: 'acceptance-plan-x' });
    expect(msg).toMatch(/^invalid_args: proposeRubric: subject_plan_shipped/);
    expect(msg).toContain("'plan-x-2026-09-01' is already SHIPPED");
    expect(msg).toContain("'acceptance-plan-x-r2'");
    expect(msg).toContain("'acceptance-plan-x' was retired WITH the ship");
    expect(msg).toContain('EI-22078741539479611');
    // The deliberate re-open path is named, so the refusal is a redirect, not a wall.
    expect(msg).toMatch(/move the plan off shipped first/);
  });

  it('CONTROL: with no retired rubric on record it says so instead of inventing one', () => {
    const msg = shippedSubjectPlanRefusal({ ...base, retiredRubricId: null });
    expect(msg).toContain('no acceptance rubric on record');
    expect(msg).not.toContain('was retired WITH the ship');
  });
});
