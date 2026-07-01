/**
 * rubrics.integration.test.ts — the PLANS-BACKED rubrics store end-to-end against the
 * real migrated Postgres (plan-templates-and-rubric-v2-2026-06-20 P-006/P-007).
 *
 * v2: a RUBRIC IS A PLAN. The store reads/writes `template: rubric` plans
 * (harness_shared.harness_plans), NOT the dropped v1 standalone table. This suite drives
 * the full surface over the real schema (createOrgTestDb applies the whole migration set,
 * so withPlanLock's content + template_data writes hit the production column layout):
 *   • READS — a rubric-template plan resolves as a Rubric; template_data (incl. a
 *     per-criterion ratingScale override) round-trips; plan status → rubric status; an
 *     instance plan (template_slug) is excluded; a malformed plan degrades (skipped);
 *   • WRITES — proposeRubric authors a draft (proposed) rubric-template plan; ratifyRubric
 *     promotes it active; status:'active' authors a ratified rubric directly; re-propose
 *     is an idempotent upsert (no duplicate PK row);
 *   • list/get/search over the plan rows (active-first ordering, status/characteristic
 *     filters, in-process token search).
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import { runWithWorkspace } from './workspace-als';
import { activeWorkspaceId } from './workspace-registry';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

// The re-pointed writes go through withPlanLock → withWorkspace; the reads through
// getOrgPg. Mock BOTH onto the migrated throwaway DB's admin (RLS-bypass) client — the
// withPlanLock advisory xact-lock needs a real transaction, which `.begin` provides.
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      h.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return cb(tx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

const rubrics = await import('./rubrics');
const { createOrgTestDb } = await import('../test/_org-test-db');

let db: OrgTestDb;

const sampleCriteria = [
  {
    key: 'placement-health',
    title: 'Placement health',
    model: 'The Queen places every ready, unblocked frontier item onto a live bee within a cadence.',
    method: 'Count ready work_items with no claim older than the cadence; check fleet:assignments load balance.',
    driftMarkers: 'A growing backlog of ready-but-unplaced items; bees idle while the frontier is non-empty.',
  },
  {
    key: 'ideation-diversity',
    title: 'Ideation diversity',
    model: 'Scout lens weights drift away from uniform as grades steer ideation.',
    method: 'Inspect lens_weights; off-uniform 0.25 means grades are steering.',
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'], // per-criterion override
    driftMarkers: 'Lens weights stuck uniform; repeated near-identical ideas.',
  },
];

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

/** Insert a rubric-template plan row directly (admin/bypass) — the read leg's input,
 *  for read-path edge cases that the write path can't author (malformed data, an
 *  instance plan, a specific status). Provides the NOT-NULL plan columns minimally. */
