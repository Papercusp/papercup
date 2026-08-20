/** P-002 real-Postgres coverage for canonical plan spec revisions and tools. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>) =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)),
  };
});

const WORKSPACE = 'ws-spec-test';
const HARNESS = 'web';
vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return {
    ...actual,
    resolvePlanScope: async (opts: { harnessSlug?: string } = {}) => ({
      workspaceId: WORKSPACE,
      harnessSlug: opts.harnessSlug?.trim() || HARNESS,
    }),
  };
});

const store = await import('./spec-clauses-store');
const setSpecsTool = (await import('./set-specs')).default;
const getSpecsTool = (await import('./get-specs')).default;

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_851 = path.resolve(
  here,
  '../../../../../libs/papercusp/libs/db/sql/851-first-class-plan-spec-clauses.sql',
);
const MIGRATION_852 = path.resolve(
  here,
  '../../../../../libs/papercusp/libs/db/sql/852-plan-spec-clause-integrity.sql',
);
const CTX = {
  isSuperuser: true,
  uiClientId: 'su-spec-integration',
  workspaceId: WORKSPACE,
  harnessSlug: HARNESS,
} as never;

let db: FreshPgDb;

function clause(over: Partial<store.SpecClauseWrite> = {}): store.SpecClauseWrite {
  return {
    harnessSlug: HARNESS,
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    expectedRevision: 0,
    sourceValId: 'VAL-003-01',
    planItemId: 'P-003',
    behavior: 'Acknowledged event 42 is not replayed after reconnect.',
    behaviorClass: 'concurrency',
    requiredEvidence: ['integration replay trace', 'boundary counterexample'],
    requiredTestLayers: ['integration'],
    mutationRequired: true,
    lifecycleStatus: 'active',
    acceptanceRef: 'D-003',
    actorId: 'su-spec-integration',
    ...over,
  };
}

beforeAll(async () => {
  db = await createFreshPgDb('plan-spec-clauses');
  h.sql = db.sql;
  await db.sql.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin; END IF;
  END $$;`);
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.plan_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id),
      FOREIGN KEY (workspace_id, harness_slug, plan_slug)
        REFERENCES harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.harness_plan_assertions (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      val_id text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      verify_text text NOT NULL,
      evidence_text text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'todo',
      requires_test boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, harness_slug, val_id)
    );
  `);
  await applyMigrationForTest(db.sql, MIGRATION_851);
  await applyMigrationForTest(db.sql, MIGRATION_852);
  // Idempotency is part of the migration contract, not just a comment.
  await applyMigrationForTest(db.sql, MIGRATION_852);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE
    harness_shared.plan_spec_clause_revisions,
    harness_shared.plan_spec_clauses,
    harness_shared.harness_plan_assertions,
    harness_shared.plan_items,
    harness_shared.harness_plans CASCADE`;
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan')`;
  await db.sql`
    INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id)
    VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'P-003'),
           (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'P-004')`;
});

describe('first-class plan spec clauses', () => {
  it('exposes create/current/history through the structured tools and preserves a legacy VAL verdict', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_plan_assertions (
        workspace_id, harness_slug, val_id, plan_slug, item_id,
        verify_text, evidence_text, status, requires_test
      ) VALUES (${WORKSPACE}, ${HARNESS}, 'VAL-003-01', 'reconnect-plan', 'P-003',
                'old behavior', 'old evidence', 'passed', true)`;

    const set = (await setSpecsTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        spec: {
          specId: 'SPEC-003-01',
          expectedRevision: 0,
          sourceValId: 'VAL-003-01',
          planItemId: 'P-003',
          behavior: 'Acknowledged event 42 is not replayed after reconnect.',
          behaviorClass: 'concurrency',
          requiredEvidence: ['boundary counterexample', 'integration replay trace'],
          requiredTestLayers: ['integration'],
          mutationRequired: true,
          lifecycleStatus: 'active',
          acceptanceRef: 'D-003',
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(set.data.results[0]).toMatchObject({ ok: true, status: 'created', revision: 1 });

    const get = (await getSpecsTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        includeHistory: true,
      } as never,
      CTX,
    )) as { data: { specs: store.SpecClauseRevision[] } };
    expect(get.data.specs).toHaveLength(1);
    expect(get.data.specs[0]).toMatchObject({
      specId: 'SPEC-003-01',
      sourceValId: 'VAL-003-01',
      revision: 1,
      currentRevision: 1,
      acceptedBy: 'su-spec-integration',
    });
    const legacy = await db.sql<{ status: string; verify_text: string }[]>`
      SELECT status, verify_text FROM harness_shared.harness_plan_assertions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND val_id = 'VAL-003-01'`;
    expect(legacy[0]).toEqual({
      status: 'passed',
      verify_text: 'Acknowledged event 42 is not replayed after reconnect.',
    });
  });

  it('supports deterministic no-op, revision append, exact reads, and one-winner concurrent CAS', async () => {
    const first = clause();
    expect(await store.setSpecClause(first)).toMatchObject({ status: 'created', revision: 1 });
    expect(await store.setSpecClause({ ...first, expectedRevision: 1 })).toMatchObject({
      status: 'unchanged',
      revision: 1,
    });

    const race = await Promise.all([
      store.setSpecClause({ ...first, expectedRevision: 1, behavior: 'Variant A' }),
      store.setSpecClause({ ...first, expectedRevision: 1, behavior: 'Variant B' }),
    ]);
    expect(race.filter((r) => r.status === 'revised')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'conflict')).toHaveLength(1);

    const history = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      includeHistory: true,
    });
    expect(history.map((r) => r.revision)).toEqual([1, 2]);
    const exact = await store.listSpecClauses({ harnessSlug: HARNESS, planSlug: 'reconnect-plan', revision: 1 });
    expect(exact).toHaveLength(1);
    expect(exact[0]?.behavior).toBe(first.behavior);
  });

  it('returns structured ownership, supersession, alias, and immutable-alias conflicts', async () => {
    expect(await store.setSpecClause(clause({ planSlug: 'missing-plan' }))).toMatchObject({ status: 'plan_not_found' });
    expect(await store.setSpecClause(clause({ planItemId: 'P-999' }))).toMatchObject({ status: 'plan_item_not_found' });
    expect(await store.setSpecClause(clause({ supersedes: { specId: 'SPEC-missing', revision: 1 } }))).toMatchObject({
      status: 'supersedes_not_found',
    });

    expect(await store.setSpecClause(clause())).toMatchObject({ status: 'created' });
    expect(await store.setSpecClause(clause({ specId: 'SPEC-003-02', sourceValId: 'VAL-003-01' }))).toMatchObject({
      status: 'source_alias_conflict',
      conflictingSpecId: 'SPEC-003-01',
    });
    expect(await store.setSpecClause(clause({ expectedRevision: 1, sourceValId: 'VAL-other' }))).toMatchObject({
      status: 'source_alias_immutable',
      sourceValId: 'VAL-003-01',
    });
  });

  it('persists exemption/acceptance provenance and rejects revision mutation or a dangling current pointer', async () => {
    expect(
      await store.setSpecClause(
        clause({
          specId: 'SPEC-003-EX',
          sourceValId: null,
          lifecycleStatus: 'exempt',
          exemption: { authority: 'D-004', rationale: 'manual copy review', scope: ['copy'] },
          acceptanceRef: 'D-004',
        }),
      ),
    ).toMatchObject({ status: 'created' });
    const [exempt] = await store.listSpecClauses({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specIds: ['SPEC-003-EX'],
    });
    expect(exempt).toMatchObject({
      lifecycleStatus: 'exempt',
      acceptedBy: null,
      exemption: { authority: 'D-004', rationale: 'manual copy review', scope: ['copy'] },
    });

    await expect(db.sql`
      UPDATE harness_shared.plan_spec_clause_revisions SET behavior = 'mutated'
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-EX' AND revision = 1`).rejects.toThrow(/immutable/);
    await expect(db.sql`
      DELETE FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-EX' AND revision = 1`).rejects.toThrow(/immutable/);
    await expect(db.sql`
      UPDATE harness_shared.plan_spec_clauses SET current_revision = 99
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-EX'`).rejects.toThrow(/foreign key/);
  });

  it('has the fully validated integrity constraints after an idempotent migration replay', async () => {
    const constraints = await db.sql<{ conname: string; convalidated: boolean }[]>`
      SELECT conname, convalidated
        FROM pg_constraint
       WHERE conname IN (
         'plan_spec_clauses_plan_fk',
         'plan_spec_clauses_current_revision_fk',
         'plan_spec_clause_revisions_supersedes_fk',
         'plan_spec_clause_revisions_exemption_exact',
         'plan_spec_clause_revisions_acceptance_exact'
       ) ORDER BY conname`;
    expect(constraints).toHaveLength(5);
    expect(constraints.every((c) => c.convalidated)).toBe(true);
  });
});
