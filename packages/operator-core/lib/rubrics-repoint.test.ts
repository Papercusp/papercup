/**
 * rubrics-repoint.test.ts — the v2 "a rubric is a plan" re-point pure logic
 * (plan-templates-and-rubric-v2-2026-06-20 P-006/P-007).
 *
 * Pins the PG-free pieces of the plans-only store: the plan-status ↔ rubric-status
 * mappings (both directions) and the rubric-template-plan-row → v1 Rubric mapper (incl.
 * degrade-on-malformed). The SQL read leg + the propose/ratify write path end-to-end are
 * covered by the rubrics integration suite; these are the error-prone pure surfaces.
 */
import { describe, it, expect, vi } from 'vitest';
import { planStatusToRubricStatus, rubricStatusToPlanStatus, planRowToRubric, getAcceptanceRubricsForPlan } from './rubrics';

const db = vi.hoisted(() => ({ getOrgPg: vi.fn() }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: db.getOrgPg,
}));

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
  methodRef: 'pot-coordination-health-runbook',
  description: 'How well the loop is turning.',
};

const planRow = (over: Partial<Parameters<typeof planRowToRubric>[0]> = {}) => ({
  plan_slug: 'pot-coordination-health',
  workspace_id: 'default',
  harness_slug: 'papercusp',
  title: 'Hive coordination health',
  status: 'active' as string | null,
  created: '2026-06-20',
  updated: '2026-06-20',
  updated_at: '2026-06-20T10:00:00.000Z',
  version: 3,
  owner: 'queen-1',
  archived: false,
  template_data: baseData,
  ...over,
});

