/**
 * rubric-template.test.ts — the built-in `rubric` plan-template schema + its
 * self-registration (plan-templates-and-rubric-v2-2026-06-20 P-006).
 *
 * Pins the structured-data contract (the templateData jsonb shape) the re-pointed
 * rubrics store maps to the v1 Rubric, and that importing the module registers
 * `rubric` so the write path (plans:set-template-data → validateTemplateData) and the
 * read path (rubrics store) both resolve it. Pure (no PG).
 */
import { describe, it, expect } from 'vitest';
import {
  rubricTemplateDataSchema,
  rubricCriterionSchema,
  RUBRIC_TEMPLATE,
  RUBRIC_TEMPLATE_NAME,
  type RubricTemplateData,
} from './rubric-template';
import { getPlanTemplate, isKnownPlanTemplate, validateTemplateData } from './template-registry';
import type { RubricCriterion } from '../../rubrics';

// The brief's minimal rubric: characteristic + criteria[{key,title,model,method,driftMarkers}] + ratingScale.
const minimalCriterion = {
  key: 'placement-health',
  title: 'Placement health',
  model: 'The Queen places every ready, unblocked frontier item onto a live bee within a cadence.',
  method: 'Count ready work_items with no claim older than the cadence.',
  driftMarkers: 'A growing backlog of ready-but-unplaced items.',
};
const minimalData = {
  characteristic: 'hive-coordination',
  criteria: [minimalCriterion],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
};

describe('rubric template schema', () => {
  it('accepts the brief\'s minimal rubric (characteristic + criteria + ratingScale)', () => {
    const r = rubricTemplateDataSchema.safeParse(minimalData);
    expect(r.success).toBe(true);
  });

  it('accepts the full shape (methodRef + description + per-criterion ratingScale override)', () => {
    const r = rubricTemplateDataSchema.safeParse({
      ...minimalData,
      methodRef: 'hive-coordination-health-runbook',
      description: 'How well the placement/ideation/observation loop is turning.',
      criteria: [{ ...minimalCriterion, ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'] }],
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.criteria[0].ratingScale).toContain('n/a');
  });

  it('allows methodRef = null (explicit "no runbook")', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, methodRef: null }).success).toBe(true);
  });

  it('rejects an empty criteria list', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, criteria: [] }).success).toBe(false);
  });

  it('rejects an empty ratingScale', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, ratingScale: [] }).success).toBe(false);
  });

  it('rejects a criterion missing a required field (model)', () => {
    const { model: _drop, ...noModel } = minimalCriterion;
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, criteria: [noModel] }).success).toBe(false);
  });

  it('rejects a missing characteristic', () => {
    const { characteristic: _drop, ...noChar } = minimalData;
    expect(rubricTemplateDataSchema.safeParse(noChar).success).toBe(false);
  });

  it('is STRICT: rejects an unknown top-level field (fail-loud, D-004)', () => {
    expect(rubricTemplateDataSchema.safeParse({ ...minimalData, title: 'should live in frontmatter' }).success).toBe(
      false,
    );
  });

  it('is STRICT: rejects an unknown criterion field', () => {
    expect(
      rubricCriterionSchema.safeParse({ ...minimalCriterion, weight: 3 }).success,
    ).toBe(false);
  });
});

describe('self-registration', () => {
  it('importing the module registers the `rubric` template', () => {
    expect(isKnownPlanTemplate(RUBRIC_TEMPLATE_NAME)).toBe(true);
    expect(getPlanTemplate('rubric')?.name).toBe('rubric');
    expect(RUBRIC_TEMPLATE.name).toBe('rubric');
  });

  it('validateTemplateData("rubric", …) routes through the registered schema', () => {
    const ok = validateTemplateData('rubric', minimalData);
    expect(ok.ok).toBe(true);
    const bad = validateTemplateData('rubric', { ...minimalData, criteria: [] });
    expect(bad).toMatchObject({ ok: false, code: 'invalid_data' });
  });
});

describe('shape parity with the v1 Rubric', () => {
  it('a parsed criterion is assignable to RubricCriterion (compile-time pin)', () => {
    const data: RubricTemplateData = rubricTemplateDataSchema.parse(minimalData);
    // If the schema's criterion shape ever drifts from RubricCriterion, this fails tsc.
    const criterion: RubricCriterion = data.criteria[0];
    expect(criterion.key).toBe('placement-health');
  });
});
