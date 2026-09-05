import { describe, expect, it } from 'vitest';
import { normalizeRequirementSections, requirementSections } from './requirement-contract';
import { normalizeAcceptanceBarCriterion, planRowToRubric } from './rubrics';
import { acceptanceRubricCriterionSchema } from './agent-tools/plans/rubric-template';

const requirement = {
  key: 'export', title: 'Complete export', barKey: 'R-EXPORT',
  intent: { request: 'Export all customers matching my filters.', sourceRefs: ['session_turn:example'] },
  acceptance: {
    condition: 'Every authorized matching customer appears exactly once across all pages.',
    falsifier: 'An expected identifier is missing, repeated or has incorrect values.',
    requiredScope: ['pagination', 'permissions'], evidencePlane: 'tree' as const,
    passRatings: ['healthy'], mandatory: true, role: 'outcome' as const,
  },
  verification: { method: 'Export a known multi-page dataset and compare the complete IDs and values.' },
};

describe('unified requirement contract', () => {
  it('authors one promise and method, with no separately persisted aliases', () => {
    const canonical = normalizeAcceptanceBarCriterion(requirement);
    expect(canonical.model).toBe(requirement.acceptance.condition);
    expect(canonical.driftMarkers).toBe(requirement.acceptance.falsifier);
    expect(canonical.method).toBe(requirement.verification.method);
    expect(canonical.intent).toEqual(requirement.intent);
    expect(canonical).not.toHaveProperty('acceptance');
    expect(canonical).not.toHaveProperty('verification');
    expect(acceptanceRubricCriterionSchema.safeParse(canonical).success).toBe(true);
  });

  it.each([
    { model: 'Only export the first page.' },
    { bar: 'Only export the first page.' },
    { driftMarkers: 'Missing rows are allowed.' },
    { method: 'Only inspect the first page.' },
    { requiredScope: ['pagination'] },
    { mandatory: false },
  ])('refuses competing promises or methods: %j', (duplicate) => {
    expect(() => normalizeRequirementSections({ ...requirement, ...duplicate })).toThrow('requirement_alias_conflict');
  });

  it('accepts equivalent readback aliases without changing the canonical meaning', () => {
    expect(normalizeAcceptanceBarCriterion({
      ...requirement, model: ` ${requirement.acceptance.condition} `,
      requiredScope: ['permissions', 'pagination'],
    }).barHash).toBe(normalizeAcceptanceBarCriterion(requirement).barHash);
  });

  it('keeps the BAR fixed when a verification method improves; promise changes alter it', () => {
    const original = normalizeAcceptanceBarCriterion(requirement);
    expect(normalizeAcceptanceBarCriterion({ ...requirement, verification: { method: 'Repeat with ten pages and two accounts.' } }).barHash).toBe(original.barHash);
    expect(normalizeAcceptanceBarCriterion({ ...requirement, acceptance: { ...requirement.acceptance, condition: 'Export the first page.' } }).barHash).not.toBe(original.barHash);
    expect(normalizeAcceptanceBarCriterion({ ...requirement, intent: { request: 'Export only the first page.' } }).barHash).not.toBe(original.barHash);
  });

  it('preserves legacy criteria without manufacturing Intent', () => {
    const legacy = { key: 'old', title: 'Existing requirement', model: 'Existing promise', method: 'Existing check', driftMarkers: 'Failure' };
    expect(normalizeAcceptanceBarCriterion(legacy)).toEqual(legacy);
    expect(requirementSections(legacy).intent).toBeNull();
  });

  it('reads persisted intent, canonical acceptance and method through the existing rubric store', () => {
    const canonical = normalizeAcceptanceBarCriterion(requirement);
    const rubric = planRowToRubric({
      plan_slug: 'acceptance-export', workspace_id: 'test-workspace', harness_slug: 'test-harness',
      title: 'Export', status: 'active', created: '2026-09-05', updated: '2026-09-05',
      updated_at: '2026-09-05T00:00:00Z', version: 2, owner: 'author', archived: false,
      template_data: { kind: 'acceptance', subjectPlan: 'export', characteristic: 'export', criteria: [canonical], ratingScale: ['healthy', 'broken', 'unknown'] },
    });
    expect(rubric).not.toBeNull();
    expect(requirementSections(rubric!.criteria[0]!)).toMatchObject({
      intent: requirement.intent, acceptance: { condition: requirement.acceptance.condition },
      verification: { method: requirement.verification.method },
    });
  });
});
