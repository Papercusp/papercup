/** P002: real plan/clause/rubric readers, isolated PG, and authoritative subject identity. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { runWithWorkspace } from '../../workspace-als';
import { metadataClauseWrite, metadataInputSchema, metadataPlanSlug } from './coordination-metadata-fixtures';
import { parsePlan } from './parser';

const WS = 'coord-metadata-preflight-test';
const A = 'metadata-a';
const B = 'metadata-b';
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
  withWorkspace: async <T>(ws: string, fn: (tx: postgres.Sql) => Promise<T>) =>
    h.sql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return fn(tx as unknown as postgres.Sql);
    }) as Promise<T>,
}));
// Only registry scope is pinned. The plan, clause, rubric and evaluator readers
// stay real, and every query reaches the private migrated database below.
vi.mock('./source', async (original) => ({
  ...await original<typeof import('./source')>(),
  resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
    workspaceId: WS, harnessSlug: opts.harnessSlug ?? A,
  }),
}));
// readPlanBySlug calls its own lexical resolvePlanScope, not the mocked export.
// Pin only its registry inputs; leave its SQL, parsing and readiness path real.
vi.mock('./_ctx-opts', async (original) => ({
  ...await original<typeof import('./_ctx-opts')>(),
  ctxToPlanSourceOpts: async (ctx: { harnessSlug: string }) => ({
    workspaceId: WS, harnessSlug: ctx.harnessSlug,
  }),
}));
vi.mock('../../hive-federation', async (original) => ({
  ...await original<typeof import('../../hive-federation')>(),
  potHomeSlugForHarness: async (_workspace: string, harness: string) => harness,
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { setSpecClause } = await import('./spec-clauses-store');
const { getAcceptanceRubricsForPlan, proposeRubric } = await import('../../rubrics');
const evaluate = (await import('./evaluate-spec-quality')).default;
const { readAcceptanceBarContractSnapshot } = await import('../../acceptance-bar-contract-snapshot');
let db: OrgTestDb;
let migration: string;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  migration = await readFile(fileURLToPath(new URL(
    '../../../../../libs/papercusp/libs/db/sql/1145-acceptance-subject-harness-identity.sql.DRAFT', import.meta.url,
  )), 'utf8');
  await h.sql.unsafe(migration);
  await h.sql.unsafe(migration); // repeat application is safe
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await h.sql`TRUNCATE harness_shared.harness_plans CASCADE`;
});

const inWorkspace = <T>(fn: () => T): T => runWithWorkspace(WS, fn);

async function plan(harness: string, inputs: object = { harness: A, attempts: 1 }) {
  const content = `---\ntitle: Metadata fixture\nslug: ${metadataPlanSlug}\nstatus: draft\n---\n\n## Phase\n- **P-001** \`todo\` Submit an event\n`;
  // Both the plan-body evaluator and persisted item reader must see the same
  // positive control; a zero-item parse would make refusal assertions vacuous.
  expect(parsePlan(content).items.map((item) => item.id)).toEqual(['P-001']);
  await h.sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, title, status, input_schema, template_data)
    VALUES (${WS}, ${harness}, ${metadataPlanSlug}, ${content}, md5(${content}), 'Metadata fixture', 'draft',
      ${JSON.stringify(metadataInputSchema.inputSchema)}::jsonb, ${JSON.stringify(inputs)}::jsonb)`;
  // Explicitly model pre-adoption plans; migration 1111 marks every new insert.
  await h.sql`UPDATE harness_shared.harness_plans SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
    WHERE workspace_id = ${WS} AND harness_slug = ${harness} AND plan_slug = ${metadataPlanSlug}`;
  await h.sql`INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status)
    VALUES (${WS}, ${harness}, ${metadataPlanSlug}, 'P-001', 1, 'Submit an event', 'todo')`;
}

async function rubric(id: string, harness?: string, classRef = 'plan-class-bugfix') {
  const data = { kind: 'acceptance', subjectPlan: metadataPlanSlug,
    ...(harness ? { subjectHarnessSlug: harness } : {}), classRef,
    characteristic: 'plan-acceptance', criteria: [], ratingScale: ['pass', 'fail', 'unknown'] };
  // Store every rubric in a THIRD harness: filtering its row.harness_slug would
  // make both legitimate subject lookups fail, so this catches that false fix.
  await h.sql`INSERT INTO harness_shared.harness_plans
    (workspace_id, harness_slug, plan_slug, content, content_hash, title, status, template, template_data)
    VALUES (${WS}, 'rubric-library', ${id}, '', md5(${id}), ${id}, 'active', 'rubric', ${JSON.stringify(data)}::jsonb)`;
}

async function clause(harness: string) {
  const result = await inWorkspace(() => setSpecClause(metadataClauseWrite({
    harnessSlug: harness, sourceValId: null,
  })));
  expect(result).toMatchObject({ status: 'created', specId: 'SPEC-001-01', revision: 1 });
}

async function grade(harness: string) {
  const result = await inWorkspace(() => evaluate.handler({ harness, slug: metadataPlanSlug }, {
    harnessSlug: harness, workspaceId: WS, log: () => {}, signal: new AbortController().signal,
    progress: () => {}, emit: () => {},
  } as never));
  if (!('data' in result)) throw new Error('evaluate handler returned no structured data');
  return result.data as Record<string, any>;
}

async function persistedState() {
  return h.sql`SELECT harness_slug, plan_slug, content, content_hash, version, template_data, op_status, updated_at
    FROM harness_shared.harness_plans WHERE workspace_id = ${WS} ORDER BY harness_slug, plan_slug`;
}

describe('P002 real-store metadata preflight', () => {
  it('derives different authoritative classes for identical plan slugs and stable retry drafts without writes', async () => {
    await plan(A); await plan(B);
    await rubric('acceptance-a', A, 'plan-class-bugfix');
    await rubric('acceptance-b', B, 'plan-class-investigation');
    await clause(A); await clause(B);
    const before = await persistedState();
    const first = await grade(A);
    expect(first).toMatchObject({ ok: true, harnessSlug: A, classRef: 'plan-class-bugfix' });
    expect(first.scorecardDraft).toBeDefined();
    expect(await grade(A)).toEqual(first);
    expect(await grade(B)).toMatchObject({ ok: true, harnessSlug: B, classRef: 'plan-class-investigation' });
    expect(await persistedState()).toEqual(before);
    const snapshot = await inWorkspace(() => readAcceptanceBarContractSnapshot(metadataPlanSlug, {}, { harnessSlug: B }));
    expect(snapshot.plan).toMatchObject({ harnessSlug: B });
    expect(snapshot.bounded.planItems.rowsRead).toBe(1);
    expect(snapshot.completeness.problems.some((p) => p.code === 'bar_snapshot_plan_ambiguous')).toBe(false);
  });

  it('never borrows another harness policy or an ambiguous legacy subject link', async () => {
    await plan(A); await plan(B); await clause(B);
    await rubric('legacy-unbound');
    expect(await inWorkspace(() => getAcceptanceRubricsForPlan(metadataPlanSlug, { harnessSlug: B, strict: true }))).toEqual([]);
    await h.sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND plan_slug = 'legacy-unbound'`;
    await rubric('acceptance-a', A);
    const result = await grade(B);
    expect(result.ok).toBe(false);
    expect(result.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'spec_quality_class_missing' })]));
    expect(result).not.toHaveProperty('scorecardDraft');
  });

  it('keeps legacy single-subject lookup and enforces uniqueness within each subject harness', async () => {
    await plan(A); await rubric('legacy-unbound');
    expect(await inWorkspace(() => getAcceptanceRubricsForPlan(metadataPlanSlug, { harnessSlug: A, strict: true })))
      .toEqual([expect.objectContaining({ rubricId: 'legacy-unbound' })]);
    await h.sql.unsafe(migration);
    await expect(rubric('conflicting-a', A)).rejects.toMatchObject({ code: '23505' });
    await plan(B); await rubric('independent-b', B);
    expect(await inWorkspace(() => getAcceptanceRubricsForPlan(metadataPlanSlug, { harnessSlug: B, strict: true })))
      .toEqual([expect.objectContaining({ rubricId: 'independent-b', subjectHarnessSlug: B })]);
  });

  it('reports missing inputs, ambiguous policy and unavailable clauses together without a draft or mutation', async () => {
    await plan(A, {}); await rubric('acceptance-a', A);
    // Model pre-invariant/federated corruption and an unavailable clause relation
    // in the ISOLATED database. All three production readers still execute SQL.
    await h.sql`DROP INDEX harness_shared.harness_plans_one_active_acceptance_per_scoped_subject`;
    await rubric('duplicate-a', A);
    await h.sql`ALTER TABLE harness_shared.plan_spec_clauses RENAME TO unavailable_plan_spec_clauses`;
    try {
      const before = await persistedState();
      const result = await grade(A);
      expect(result.ok).toBe(false);
      expect(result.readiness.missing).toEqual(expect.arrayContaining(['harness', 'attempts']));
      expect(result.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ check: 'inputs', state: 'blocked' }),
        expect.objectContaining({ code: 'spec_quality_class_ambiguous' }),
        expect.objectContaining({ check: 'clauses', state: 'unknown' }),
      ]));
      expect(result).not.toHaveProperty('scorecardDraft');
      expect(await persistedState()).toEqual(before);
    } finally {
      await h.sql`ALTER TABLE harness_shared.unavailable_plan_spec_clauses RENAME TO plan_spec_clauses`;
      await h.sql`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND plan_slug = 'duplicate-a'`;
      await h.sql.unsafe(migration);
    }
  });

  it('refuses an ambiguous subject at the canonical writer before creating a rubric', async () => {
    await plan(A); await plan(B);
    await expect(inWorkspace(() => proposeRubric({ rubricId: 'no-guess', kind: 'acceptance',
      subjectPlan: metadataPlanSlug, classRef: 'plan-class-bugfix', characteristic: 'plan-acceptance',
      title: 'No guessed scope', criteria: [],
    }))).rejects.toThrow('ambiguous across harnesses');
    expect(await h.sql`SELECT plan_slug FROM harness_shared.harness_plans WHERE workspace_id = ${WS} AND plan_slug = 'no-guess'`).toHaveLength(0);
  });

  it('persists explicit subject scope and preserves it on re-proposal after another harness adopts the slug', async () => {
    await plan(A);
    // The canonical writer validates the class through the real rubric reader.
    // Seed that prerequisite in the private DB rather than mocking validation.
    const classData = { kind: 'standard', characteristic: 'plan-acceptance',
      ratingScale: ['pass', 'fail', 'unknown'],
      criteria: [{ key: 'regression', title: 'Regression',
        model: 'The reported behavior is covered by a regression test.',
        method: 'Run the named regression and its negative control.',
        driftMarkers: 'The negative control no longer fails.' }] };
    await h.sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, title, status, template, template_data)
      VALUES (${WS}, 'rubric-library', 'plan-class-bugfix', '', md5('plan-class-bugfix'),
        'Bugfix class', 'active', 'rubric', ${JSON.stringify(classData)}::text::jsonb)`;
    const input = { rubricId: 'scoped-proposal', kind: 'acceptance' as const,
      subjectPlan: metadataPlanSlug, subjectHarnessSlug: A, classRef: 'plan-class-bugfix',
      characteristic: 'plan-acceptance', title: 'Scoped proposal', criteria: [] };
    expect(await inWorkspace(() => proposeRubric(input))).toMatchObject({ subjectHarnessSlug: A });
    await plan(B);
    const { subjectHarnessSlug: _scope, ...retry } = input;
    expect(await inWorkspace(() => proposeRubric(retry))).toMatchObject({ subjectHarnessSlug: A });
    expect(await inWorkspace(() => getAcceptanceRubricsForPlan(metadataPlanSlug, { harnessSlug: B, strict: true })))
      .toEqual([]);
    await expect(inWorkspace(() => proposeRubric({ ...input, subjectHarnessSlug: B })))
      .rejects.toThrow('cannot change its subject identity');
  });
});
