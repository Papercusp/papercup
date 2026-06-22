/**
 * rubrics-seed.integration.test.ts — verifies the founding 'hive-coordination-health'
 * rubric is served from its migrated rubric-template PLAN
 * (plan-templates-and-rubric-v2-2026-06-20 P-007). Migration 338 migrated the v1 table
 * seed (326/327) → a `template: rubric` plan (harness_plans), and Stage 2 drops the v1
 * table; this test applies the FULL migration set (createOrgTestDb) and asserts the store
 * (getRubric — now plans-only) resolves the seed ACTIVE with the LOCKED 14 canonical
 * criterion keys — the interface the Overwatch scorecard (P-004) and Scout digest
 * grouping (P-006) reference. A drift in the criteria set (rename/drop/reorder) fails this.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const rubrics = await import('./rubrics');
const { createOrgTestDb } = await import('../test/_org-test-db');

// The locked criteria interface (rubric-driven-observations D-003) — the founding 13
// (1:1 with the owner's Q1-Q13 scorecard) PLUS `scheduler-usage` (14th, appended by
// rubric mig 371 / hybrid-bee-scheduler-work-stealing-2026-06-22 P-004). Kept here as
// the test's own copy so a seed-vs-interface drift is caught, not silently absorbed.
// Order matters — the assertion is `.toEqual` against criteria.map(c => c.key).
const CANONICAL_KEYS = [
  'end-to-end-flow',
  'ideation-quality',
  'queen-workitem-selection',
  'queen-plan-selection',
  'parallel-distribution',
  'bee-execution',
  'bee-observation-quality',
  'overwatch-observation-quality',
  'watchdog-determinism',
  'coordination-comms',
  'chatter-economy',
  'coordination-utilization',
  'tool-utilization',
  'scheduler-usage',
];

let db: OrgTestDb;

beforeAll(async () => {
  // createOrgTestDb applies the WHOLE migration set: 326 (table) → 327 (table seed) →
  // 338 (table → rubric-template plan) → the Stage-2 DROP TABLE — so the seed survives
  // as a PLAN regardless of the table's fate.
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('migration 338 — the hive-coordination-health rubric is served from its plan', () => {
  it('resolves the founding rubric as ACTIVE with method_ref + the default rating scale', async () => {
    const r = await rubrics.getRubric('hive-coordination-health');
    expect(r).not.toBeNull();
    expect(r!.status).toBe('active'); // seeded ratified (active plan → active rubric)
    expect(r!.characteristic).toBe('hive-coordination');
    expect(r!.title).toBe('Hive coordination health');
    expect(r!.methodRef).toBe('hive-coordination-health'); // the agent-insights runbook slug
    expect(r!.ratingScale).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
    expect(r!.ratifiedBy).toBe('aviynw@gmail.com'); // the plan owner (active ⇒ ratifier)
    expect((r!.description ?? '').length).toBeGreaterThan(0);
  });

  it('carries exactly the 14 canonical criteria, in order, each fully specified', async () => {
    const r = await rubrics.getRubric('hive-coordination-health');
    expect(r!.criteria.map((c) => c.key)).toEqual(CANONICAL_KEYS);
    for (const c of r!.criteria) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.model.length).toBeGreaterThan(0);
      expect(c.method.length).toBeGreaterThan(0);
      expect(c.driftMarkers.length).toBeGreaterThan(0);
    }
  });

  it('appears in listRubrics(active) and is findable via search', async () => {
    expect((await rubrics.listRubrics({ status: 'active' })).map((x) => x.rubricId)).toContain(
      'hive-coordination-health',
    );
    expect((await rubrics.searchRubrics('coordination')).map((x) => x.rubricId)).toContain(
      'hive-coordination-health',
    );
  });

  it('is a single rubric-template plan row (the seed migration is idempotent)', async () => {
    const all = await rubrics.listRubrics({});
    expect(all.filter((x) => x.rubricId === 'hive-coordination-health')).toHaveLength(1);
  });
});
