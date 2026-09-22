import { describe, expect, it } from 'vitest';

import {
  applyRubricAmendment,
  assertNoSilentRubricLoss,
  planRowToRubric,
  type ProposeRubricInput,
  type Rubric,
  type RubricCriterion,
} from './rubrics';
import { rubricCriterionSchema } from './agent-tools/plans/rubric-template';

function makeCriterion(over: Partial<RubricCriterion> = {}): RubricCriterion {
  return {
    key: 'never-implements',
    title: 'Never implements',
    model: 'the goal owner files work, never edits',
    method: 'edit_attribution_ledger rows by the owner',
    driftMarkers: 'any edit-claim',
    ...over,
  };
}

function makeStored(criteria: RubricCriterion[]): Rubric {
  return {
    rubricId: 'goal-mode-e2e',
    workspaceId: 'ws',
    kind: 'standard',
    gradingAuthority: 'independent',
    characteristic: 'goal-mode',
    title: 'Goal mode e2e',
    description: '',
    criteria,
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
    methodRef: null,
    status: 'active',
    createdBy: 'su-author',
    proposedBy: 'su-author',
    ratifiedBy: 'su-ratifier',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function makeProposal(criteria: ProposeRubricInput['criteria'], over: Partial<ProposeRubricInput> = {}): ProposeRubricInput {
  return {
    rubricId: 'goal-mode-e2e',
    characteristic: 'goal-mode',
    title: 'Goal mode e2e',
    criteria,
    ...over,
  };
}

describe('criterionClass schema (P-008)', () => {
  it('accepts both classes and round-trips through the stored-shape schema', () => {
    for (const criterionClass of ['settle-once', 'violatable'] as const) {
      const parsed = rubricCriterionSchema.parse({ ...makeCriterion(), criterionClass });
      expect(parsed.criterionClass).toBe(criterionClass);
    }
    expect(rubricCriterionSchema.parse(makeCriterion()).criterionClass).toBeUndefined();
  });

  it('rejects an unknown class value (strict enum, fail-loud on write)', () => {
    expect(() =>
      rubricCriterionSchema.parse({ ...makeCriterion(), criterionClass: 'monotonic' }),
    ).toThrow();
  });

  it('planRowToRubric projects criterionClass off template_data', () => {
    const rubric = planRowToRubric({
      plan_slug: 'goal-mode-e2e',
      workspace_id: 'ws',
      harness_slug: 'papercusp',
      title: 'Goal mode e2e',
      status: 'active',
      created: '2026-08-01',
      updated: '2026-08-01',
      updated_at: '2026-08-01T00:00:00.000Z',
      owner: 'su-author',
      archived: false,
      template_data: {
        characteristic: 'goal-mode',
        ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
        criteria: [
          { ...makeCriterion(), criterionClass: 'violatable' },
          makeCriterion({ key: 'kickoff-portfolio-read' }),
        ],
      },
    } as Parameters<typeof planRowToRubric>[0]);
    expect(rubric).not.toBeNull();
    expect(rubric!.criteria[0].criterionClass).toBe('violatable');
    // Omitted stays omitted — 'settle-once' is a READ-side default, never materialized.
    expect(rubric!.criteria[1].criterionClass).toBeUndefined();
  });
});

describe('assertNoSilentRubricLoss — class downgrade guard (P-008)', () => {
  const storedViolatable = makeStored([makeCriterion({ criterionClass: 'violatable' })]);

  it('REFUSES a stored violatable criterion resubmitted without its class', () => {
    expect(() =>
      assertNoSilentRubricLoss(storedViolatable, makeProposal([makeCriterion()])),
    ).toThrow(/DOWNGRADES 1 'violatable' criterion.*never-implements.*classDowngradeReason/s);
  });

  it('REFUSES an explicit downgrade to settle-once the same way', () => {
    expect(() =>
      assertNoSilentRubricLoss(
        storedViolatable,
        makeProposal([makeCriterion({ criterionClass: 'settle-once' })]),
      ),
    ).toThrow(/DOWNGRADES/);
  });

  it('allows the downgrade with a non-empty classDowngradeReason (conscious, explained)', () => {
    expect(() =>
      assertNoSilentRubricLoss(
        storedViolatable,
        makeProposal([makeCriterion()], { classDowngradeReason: 'criterion re-scoped to a kickoff gate' }),
      ),
    ).not.toThrow();
  });

  it('never guards an upgrade or a same-class resubmission', () => {
    const storedUnclassed = makeStored([makeCriterion()]);
    expect(() =>
      assertNoSilentRubricLoss(
        storedUnclassed,
        makeProposal([makeCriterion({ criterionClass: 'violatable' })]),
      ),
    ).not.toThrow();
    expect(() =>
      assertNoSilentRubricLoss(
        storedViolatable,
        makeProposal([makeCriterion({ criterionClass: 'violatable' })]),
      ),
    ).not.toThrow();
  });

  it('CONTROL (falsifiability): a guard that ignores criterionClass passes the downgrade fixture', () => {
    // A deliberately-wrong guard — the pre-P-008 shape, which only checks key drops and
    // procedure shrink — accepts the exact downgrade the real guard refuses above. This
    // pins that the downgrade FIXTURE distinguishes a broken guard from a working one
    // (the assertions above cannot pass vacuously).
    const wrongGuardIgnoringClass = (stored: Rubric, input: ProposeRubricInput) => {
      const proposedKeys = new Set(input.criteria.map((c) => c.key));
      const dropped = stored.criteria.filter((c) => !proposedKeys.has(c.key));
      if (dropped.length > 0) throw new Error('drops criteria');
    };
    expect(() =>
      wrongGuardIgnoringClass(storedViolatable, makeProposal([makeCriterion()])),
    ).not.toThrow();
  });
});

describe('applyRubricAmendment — criterionClass patch (P-008)', () => {
  it('upgrades a criterion to violatable, preserving status + ratifier (no demotion)', () => {
    const stored = makeStored([makeCriterion(), makeCriterion({ key: 'kickoff-portfolio-read' })]);
    const out = applyRubricAmendment(stored, {
      rubricId: 'goal-mode-e2e',
      criterionClass: { key: 'never-implements', class: 'violatable' },
    });
    expect(out.status).toBe('active');
    expect(out.ratifiedBy).toBe('su-ratifier');
    const patched = out.criteria.find((c) => c.key === 'never-implements')!;
    expect(patched.criterionClass).toBe('violatable');
    // The untouched sibling is resubmitted verbatim — the propose loss-guards see the
    // full document.
    expect(out.criteria.find((c) => c.key === 'kickoff-portfolio-read')!.criterionClass).toBeUndefined();
  });

  it('REFUSES a downgrade through the amend path (that edit needs a fresh ratification)', () => {
    const stored = makeStored([makeCriterion({ criterionClass: 'violatable' })]);
    expect(() =>
      applyRubricAmendment(stored, {
        rubricId: 'goal-mode-e2e',
        criterionClass: { key: 'never-implements', class: 'settle-once' },
      }),
    ).toThrow(/invalid_args.*downgrading.*classDowngradeReason/s);
  });

  it('throws the teaching error on an unknown key, and counts a class-only amendment as an amendment', () => {
    const stored = makeStored([makeCriterion()]);
    expect(() =>
      applyRubricAmendment(stored, {
        rubricId: 'goal-mode-e2e',
        criterionClass: { key: 'no-such-key', class: 'violatable' },
      }),
    ).toThrow(/no criterion 'no-such-key'/);
    expect(() => applyRubricAmendment(stored, { rubricId: 'goal-mode-e2e' })).toThrow(/nothing to amend/);
  });
});