async function insertRubricPlan(
  slug: string,
  opts: { status?: string; data?: unknown; title?: string; templateSlug?: string | null; archived?: boolean; workspaceId?: string } = {},
) {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, template_data, template_slug, origin)
    VALUES (${opts.workspaceId ?? 'default'}, 'papercusp', ${slug}, '', md5(${slug}), 1, ${opts.title ?? slug},
            ${opts.status ?? 'active'}, '2026-06-20', '2026-06-20', 'queen-1', ${opts.archived ?? false},
            'rubric', ${JSON.stringify(opts.data ?? rubricData)}::text::jsonb, ${opts.templateSlug ?? null}, 'local')`;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  // Wipe the migration-seeded rubric plan (mig 338) + any prior test rows so each
  // case asserts against a clean rubric set.
  await db.adminSql`TRUNCATE harness_shared.harness_plans`;
});

describe('reads — a rubric-template plan resolves as a Rubric', () => {
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

describe('writes — propose / ratify author + promote a rubric-template plan', () => {
  it('propose creates a PROPOSED rubric (draft plan) with criteria + default rating scale', async () => {
    const r = await rubrics.proposeRubric({
      rubricId: 'hive-coordination-health',
      characteristic: 'hive-coordination',
      title: 'Hive coordination health',
      description: 'How well the placement/ideation/observation loop is turning.',
      criteria: sampleCriteria,
      methodRef: 'hive-coordination-health-runbook',
      by: 'su-test',
    });
    expect(r.status).toBe('proposed');
    expect(r.ratingScale).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
    expect(r.criteria).toHaveLength(2);
    expect(r.criteria[0].key).toBe('placement-health');
    expect(r.criteria[1].ratingScale).toContain('n/a'); // per-criterion override round-trips
    expect(r.proposedBy).toBe('su-test'); // the plan owner
    expect(r.ratifiedBy).toBeNull(); // not yet active
    expect(r.methodRef).toBe('hive-coordination-health-runbook');
    // it lands as a queryable rubric-template plan, not a duplicate
    expect((await rubrics.listRubrics({})).map((x) => x.rubricId)).toEqual(['hive-coordination-health']);
  });

  it('ratify flips proposed → active (ratifiedBy = the plan owner, identity collapsed to one field)', async () => {
    await rubrics.proposeRubric({ rubricId: 'x', characteristic: 'c', title: 'X', criteria: sampleCriteria, by: 'author-a' });
    const active = await rubrics.ratifyRubric('x', 'queen-1');
    expect(active?.status).toBe('active');
    // A plan has ONE owner → createdBy/proposedBy/ratifiedBy all derive from it (D-002).
    expect(active?.ratifiedBy).toBe('author-a');
  });

  it('ratify of an unknown rubric returns null', async () => {
    expect(await rubrics.ratifyRubric('nope', 'q')).toBeNull();
  });

  it('status:active authors a ratified rubric directly', async () => {
    const r = await rubrics.proposeRubric({
      rubricId: 'seeded',
      characteristic: 'c',
      title: 'Seeded',
      criteria: sampleCriteria,
      status: 'active',
      by: 'seed',
    });
    expect(r.status).toBe('active');
    expect(r.ratifiedBy).toBe('seed');
  });

  it('re-propose is an idempotent upsert — updates content, never a duplicate row', async () => {
    await rubrics.proposeRubric({ rubricId: 'seed', characteristic: 'c', title: 'v1', criteria: sampleCriteria, status: 'active', by: 'seed' });
    const r2 = await rubrics.proposeRubric({ rubricId: 'seed', characteristic: 'c', title: 'v2', criteria: sampleCriteria, status: 'active', by: 'seed' });
    expect(r2.title).toBe('v2');
    expect(r2.status).toBe('active');
    const all = await rubrics.listRubrics({});
    expect(all.filter((x) => x.rubricId === 'seed')).toHaveLength(1); // ON CONFLICT, not a second row
  });

  it('a malformed propose is rejected fail-loud, never persisting a half-state', async () => {
    await expect(
      rubrics.proposeRubric({ rubricId: 'bad', characteristic: '', title: 'Bad', criteria: [], by: 'x' }),
    ).rejects.toThrow(/invalid rubric data/i);
    expect(await rubrics.getRubric('bad')).toBeNull(); // nothing written
  });
});

describe('list / get / search over written rubrics', () => {
  beforeEach(async () => {
    await rubrics.proposeRubric({ rubricId: 'active-a', characteristic: 'hive-coordination', title: 'Active A', criteria: sampleCriteria, status: 'active', by: 's' });
    await rubrics.proposeRubric({ rubricId: 'proposed-b', characteristic: 'memory-recall', title: 'Proposed B', criteria: sampleCriteria, by: 's' });
  });

  it('list orders active-first, then proposed', async () => {
    const all = await rubrics.listRubrics({});
    expect(all.map((r) => r.rubricId)).toEqual(['active-a', 'proposed-b']);
  });

  it('list filters by status and by characteristic', async () => {
    expect((await rubrics.listRubrics({ status: 'active' })).map((r) => r.rubricId)).toEqual(['active-a']);
    expect((await rubrics.listRubrics({ characteristic: 'memory-recall' })).map((r) => r.rubricId)).toEqual(['proposed-b']);
  });

  it('get returns the full criteria; unknown id → null', async () => {
    const got = await rubrics.getRubric('active-a');
    expect(got?.criteria).toHaveLength(2);
    expect(got?.criteria[0].model).toContain('Queen places');
    expect(await rubrics.getRubric('missing')).toBeNull();
  });

  it('search matches over title / characteristic, and misses cleanly', async () => {
    expect((await rubrics.searchRubrics('coordination')).map((r) => r.rubricId)).toContain('active-a');
    expect((await rubrics.searchRubrics('memory')).map((r) => r.rubricId)).toContain('proposed-b');
    expect(await rubrics.searchRubrics('zzzznotarubric')).toEqual([]);
  });
});

// WI-976 regression — the store must scope reads/writes to the ACTIVE workspace
// (activeWorkspaceId()), NOT a hardcoded literal. The live bug (rubrics:list returned 0 so
// the Overwatch could not emit its required scorecard) was INVISIBLE to every other case
// in this suite: the test env's activeWorkspaceId() is 'default' — the same literal the
// buggy rubricsScopeWorkspace() hardcoded — so the read scope + the seed workspace always
// coincided and no mismatch could arise. In production the active workspace is
// 'papercusp-workspace' (where all plans + coord live), so the hardcoded 'default' scope
// missed the real rubric plan. This case pins a NON-'default' workspace to prove the scope
// FOLLOWS activeWorkspaceId(): a regression back to a hardcoded scope makes the reads below
// return [] / null and fails here.
describe('workspace scope follows activeWorkspaceId (WI-976 regression)', () => {
  it('resolves the rubric from the active workspace and isolates other workspaces', async () => {
    await insertRubricPlan('alpha-rubric', { workspaceId: 'ws-alpha' });
    await insertRubricPlan('beta-rubric', { workspaceId: 'ws-beta' });
    // Read pinned to ws-alpha → only ws-alpha's rubric (never ws-beta's; never []).
    const alpha = await runWithWorkspace('ws-alpha', () => rubrics.listRubrics({}));
    expect(alpha.map((r) => r.rubricId)).toEqual(['alpha-rubric']);
    const beta = await runWithWorkspace('ws-beta', () => rubrics.listRubrics({}));
    expect(beta.map((r) => r.rubricId)).toEqual(['beta-rubric']);
    // getRubric follows the same scope — ws-alpha cannot see ws-beta's rubric.
    expect(await runWithWorkspace('ws-alpha', () => rubrics.getRubric('beta-rubric'))).toBeNull();
    expect((await runWithWorkspace('ws-alpha', () => rubrics.getRubric('alpha-rubric')))?.rubricId).toBe(
      'alpha-rubric',
    );
  });
});
