/** P-005 real-Postgres coverage for exact spec evidence edges, tools, and currentness. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { SpecClauseWrite } from './spec-clauses-store';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>) =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)),
  };
});

const WORKSPACE = 'ws-spec-evidence';
const OTHER_WORKSPACE = 'ws-spec-evidence-other';
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

const specs = await import('./spec-clauses-store');
const evidenceStore = await import('./spec-evidence-store');
const bindTool = (await import('./bind-spec-evidence')).default;
const getTool = (await import('./get-spec-evidence')).default;

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = (name: string) => path.resolve(here, `../../../../../libs/papercusp/libs/db/sql/${name}`);
const MIGRATION_851 = migration('851-first-class-plan-spec-clauses.sql');
const MIGRATION_852 = migration('852-plan-spec-clause-integrity.sql');
const MIGRATION_855 = migration('855-work-item-spec-evidence-bindings.sql');
// 929/930 add plan_spec_clause_revisions.falsifier and its shape CHECK. Required here
// even though this suite is about EVIDENCE: it seeds clauses through setSpecClause, which
// writes the column. A sibling fixture silently falling one column behind a harness_shared
// table is a known recurring break (EI-21270668928342264) — this suite hit it.
const MIGRATION_929 = migration('929-spec-clause-falsifier.sql');
const MIGRATION_930 = migration('930-spec-clause-falsifier-null-safe.sql');
const CTX = {
  isSuperuser: true,
  uiClientId: 'su-spec-evidence-integration',
  workspaceId: WORKSPACE,
  harnessSlug: HARNESS,
} as never;

let db: FreshPgDb;

function clause(over: Partial<SpecClauseWrite> = {}): SpecClauseWrite {
  return {
    harnessSlug: HARNESS,
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    expectedRevision: 0,
    sourceValId: 'VAL-003-01',
    planItemId: 'P-003',
    behavior: 'Acknowledged event 42 is not replayed after reconnect.',
    behaviorClass: 'concurrency',
    requiredEvidence: ['integration replay trace'],
    requiredTestLayers: ['integration'],
    mutationRequired: true,
    lifecycleStatus: 'active',
    acceptanceRef: 'D-003',
    actorId: 'su-spec-evidence-integration',
    ...over,
  };
}

async function seedExternalEvidence() {
  const [surface] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.testing_surfaces (workspace_id, harness_slug)
    VALUES (${WORKSPACE}, ${HARNESS}) RETURNING id`;
  const [coverage] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.coverage_evidence (surface_ref)
    VALUES (${surface.id}) RETURNING id`;
  const [run] = await db.sql<{ id: number }[]>`
    INSERT INTO harness_shared.test_runs (workspace_id, harness_slug)
    VALUES (${WORKSPACE}, ${HARNESS}) RETURNING id`;
  return { surfaceId: Number(surface.id), coverageEvidenceRef: Number(coverage.id), testRunId: Number(run.id) };
}

beforeAll(async () => {
  db = await createFreshPgDb('plan-spec-evidence');
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
      -- P-022: the ad-hoc spec scope is materialised WITH a self-explaining body, so this
      -- fixture needs the column the real table has. Same class of drift the MIGRATION_929
      -- note above records (EI-21270668928342264): a hand-rolled fixture silently falling
      -- one column behind a harness_shared table.
      content text NOT NULL DEFAULT '',
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.plan_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      -- Real table: NOT NULL with NO default, which is why the ad-hoc item insert computes it.
      seq integer NOT NULL,
      owner_gate_marker text,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id)
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
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      source_plan_slug text,
      admission text, admitted_at timestamptz, admitted_by text,
      PRIMARY KEY (harness_slug, feature_id)
    );
    CREATE TABLE harness_shared.test_runs (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text,
      harness_slug text
    );
    CREATE TABLE harness_shared.testing_surfaces (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL
    );
    CREATE TABLE harness_shared.coverage_evidence (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      surface_ref bigint NOT NULL REFERENCES harness_shared.testing_surfaces(id) ON DELETE CASCADE
    );
  `);
  await applyMigrationForTest(db.sql, MIGRATION_851);
  await applyMigrationForTest(db.sql, MIGRATION_852);
  await applyMigrationForTest(db.sql, MIGRATION_855);
  await applyMigrationForTest(db.sql, MIGRATION_855);
  await applyMigrationForTest(db.sql, MIGRATION_929);
  await applyMigrationForTest(db.sql, MIGRATION_930);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE
    harness_shared.spec_evidence_bindings,
    harness_shared.work_item_spec_revision_edges,
    harness_shared.plan_spec_clause_revisions,
    harness_shared.plan_spec_clauses,
    harness_shared.harness_plan_assertions,
    harness_shared.plan_items,
    harness_shared.harness_plans,
    harness_shared.coverage_evidence,
    harness_shared.testing_surfaces,
    harness_shared.test_runs,
    harness_shared.work_items RESTART IDENTITY CASCADE`;
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
    VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan')`;
  await db.sql`
    INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq)
    VALUES (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'P-003', 1),
           (${WORKSPACE}, ${HARNESS}, 'reconnect-plan', 'P-004', 2)`;
  await db.sql`
    INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, source_plan_slug)
    VALUES (${WORKSPACE}, ${HARNESS}, 'WI-101', 'reconnect-plan'),
           (${WORKSPACE}, ${HARNESS}, 'WI-102', 'reconnect-plan')`;
});

describe('ad-hoc work-items carry spec evidence with no plan (P-022 / D-018)', () => {
  const ADHOC = 'adhoc-work-item-specs';

  beforeEach(async () => {
    // A work-item with NO source_plan_slug — the 99.2% ad-hoc regime layer A governs.
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, source_plan_slug)
      VALUES (${WORKSPACE}, ${HARNESS}, 'WI-900', NULL)`;
  });

  it('materialises the shared scope lazily, then authors and binds against it', async () => {
    const before = await db.sql`
      SELECT plan_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(before, 'the scope must not exist until something needs it').toHaveLength(0);

    // No planSlug anywhere in this flow — that is the whole point of the item.
    const authored = await specs.setSpecClause(
      clause({
        planSlug: undefined,
        planItemId: 'WI-900',
        specId: 'WI-900:S-001',
        sourceValId: null,
        behavior: 'The ad-hoc close names each requirement it disposed of.',
      }),
    );
    expect(authored).toMatchObject({ status: 'created', revision: 1 });

    const bound = await evidenceStore.bindSpecEvidence({
      workItemId: 'WI-900',
      specId: 'WI-900:S-001',
      evidenceKind: 'test',
      evidenceRef: 'lib/adhoc.test.ts#disposition',
      sourceFingerprint: 'git:adhoc1',
      harnessSlug: HARNESS,
      actorId: 'su-test',
    });
    expect(bound).toMatchObject({ status: 'created', planSlug: ADHOC, workItemId: 'WI-900' });

    // The edge row is what makes the evidence findable per work-item, and it carries the
    // resolved scope rather than a NULL — plan_slug is a PK column and can never be null.
    const edges = await db.sql<{ plan_slug: string; work_item_id: string }[]>`
      SELECT plan_slug, work_item_id FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}`;
    expect(edges).toEqual([{ plan_slug: ADHOC, work_item_id: 'WI-900' }]);

    const scope = await db.sql<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(scope).toHaveLength(1);
    expect(scope[0]!.content, 'the row must explain itself to whoever finds it').toContain(
      'Ad-hoc work-item spec scope',
    );
  });

  it('is idempotent across work-items — one scope row, one item row each', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items (workspace_id, harness_slug, feature_id, source_plan_slug)
      VALUES (${WORKSPACE}, ${HARNESS}, 'WI-901', NULL)`;
    for (const wi of ['WI-900', 'WI-901', 'WI-900']) {
      await specs.setSpecClause(
        clause({ planSlug: undefined, planItemId: wi, specId: `${wi}:S-001`, sourceValId: null }),
      );
    }
    const plans = await db.sql`
      SELECT plan_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(plans, 'one scope row per harness, never one per work-item').toHaveLength(1);
    const items = await db.sql<{ item_id: string; seq: number }[]>`
      SELECT item_id, seq FROM harness_shared.plan_items
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}
       ORDER BY item_id`;
    expect(items.map((r) => r.item_id)).toEqual(['WI-900', 'WI-901']);
    expect(new Set(items.map((r) => Number(r.seq))).size, 'seq must stay distinct').toBe(2);
  });

  it('still honours an explicit plan slug — the ad-hoc path is a fallback, not a takeover', async () => {
    await specs.setSpecClause(clause());
    const bound = await evidenceStore.bindSpecEvidence({
      workItemId: 'WI-101',
      sourceValId: 'VAL-003-01',
      evidenceKind: 'test',
      evidenceRef: 'test/reconnect.integration.ts#explicit',
      sourceFingerprint: 'git:explicit',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });
    expect(bound).toMatchObject({ status: 'created', planSlug: 'reconnect-plan' });
    const adhoc = await db.sql`
      SELECT plan_slug FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${ADHOC}`;
    expect(adhoc, 'a plan-bound write must not materialise the ad-hoc scope').toHaveLength(0);
  });
});

describe('exact spec evidence bindings', () => {
  it('keeps one shared proof reference for distinct spec clauses', async () => {
    await specs.setSpecClause(clause());
    await specs.setSpecClause(
      clause({
        specId: 'SPEC-004-01',
        sourceValId: null,
        planItemId: 'P-004',
        behavior: 'The stream closes after the terminal acknowledgement.',
      }),
    );

    const shared = {
      workItemId: 'WI-101',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.integration.ts#shared-run',
      sourceFingerprint: 'git:abc123',
      testFingerprint: 'sha256:test-v1',
    };
    const first = await evidenceStore.bindSpecEvidence({
      ...shared,
      sourceValId: 'VAL-003-01',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });
    const second = await evidenceStore.bindSpecEvidence({
      ...shared,
      specId: 'SPEC-004-01',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });

    expect(first).toMatchObject({ status: 'created', specId: 'SPEC-003-01' });
    expect(second).toMatchObject({ status: 'created', specId: 'SPEC-004-01' });
    if (!('id' in first) || !('id' in second)) {
      throw new Error('expected successful spec evidence bindings to include ids');
    }
    expect(second).not.toMatchObject({ id: first.id });

    const rows = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [shared.evidenceRef],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.specId).sort()).toEqual(['SPEC-003-01', 'SPEC-004-01']);
  });

  it('resolves legacy coversVALs, writes many-to-many exact edges, and deduplicates canonical proof', async () => {
    await specs.setSpecClause(clause());
    await specs.setSpecClause(
      clause({
        specId: 'SPEC-004-01',
        sourceValId: null,
        planItemId: 'P-004',
        behavior: 'The stream closes after the terminal acknowledgement.',
      }),
    );
    const external = await seedExternalEvidence();
    const binding = {
      workItemId: 'WI-101',
      sourceValId: 'VAL-003-01',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.integration.ts#no-replay',
      sourceFingerprint: 'git:abc123',
      testFingerprint: 'sha256:test-v1',
      fixtureFingerprint: 'sha256:fixture-v1',
      rubricFingerprint: 'sha256:adequacy-v1',
      environmentFingerprint: 'node:24-postgres:17',
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      details: { z: 2, a: { y: 2, x: 1 } },
    };

    const created = (await bindTool.handler({ harness: HARNESS, slug: 'reconnect-plan', binding }, CTX)) as {
      data: { results: Array<Record<string, unknown>> };
    };
    expect(created.data.results[0]).toMatchObject({
      ok: true,
      status: 'created',
      specId: 'SPEC-003-01',
      sourceValId: 'VAL-003-01',
      specRevision: 1,
    });

    const replay = await evidenceStore.bindSpecEvidence({
      ...binding,
      details: { a: { x: 1, y: 2 }, z: 2 },
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'second-actor',
    });
    expect(replay).toMatchObject({ status: 'unchanged', id: created.data.results[0]?.id });

    await evidenceStore.bindSpecEvidence({
      ...binding,
      sourceValId: undefined,
      specId: 'SPEC-004-01',
      evidenceRef: 'test/reconnect.integration.ts#terminal-close',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });
    await evidenceStore.bindSpecEvidence({
      ...binding,
      workItemId: 'WI-102',
      evidenceRef: 'test/reconnect.e2e.ts#no-replay',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    });

    const edgeCounts = await db.sql<{ edges: string; specs: string; items: string }[]>`
      SELECT count(*)::text AS edges,
             count(DISTINCT spec_id)::text AS specs,
             count(DISTINCT work_item_id)::text AS items
        FROM harness_shared.work_item_spec_revision_edges`;
    expect(edgeCounts[0]).toEqual({ edges: '3', specs: '2', items: '2' });

    const read = (await getTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        evidenceRefs: [binding.evidenceRef],
        current: [
          {
            evidenceKind: 'test',
            evidenceRef: binding.evidenceRef,
            sourceFingerprint: binding.sourceFingerprint,
            testFingerprint: binding.testFingerprint,
            fixtureFingerprint: binding.fixtureFingerprint,
            rubricFingerprint: binding.rubricFingerprint,
            environmentFingerprint: binding.environmentFingerprint,
          },
        ],
      } as never,
      CTX,
    )) as { data: { evidence: Array<Record<string, any>>; currentness: Record<string, number> } };
    expect(read.data.evidence[0]).toMatchObject({
      sourceValId: 'VAL-003-01',
      specRevision: 1,
      currentRevision: 1,
      currentness: { overall: 'current', staleReasons: [], unknownReasons: [] },
    });
    expect(read.data.currentness).toEqual({ current: 1, stale: 0, unknown: 0 });
  });

  it('keeps historical proof while spec and supplied fingerprints make staleness explicit', async () => {
    await specs.setSpecClause(clause());
    await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'counterexample',
      evidenceRef: 'counterexample:duplicate-ack',
      sourceFingerprint: 'git:before',
      testFingerprint: 'sha256:test-before',
      actorId: 'su-test',
    });

    await specs.setSpecClause(clause({ expectedRevision: 1, behavior: 'Variant with a new observable boundary.' }));
    const [row] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      current: [
        {
          evidenceKind: 'counterexample',
          evidenceRef: 'counterexample:duplicate-ack',
          sourceFingerprint: 'git:after',
          testFingerprint: 'sha256:test-before',
        },
      ],
    });
    expect(row).toMatchObject({
      specRevision: 1,
      currentRevision: 2,
      currentness: {
        overall: 'stale',
        dimensions: { spec: 'stale', source: 'stale', test: 'current', fixture: 'not-applicable' },
        staleReasons: ['spec-stale', 'source-stale'],
      },
    });

    const [unknown] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['counterexample:duplicate-ack'],
    });
    expect(unknown.currentness.overall).toBe('stale');
    expect(unknown.currentness.unknownReasons).toEqual([
      'source-current-fingerprint-not-supplied',
      'test-current-fingerprint-not-supplied',
    ]);
  });

  it('validates optional reference scope, detects pruned ledgers, and forbids history mutation', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const [otherSurface] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.testing_surfaces (workspace_id, harness_slug)
      VALUES (${OTHER_WORKSPACE}, ${HARNESS}) RETURNING id`;
    const [otherCoverage] = await db.sql<{ id: number }[]>`
      INSERT INTO harness_shared.coverage_evidence (surface_ref)
      VALUES (${otherSurface.id}) RETURNING id`;

    await expect(
      evidenceStore.bindSpecEvidence({
        harnessSlug: HARNESS,
        planSlug: 'reconnect-plan',
        workItemId: 'WI-101',
        specId: 'SPEC-003-01',
        evidenceKind: 'coverage-census',
        evidenceRef: 'surface:POST /events',
        sourceFingerprint: 'git:abc123',
        coverageEvidenceRef: Number(otherCoverage.id),
        actorId: 'su-test',
      }),
    ).resolves.toMatchObject({ status: 'coverage_evidence_not_found' });

    const bound = await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'coverage-census',
      evidenceRef: 'surface:POST /events',
      sourceFingerprint: 'git:abc123',
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      actorId: 'su-test',
    });
    expect(bound.status).toBe('created');

    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings SET source_fingerprint = 'forged'
       WHERE id = ${(bound as { id: number }).id}`).rejects.toThrow(/append-only/);
    await expect(db.sql`
      DELETE FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND work_item_id = 'WI-101'`).rejects.toThrow(/append-only/);

    await db.sql`DELETE FROM harness_shared.coverage_evidence WHERE id = ${external.coverageEvidenceRef}`;
    await db.sql`DELETE FROM harness_shared.test_runs WHERE id = ${external.testRunId}`;
    const [historical] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      current: [
        {
          evidenceKind: 'coverage-census',
          evidenceRef: 'surface:POST /events',
          sourceFingerprint: 'git:abc123',
        },
      ],
    });
    expect(historical).toMatchObject({
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      currentness: {
        overall: 'stale',
        staleReasons: ['coverageEvidence-stale', 'testRun-stale'],
      },
    });
  });
});

/**
 * D-013: plan_slug is the clause's GROUPING namespace, not a scope boundary on
 * applicability — a work item may link to clauses in any namespace regardless of its
 * own provenance. `listWorkItemSpecRevisionEdges` therefore grew an OPTIONAL planSlug.
 *
 * The resolver's own unit tests inject readers, so they cannot see this SQL branch at
 * all; without the cases below the unscoped read is exercised by nothing against real
 * Postgres. Both directions are asserted together on purpose: "returns rows from both
 * namespaces" is only meaningful next to "the scoped read still returns exactly one".
 */
