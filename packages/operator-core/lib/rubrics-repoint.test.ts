/**
 * rubrics-repoint.test.ts — the v2 "a rubric is a plan" re-point pure logic
 * (plan-templates-and-rubric-v2-2026-06-20 P-006).
 *
 * Pins the PG-free pieces of the store re-point: the plan-status → rubric-status
 * mapping, the rubric-template-plan-row → v1 Rubric mapper (incl. degrade-on-malformed),
 * and the transitional plans ∪ table merge (plans win on a slug collision). The two
 * SQL legs + the union end-to-end are covered by the rubrics integration suite; these
 * are the error-prone pure surfaces.
 */
import { describe, it, expect } from 'vitest';
import { planStatusToRubricStatus, planRowToRubric, mergeRubricLegs } from './rubrics';
import type { Rubric } from './rubrics';

const baseData = {
  characteristic: 'hive-coordination',
  criteria: [
    {
      key: 'placement-health',
      title: 'Placement health',
      model: 'The Queen places ready frontier items onto live bees within a cadence.',
      method: 'Count ready work_items with no claim older than the cadence.',
      driftMarkers: 'A growing backlog of ready-but-unplaced items.',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'],
    },
  ],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: 'hive-coordination-health-runbook',
  description: 'How well the loop is turning.',
};

const planRow = (over: Partial<Parameters<typeof planRowToRubric>[0]> = {}) => ({
  plan_slug: 'hive-coordination-health',
  workspace_id: 'default',
  title: 'Hive coordination health',
  status: 'active' as string | null,
  created: '2026-06-20',
  updated: '2026-06-20',
  updated_at: '2026-06-20T10:00:00.000Z',
  owner: 'queen-1',
  archived: false,
  template_data: baseData,
  ...over,
});

describe('planStatusToRubricStatus', () => {
  it('active|ready → active', () => {
    expect(planStatusToRubricStatus('active')).toBe('active');
    expect(planStatusToRubricStatus('ready')).toBe('active');
  });
  it('draft|unknown|null → proposed (not yet ratified)', () => {
    expect(planStatusToRubricStatus('draft')).toBe('proposed');
    expect(planStatusToRubricStatus('whatever')).toBe('proposed');
    expect(planStatusToRubricStatus(null)).toBe('proposed');
  });
  it('superseded|shipped → retired', () => {
    expect(planStatusToRubricStatus('superseded')).toBe('retired');
    expect(planStatusToRubricStatus('shipped')).toBe('retired');
  });
  it('archived overrides any status → retired', () => {
    expect(planStatusToRubricStatus('active', true)).toBe('retired');
    expect(planStatusToRubricStatus('draft', true)).toBe('retired');
  });
});

describe('planRowToRubric', () => {
  it('maps a valid rubric-template plan row to the v1 Rubric shape', () => {
    const r = planRowToRubric(planRow());
    expect(r).not.toBeNull();
    expect(r!.rubricId).toBe('hive-coordination-health');
    expect(r!.title).toBe('Hive coordination health');
    expect(r!.characteristic).toBe('hive-coordination');
    expect(r!.criteria).toHaveLength(1);
    expect(r!.criteria[0].key).toBe('placement-health');
    expect(r!.criteria[0].ratingScale).toContain('n/a'); // per-criterion override preserved
    expect(r!.ratingScale).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
    expect(r!.methodRef).toBe('hive-coordination-health-runbook');
    expect(r!.status).toBe('active');
    expect(r!.ratifiedBy).toBe('queen-1'); // active ⇒ owner recorded as ratifier
    expect(r!.updatedAt).toBe('2026-06-20T10:00:00.000Z');
  });

  it('falls back title → slug, description → "" when absent', () => {
    const { description: _d, ...noDesc } = baseData;
    const r = planRowToRubric(planRow({ title: null, template_data: noDesc }));
    expect(r!.title).toBe('hive-coordination-health');
    expect(r!.description).toBe('');
  });

  it('a draft plan ⇒ proposed rubric (ratifiedBy null)', () => {
    const r = planRowToRubric(planRow({ status: 'draft' }));
    expect(r!.status).toBe('proposed');
    expect(r!.ratifiedBy).toBeNull();
  });

  it('degrades to null when template_data is absent', () => {
    expect(planRowToRubric(planRow({ template_data: null }))).toBeNull();
  });

  it('degrades to null when template_data fails the rubric schema (malformed, not surfaced broken)', () => {
    expect(planRowToRubric(planRow({ template_data: { characteristic: 'x', criteria: [], ratingScale: [] } }))).toBeNull();
  });
});

describe('mergeRubricLegs (plans ∪ table, plans win)', () => {
  const mk = (id: string, status: Rubric['status'], from: string): Rubric => ({
    rubricId: id,
    workspaceId: 'default',
    characteristic: 'c',
    title: from,
    description: '',
    criteria: [],
    ratingScale: ['healthy'],
    methodRef: null,
    status,
    createdBy: null,
    proposedBy: null,
    ratifiedBy: null,
    createdAt: '2026-06-20T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
  });

  it('unions non-colliding rubrics from both legs', () => {
    const merged = mergeRubricLegs([mk('a', 'active', 'plan')], [mk('b', 'proposed', 'table')]);
    expect(merged.map((r) => r.rubricId).sort()).toEqual(['a', 'b']);
  });

  it('a PLAN wins over a same-id TABLE row (the new backing supersedes the legacy row)', () => {
    const merged = mergeRubricLegs([mk('dup', 'active', 'plan')], [mk('dup', 'proposed', 'table')]);
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('plan');
    expect(merged[0].status).toBe('active');
  });

  it('table-only and plan-only both pass through', () => {
    expect(mergeRubricLegs([], [mk('t', 'active', 'table')]).map((r) => r.rubricId)).toEqual(['t']);
    expect(mergeRubricLegs([mk('p', 'active', 'plan')], []).map((r) => r.rubricId)).toEqual(['p']);
  });
});
