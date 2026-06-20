/**
 * rubrics-plan-leg.integration.test.ts — the v2 "a rubric is a plan" re-point's NEW
 * plans leg, end-to-end against REAL Postgres (plan-templates-and-rubric-v2 P-006).
 *
 * The existing rubrics.integration.test covers the v1 TABLE leg; this covers the leg
 * that seam was built for (scorecards.ts: "the backing changes"): rubrics resolved
 * from harness_plans rows with template='rubric', their template_data jsonb mapped to
 * the v1 Rubric. Proves what the pure mapper unit test can't:
 *   • the harness_plans column SELECT + the template / template_slug filters round-trip;
 *   • template_data jsonb (incl. a per-criterion ratingScale override) round-trips;
 *   • plan status → rubric status mapping over real rows;
 *   • the transitional UNION precedence — a PLAN wins over a same-id v1 TABLE row;
 *   • a malformed rubric-template plan degrades (skipped), never surfaced broken.
 *
 * Uses createFreshPgDb (the same parsing connection the rubrics table suite uses) so
 * jsonb columns deserialize to objects exactly as the production getOrgPg pool does.
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const rubrics = await import('./rubrics');

let db: FreshPgDb;

const rubricData = {
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

/** Insert a rubric-template plan row (the plans leg's input). */
async function insertRubricPlan(
  slug: string,
  opts: { status?: string; data?: unknown; title?: string; templateSlug?: string | null; archived?: boolean } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, created, updated, owner, archived, template, template_data, template_slug)
    VALUES ('default', 'papercusp', ${slug}, ${opts.title ?? slug}, ${opts.status ?? 'active'},
            '2026-06-20', '2026-06-20', 'queen-1', ${opts.archived ?? false}, 'rubric',
            ${JSON.stringify(opts.data ?? rubricData)}::text::jsonb, ${opts.templateSlug ?? null})`;
}

beforeAll(async () => {
  db = await createFreshPgDb('rpl');
  h.sql = db.sql;
  // The v1 table leg (real DDL) so the UNION precedence is exercised against the real schema.
  await db.sql.unsafe(readMigration('326-rubrics-store.sql')).simple();
  // The plans leg: the FAITHFUL harness_plans columns the rubric re-point reads (a
  // rubric-template plan; mig 329 added template/template_data, 299 template_slug).
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
      title text, status text, created text, updated text,
      updated_at timestamptz NOT NULL DEFAULT now(), owner text,
      archived boolean NOT NULL DEFAULT false,
      template text, template_data jsonb, template_slug text,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    )`);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.harness_plans`;
  await db.sql`TRUNCATE harness_shared.rubrics`;
});

describe('plans leg — a rubric-template plan resolves as a Rubric', () => {
  it('getRubric resolves a rubric-template plan; template_data + per-criterion scale round-trip', async () => {
    await insertRubricPlan('queen-placement-health');
    const r = await rubrics.getRubric('queen-placement-health');
    expect(r).not.toBeNull();
    expect(r!.rubricId).toBe('queen-placement-health');
    expect(r!.characteristic).toBe('hive-coordination');
    expect(r!.status).toBe('active'); // plan status 'active' → rubric 'active'
    expect(r!.criteria).toHaveLength(1);
    expect(r!.criteria[0].key).toBe('placement-health');
    expect(r!.criteria[0].ratingScale).toContain('n/a');
    expect(r!.methodRef).toBe('hive-coordination-health-runbook');
  });

  it('listRubrics includes it; a draft plan maps to a proposed rubric', async () => {
    await insertRubricPlan('active-r', { status: 'active' });
    await insertRubricPlan('draft-r', { status: 'draft' });
    const all = await rubrics.listRubrics({});
    expect(all.map((r) => r.rubricId).sort()).toEqual(['active-r', 'draft-r']);
    expect((await rubrics.listRubrics({ status: 'active' })).map((r) => r.rubricId)).toEqual(['active-r']);
    expect((await rubrics.listRubrics({ status: 'proposed' })).map((r) => r.rubricId)).toEqual(['draft-r']);
  });

  it('searchRubrics finds a rubric-template plan by characteristic / title', async () => {
    await insertRubricPlan('queen-placement-health');
    expect((await rubrics.searchRubrics('coordination')).map((r) => r.rubricId)).toContain('queen-placement-health');
    expect(await rubrics.searchRubrics('zzznotarubric')).toEqual([]);
  });

  it('excludes per-run INSTANCE plans (template_slug IS NOT NULL)', async () => {
    await insertRubricPlan('an-instance', { templateSlug: 'some-template' });
    expect(await rubrics.getRubric('an-instance')).toBeNull();
    expect(await rubrics.listRubrics({})).toEqual([]);
  });

  it('degrades a malformed rubric-template plan to null (skipped, not surfaced broken)', async () => {
    await insertRubricPlan('broken-r', { data: { characteristic: 'x', criteria: [], ratingScale: [] } });
    expect(await rubrics.getRubric('broken-r')).toBeNull();
    expect(await rubrics.listRubrics({})).toEqual([]);
  });
});

describe('transitional UNION — plans ∪ table', () => {
  it('a PLAN wins over a same-id v1 TABLE row (the new backing supersedes the legacy row)', async () => {
    // Seed the legacy table row (proposed), then a rubric-template plan with the same id (active).
    await rubrics.proposeRubric({
      rubricId: 'hive-coordination-health',
      characteristic: 'hive-coordination',
      title: 'v1 table row',
      criteria: rubricData.criteria,
      by: 'seed',
    });
    await insertRubricPlan('hive-coordination-health', { status: 'active', title: 'v2 plan' });

    const got = await rubrics.getRubric('hive-coordination-health');
    expect(got!.title).toBe('v2 plan'); // the plan won
    expect(got!.status).toBe('active');

    const all = await rubrics.listRubrics({});
    expect(all.filter((r) => r.rubricId === 'hive-coordination-health')).toHaveLength(1); // de-duped
  });

  it('a TABLE-only rubric still resolves (the seed stays live until P-007 migrates it)', async () => {
    await rubrics.proposeRubric({
      rubricId: 'seed-only',
      characteristic: 'memory-recall',
      title: 'Seed only',
      criteria: rubricData.criteria,
      status: 'active',
      by: 'seed',
    });
    expect((await rubrics.getRubric('seed-only'))?.title).toBe('Seed only');
    expect((await rubrics.listRubrics({})).map((r) => r.rubricId)).toContain('seed-only');
  });
});