describe('cross-namespace spec revision edges (D-013)', () => {
  /** Insert one edge, taking spec_fingerprint from the revision it points at. */
  const seedEdge = (workItemId: string, planSlug: string, specId: string) => db.sql`
    INSERT INTO harness_shared.work_item_spec_revision_edges
      (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision, spec_fingerprint, created_by)
    SELECT workspace_id, harness_slug, ${workItemId}, plan_slug, spec_id, revision, content_hash, 'su-test'
      FROM harness_shared.plan_spec_clause_revisions
     WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
       AND plan_slug = ${planSlug} AND spec_id = ${specId} AND revision = 1`;

  beforeEach(async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug)
      VALUES (${WORKSPACE}, ${HARNESS}, 'other-plan')`;
    await db.sql`
      INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id)
      VALUES (${WORKSPACE}, ${HARNESS}, 'other-plan', 'P-009')`;
  });

  it('reads edges across every plan namespace when planSlug is omitted, and only one when it is not', async () => {
    await specs.setSpecClause(clause());
    await specs.setSpecClause(
      clause({
        planSlug: 'other-plan',
        specId: 'SPEC-009-01',
        sourceValId: null,
        planItemId: 'P-009',
        behavior: 'A lapsed lease is reclaimable exactly once.',
      }),
    );
    // One work item, two namespaces — the shape a standalone bug takes on once it links
    // impact outside whatever plan happened to mint it.
    // spec_fingerprint is FK-tied to the revision's content_hash (855 puts it in a unique
    // key so the edge's fingerprint is DATABASE-verified), so it must be sourced, not invented.
    await seedEdge('WI-101', 'reconnect-plan', 'SPEC-003-01');
    await seedEdge('WI-101', 'other-plan', 'SPEC-009-01');

    const all = await evidenceStore.listWorkItemSpecRevisionEdges({ harnessSlug: HARNESS, workItemId: 'WI-101' });
    expect(all.map((e) => [e.planSlug, e.specId])).toEqual([
      ['other-plan', 'SPEC-009-01'],
      ['reconnect-plan', 'SPEC-003-01'],
    ]);

    // POSITIVE CONTROL for the scoped branch: the old behaviour must be unchanged, or the
    // widening silently became "planSlug is ignored" — which no unscoped assertion can catch.
    const scoped = await evidenceStore.listWorkItemSpecRevisionEdges({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
    });
    expect(scoped.map((e) => e.specId)).toEqual(['SPEC-003-01']);
  });

  it('still scopes by work item — an unscoped plan read is not an unscoped item read', async () => {
    await specs.setSpecClause(clause());
    await seedEdge('WI-102', 'reconnect-plan', 'SPEC-003-01');

    expect(await evidenceStore.listWorkItemSpecRevisionEdges({ harnessSlug: HARNESS, workItemId: 'WI-101' })).toEqual([]);
    expect(
      await evidenceStore.listWorkItemSpecRevisionEdges({ harnessSlug: HARNESS, workItemId: 'WI-102' }),
    ).toHaveLength(1);
  });
});