describe('acceptance rubric read policy', () => {
  it('preserves the legacy empty fallback but strict callers receive the original IO failure', async () => {
    const error = new Error('policy store unavailable');
    db.getOrgPg.mockImplementation(() => { throw error; });
    expect(await getAcceptanceRubricsForPlan('subject-plan')).toEqual([]);
    await expect(getAcceptanceRubricsForPlan('subject-plan', { strict: true })).rejects.toBe(error);
  });

  it('a successfully read empty policy set is still empty in strict mode', async () => {
    db.getOrgPg.mockReturnValue({ sql: vi.fn(async () => []) });
    expect(await getAcceptanceRubricsForPlan('subject-plan', { strict: true })).toEqual([]);
  });
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
    expect(r!.rubricId).toBe('pot-coordination-health');
    expect(r!.revision).toBe(3);
    expect(r!.title).toBe('Hive coordination health');
    expect(r!.characteristic).toBe('hive-coordination');
    expect(r!.criteria).toHaveLength(1);
    expect(r!.criteria[0].key).toBe('placement-health');
    expect(r!.criteria[0].ratingScale).toContain('n/a'); // per-criterion override preserved
    expect(r!.ratingScale).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
    expect(r!.methodRef).toBe('pot-coordination-health-runbook');
    expect(r!.status).toBe('active');
    expect(r!.ratifiedBy).toBe('queen-1'); // active ⇒ owner recorded as ratifier
    expect(r!.updatedAt).toBe('2026-06-20T10:00:00.000Z');
  });

  it('projects persisted acceptance BAR metadata and derives bar as a model alias', () => {
    const model = 'The activation path produces coverage-evidence rows.';
    const r = planRowToRubric(
      planRow({
        template_data: {
          ...baseData,
          kind: 'acceptance',
          subjectPlan: 'some-plan-2026-09-04',
          criteria: [
            {
              key: 'activation-outcome',
              title: 'Coverage activation exists',
              model,
              method: 'Read the activation instrument.',
              driftMarkers: 'No coverage-evidence rows exist.',
              barKey: 'R-7',
              barHash: 'a'.repeat(64),
              role: 'outcome',
              mandatory: true,
              requiredScope: ['surface:coverage-row'],
              passRatings: ['pass'],
              barProvenance: {
                lifecycle: 'pre-implementation',
                declaredAt: '2026-09-04T12:00:00.000Z',
                declaredBy: 'su-author',
              },
            },
          ],
        },
      }),
    );

    expect(r?.criteria[0]).toMatchObject({
      model,
      bar: model,
      barKey: 'R-7',
      barHash: 'a'.repeat(64),
      role: 'outcome',
      mandatory: true,
      requiredScope: ['surface:coverage-row'],
      passRatings: ['pass'],
      barProvenance: {
        lifecycle: 'pre-implementation',
        declaredAt: '2026-09-04T12:00:00.000Z',
        declaredBy: 'su-author',
      },
    });
  });

  it('does not hide a rubric when a newer server added a BAR contract field', () => {
    const r = planRowToRubric(
      planRow({
        template_data: {
          ...baseData,
          kind: 'acceptance',
          subjectPlan: 'some-plan-2026-09-04',
          barSetHash: 'a'.repeat(64),
          barContract: {
            schemaVersion: 1,
            adoptionEpoch: 1,
            cohort: 'post-epoch',
            subjectPlanRevision: 3,
            seededAt: '2026-09-04T12:00:00.000Z',
            seededBy: 'su-author',
            futureServerField: { revision: 4 },
          },
        },
      }),
    );

    expect(r).not.toBeNull();
    expect(r?.barContract).toMatchObject({
      subjectPlanRevision: 3,
      futureServerField: { revision: 4 },
    });
  });

  it('projects only finite plan versions as the optional rubric revision', () => {
    expect(planRowToRubric(planRow({ version: '42' }))?.revision).toBe(42);
    expect(planRowToRubric(planRow({ version: null }))).not.toHaveProperty('revision');
    expect(planRowToRubric(planRow({ version: Number.NaN }))).not.toHaveProperty('revision');
    expect(planRowToRubric(planRow({ version: Number.POSITIVE_INFINITY }))).not.toHaveProperty('revision');
  });

  it('falls back title → slug, description → "" when absent', () => {
    const { description: _d, ...noDesc } = baseData;
    const r = planRowToRubric(planRow({ title: null, template_data: noDesc }));
    expect(r!.title).toBe('pot-coordination-health');
    expect(r!.description).toBe('');
  });

  it('a draft plan ⇒ proposed rubric (ratifiedBy null)', () => {
    const r = planRowToRubric(planRow({ status: 'draft' }));
    expect(r!.status).toBe('proposed');
    expect(r!.ratifiedBy).toBeNull();
  });

  it('persisted template_data provenance WINS over the owner fallback (EI-10751)', () => {
    const r = planRowToRubric(
      planRow({ template_data: { ...baseData, proposedBy: 'reviewer-b', ratifiedBy: 'queen-2' } }),
    );
    expect(r!.proposedBy).toBe('reviewer-b'); // the reviser, not the plan owner
    expect(r!.ratifiedBy).toBe('queen-2'); // the true ratifier, not the author
    expect(r!.createdBy).toBe('queen-1'); // the owner column stays the original creator
  });

  it('a persisted ratifiedBy on a NON-active row projects null — status still gates it', () => {
    const r = planRowToRubric(
      planRow({ status: 'draft', template_data: { ...baseData, ratifiedBy: 'queen-2' } }),
    );
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

describe('rubricStatusToPlanStatus (write-path inverse)', () => {
  it('proposed → draft (awaiting Queen ratification)', () => {
    expect(rubricStatusToPlanStatus('proposed')).toBe('draft');
  });
  it('active → active (ratified)', () => {
    expect(rubricStatusToPlanStatus('active')).toBe('active');
  });
  it('retired → superseded', () => {
    expect(rubricStatusToPlanStatus('retired')).toBe('superseded');
  });
  it('round-trips through planStatusToRubricStatus', () => {
    for (const s of ['proposed', 'active', 'retired'] as const) {
      expect(planStatusToRubricStatus(rubricStatusToPlanStatus(s))).toBe(s);
    }
  });
});
