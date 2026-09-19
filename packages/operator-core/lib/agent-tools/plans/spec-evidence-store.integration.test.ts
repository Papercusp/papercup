/** P-005 real-Postgres coverage for exact spec evidence edges, tools, and currentness. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import type { SpecClauseWrite } from './spec-clauses-store';
import { carryUnchangedBarEvidenceBindings } from '../../acceptance-bar-amendment';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, repoRoot: '', siblingRoot: '' }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>) =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)),
  };
});
vi.mock('../../harness-registry', () => ({
  loadHarnessRegistry: async () => ({
    projects: [
      { slug: 'web', path: h.repoRoot },
      { slug: 'portal', path: h.siblingRoot },
    ],
  }),
  resolveHarnessContentPath: (registry: { projects: Array<{ slug: string; path: string }> }, slug: string) =>
    registry.projects.find((project) => project.slug === slug)?.path,
}));

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
const MIGRATION_1111 = migration('1111-acceptance-bar-contract-seed.sql');
const MIGRATION_1150 = migration('1150-test-runs-execution-details.sql');
// 929/930 add plan_spec_clause_revisions.falsifier and its shape CHECK. Required here
// even though this suite is about EVIDENCE: it seeds clauses through setSpecClause, which
// writes the column. A sibling fixture silently falling one column behind a harness_shared
// table is a known recurring break (EI-21270668928342264) — this suite hit it.
const MIGRATION_929 = migration('929-spec-clause-falsifier.sql');
const MIGRATION_930 = migration('930-spec-clause-falsifier-null-safe.sql');
// 1174 adds the recorded-retraction path (WI-10001850 / D-011): the three stamp columns,
// the all-or-nothing CHECK, and the bindings-only guard that replaces the shared
// append-only trigger with a strict superset of it. Applied LAST so the guards below
// exercise the trigger this migration installs, not the one 855 installed.
const MIGRATION_1174 = migration('1174-spec-evidence-binding-retraction.sql');
// 1175 scopes the dedup index to live rows so a retracted binding releases its
// slot for an identical corrected binding (WI-10001850 / D-011).
const MIGRATION_1175 = migration('1175-spec-evidence-dedup-partial-on-live.sql');
// 1176 completes the expand/contract sequence after the predicate-aware writer is
// deployed by dropping the obsolete total index (WI-10001850 / EI-23634085867209303).
const MIGRATION_1176 = migration('1176-spec-evidence-drop-total-dedup-contract-phase.sql');
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
  h.repoRoot = await mkdtemp(path.join(tmpdir(), 'spec-evidence-integration-'));
  h.siblingRoot = await mkdtemp(path.join(tmpdir(), 'spec-evidence-sibling-integration-'));
  await Promise.all([
    mkdir(path.join(h.repoRoot, 'src'), { recursive: true }),
    mkdir(path.join(h.repoRoot, 'test'), { recursive: true }),
    mkdir(path.join(h.siblingRoot, 'src'), { recursive: true }),
    mkdir(path.join(h.siblingRoot, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(h.repoRoot, 'src', 'reconnect.ts'), 'export const reconnect = true;\n'),
    writeFile(path.join(h.repoRoot, 'test', 'reconnect.test.ts'), 'expect(reconnect).toBe(true);\n'),
    writeFile(path.join(h.siblingRoot, 'src', 'portal.ts'), 'export const rendererTrust = true;\n'),
    writeFile(path.join(h.siblingRoot, 'test', 'portal.test.ts'), 'expect(rendererTrust).toBe(true);\n'),
  ]);
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
      template text,
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
    CREATE TABLE harness_shared.carry_notes (
      workspace_id text NOT NULL, scope text NOT NULL, note text,
      journal jsonb NOT NULL DEFAULT '[]'::jsonb, updated_ts bigint NOT NULL,
      deps jsonb, body_ts bigint, attested_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, scope)
    );
    CREATE TABLE harness_shared.test_runs (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text,
      harness_slug text,
      file_path text,
      status text,
      finished_at timestamptz,
      run_group_id text,
      commit_sha text,
      worktree_dirty boolean NOT NULL DEFAULT false
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
  await applyMigrationForTest(db.sql, MIGRATION_1150);
  await applyMigrationForTest(db.sql, MIGRATION_1150); // additive and replay-safe
  await applyMigrationForTest(db.sql, MIGRATION_851);
  await applyMigrationForTest(db.sql, MIGRATION_852);
  await applyMigrationForTest(db.sql, MIGRATION_1111);
  await applyMigrationForTest(db.sql, MIGRATION_855);
  await applyMigrationForTest(db.sql, MIGRATION_855);
  await applyMigrationForTest(db.sql, MIGRATION_929);
  await applyMigrationForTest(db.sql, MIGRATION_930);
  await applyMigrationForTest(db.sql, MIGRATION_1174);
  await applyMigrationForTest(db.sql, MIGRATION_1174); // idempotent and replay-safe
  await applyMigrationForTest(db.sql, MIGRATION_1175);
  await applyMigrationForTest(db.sql, MIGRATION_1175); // idempotent and replay-safe
  await applyMigrationForTest(db.sql, MIGRATION_1176);
  await applyMigrationForTest(db.sql, MIGRATION_1176); // idempotent and replay-safe
}, 90_000);

afterAll(async () => {
  await Promise.all([
    db?.cleanup(),
    rm(h.repoRoot, { recursive: true, force: true }),
    rm(h.siblingRoot, { recursive: true, force: true }),
  ]);
}, 30_000);

beforeEach(async () => {
  await writeFile(path.join(h.repoRoot, 'src', 'reconnect.ts'), 'export const reconnect = true;\n');
  await db.sql`TRUNCATE
    harness_shared.carry_notes,
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

describe('test execution carries mappings into the real evidence ledger', () => {
  it('recovers detached measured outcomes from the exact scoped PG row after a timeout', async () => {
    const { prepareTestEvidence, finishTestEvidence, recoverTestEvidence } = await import('../testing/evidence');
    const { readHarnessTestRunEvidence, countUnattributedTestRunRows } = await import('../../testing-run-store');
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const origin = '0b2a4763-5332-455f-a876-c056e9b1cdb1';
    const detached = '9a08bdac-4a37-4d16-80d5-ebd22d531e8d';
    const testPath = 'test/reconnect.test.ts';
    const scope = { workspaceId: WORKSPACE, harnessSlug: HARNESS, actorId: 'su-test', root: h.repoRoot };
    const deps = { bind: evidenceStore.bindSpecEvidence, measure: evidenceStore.measureRepoFilesEvidenceAtRoot,
      list: evidenceStore.listSpecEvidence,
      ledger: (args: Parameters<typeof readHarnessTestRunEvidence>[0]) => readHarnessTestRunEvidence({
        ...args, sql: h.sql as unknown as NonNullable<Parameters<typeof readHarnessTestRunEvidence>[0]['sql']>,
      }),
      unattributed: countUnattributedTestRunRows };
    const prepared = await prepareTestEvidence({ workItemId: 'WI-101', planSlug: 'reconnect-plan',
      bindings: [{ specId: 'SPEC-003-01', specRevision: 1, testPath, sourcePaths: ['src/reconnect.ts'],
        testLayer: 'integration' }] }, origin, [testPath], scope, deps);
    await finishTestEvidence(prepared, origin, detached, scope,
      { ok: false, runId: origin, root: h.repoRoot, error: 'timeout' }, deps);
    const recovery = { workItemId: 'WI-101', planSlug: 'reconnect-plan', originRunId: origin, runId: detached };
    const commitSha = 'fixture-commit';
    const details = { schemaVersion: 1, root: h.repoRoot, filePath: testPath,
      workspaceId: WORKSPACE, harnessSlug: HARNESS, runGroupId: detached, testNamePattern: null,
      passed: 3, failed: 0, skipped: 0, collectionFailed: false, mutationPhase: null,
      commitSha, worktreeDirty: false };
    // A same-run, same-file row from another tenant must not settle this proof.
    await db.sql`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,status,finished_at,run_group_id,commit_sha,worktree_dirty,execution_details)
      VALUES (${OTHER_WORKSPACE},${HARNESS},${testPath},'pass',now(),${detached},${commitSha},false,${JSON.stringify(details)}::text::jsonb)`;
    expect((await recoverTestEvidence(recovery, scope, deps)).rows[0])
      .toMatchObject({ phase: 'pending', outcome: 'unknown' });
    const [row] = await db.sql<{ id: number }[]>`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,status,finished_at,run_group_id,commit_sha,worktree_dirty,execution_details)
      VALUES (${WORKSPACE},${HARNESS},${testPath},'pass',now(),${detached},${commitSha},false,${JSON.stringify(details)}::text::jsonb)
      RETURNING id`;
    const exact = await deps.ledger({ workspaceId: WORKSPACE, harnessSlug: HARNESS, runGroupId: detached });
    expect(exact).toHaveLength(1);
    expect(exact![0].execution_details).toEqual(details);
    const recovered = await recoverTestEvidence(recovery, scope, deps);
    expect(recovered.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass', testRunId: Number(row.id) });
    expect(recovered.verificationFingerprint).toBeTruthy();
    // Two matching receipts are ambiguous, even when both say pass.
    await db.sql`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,status,finished_at,run_group_id,commit_sha,worktree_dirty,execution_details)
      VALUES (${WORKSPACE},${HARNESS},${testPath},'pass',now(),${detached},${commitSha},false,${JSON.stringify(details)}::text::jsonb)`;
    expect((await recoverTestEvidence(recovery, scope, deps)).rows[0])
      .toMatchObject({ phase: 'pending', outcome: 'unknown', testRunId: null });
  });

  it('persists pending links, attaches the exact scoped run, and preserves stale source after a change', async () => {
    const { prepareTestEvidence, finishTestEvidence, recoverTestEvidence } = await import('../testing/evidence');
    const { readHarnessTestRunEvidence, countUnattributedTestRunRows } = await import('../../testing-run-store');
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const runId = '65878e5c-0326-4899-9fa4-6e387d30fef4';
    const testPath = 'test/reconnect.test.ts';
    const request = { workItemId: 'WI-101', planSlug: 'reconnect-plan', bindings: [{ specId: 'SPEC-003-01',
      specRevision: 1, testPath, sourcePaths: ['src/reconnect.ts'], testLayer: 'integration' as const,
      causalPairId: 'original-reconnect' }] };
    const scope = { workspaceId: WORKSPACE, harnessSlug: HARNESS, actorId: 'su-test', root: h.repoRoot };
    const deps = { bind: evidenceStore.bindSpecEvidence, measure: evidenceStore.measureRepoFilesEvidenceAtRoot,
      list: evidenceStore.listSpecEvidence,
      ledger: (args: Parameters<typeof readHarnessTestRunEvidence>[0]) => readHarnessTestRunEvidence({
        ...args, sql: h.sql as unknown as NonNullable<Parameters<typeof readHarnessTestRunEvidence>[0]['sql']>,
      }),
      unattributed: countUnattributedTestRunRows };
    const prepared = await prepareTestEvidence(request, runId, [testPath], scope, deps);
    const pending = await evidenceStore.listSpecEvidence({ harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'] });
    expect(pending).toHaveLength(1);
    expect(pending[0].details.adequacy).toMatchObject({ outcome: 'pending', executed: false, causalPairIds: ['original-reconnect'] });
    const [run] = await db.sql<{ id: number }[]>`INSERT INTO harness_shared.test_runs
      (workspace_id,harness_slug,file_path,status,finished_at,run_group_id)
      VALUES (${WORKSPACE},${HARNESS},${testPath},'pass',now(),${runId}) RETURNING id`;
    await db.sql`INSERT INTO harness_shared.test_runs (workspace_id,harness_slug,file_path,status,finished_at,run_group_id)
      VALUES (${OTHER_WORKSPACE},${HARNESS},${testPath},'fail',now(),${runId})`;
    const result = { ok: true, runId, root: h.repoRoot, passed: 1, failed: 0, skipped: 0, files: 1,
      failures: [], failuresTruncated: false, durationMs: 1,
      byFile: { [testPath]: { passed: 1, failed: 0, skipped: 0, collectionFailed: false } } };
    const bundle = await finishTestEvidence(prepared, runId, runId, scope, result, deps);
    expect(bundle.rows[0]).toMatchObject({ testRunId: Number(run.id), phase: 'settled', outcome: 'pass' });
    // Integrated continuation: persist once, cross the reader boundary, and use
    // the exact automatically recorded run without opening a transcript/history.
    const { setWorkItemCheckpoint, getWorkItemCheckpointWithMeta } = await import('../../work-item-checkpoint');
    const { renderCarryNote } = await import('../../carry-note');
    const { readWorkItemResume } = await import('../work_items/resume');
    const { shapeWorkItemsGet } = await import('../work_items/get-shape');
    const next = 'Review the saved reconnect evidence, then continue the plan.';
    await setWorkItemCheckpoint({ workspaceId: WORKSPACE, harness: HARNESS, workItemId: 'WI-101' },
      renderCarryNote({ did: 'Historical investigation '.repeat(500), next }));
    const resume = await readWorkItemResume({ id: 'WI-101', harness: HARNESS, assignee: 'successor', state: 'open',
      payload: { plan_item: { plan_slug: 'reconnect-plan', item_id: 'P-003' } } }, {
      checkpoint: ref => getWorkItemCheckpointWithMeta({ ...ref, workspaceId: WORKSPACE }),
      freshness: async () => undefined, evidence: evidenceStore.listSpecEvidence,
    });
    const packet = shapeWorkItemsGet({ ok: true, __resumeOnly: true,
      results: [{ ok: true, id: 'WI-101', resume }], counts: { ok: 1, failed: 0 } }, 'trimmed') as any;
    expect(packet.results[0].resume.nextAction.text).toBe(next);
    expect(packet.results[0].resume.evidence.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ testRunId: Number(run.id), specId: 'SPEC-003-01', outcome: 'pass' }),
    ]));
    expect(JSON.stringify(packet).length).toBeLessThan(6_000);
    const { observeFailureLoop, takePendingFailureLoopHint } = await import('../../failure-loop-circuit-breaker');
    const { buildFailureLoopHintText } = await import('../../failure-loop-hints');
    const ownerId = 'integration-efficiency-successor';
    for (let i = 0; i < 3; i++) observeFailureLoop({ ownerId, toolName: 'testing:run', args: { files: [testPath] },
      result: { ok: true, result: { content: [{ type: 'text', text: JSON.stringify({ ...result, evidenceBundle: bundle }) }] } }, now: i + 1 });
    const hint = takePendingFailureLoopHint(ownerId, 4);
    expect(hint).toMatchObject({ kind: 'repetition', category: 'test' });
    expect(await buildFailureLoopHintText(hint!)).toContain('Reuse the saved evidence');
    const recovered = await recoverTestEvidence({ workItemId: 'WI-101', planSlug: 'reconnect-plan', originRunId: runId, runId }, scope, deps);
    expect(recovered.rows[0]).toMatchObject({ testRunId: Number(run.id), phase: 'settled', outcome: 'pass', bindingStatus: 'unchanged' });
    await db.sql`UPDATE harness_shared.test_runs SET status = 'fail' WHERE id = ${run.id}`;
    const revised = await recoverTestEvidence({ workItemId: 'WI-101', planSlug: 'reconnect-plan', originRunId: runId, runId }, scope, deps);
    expect(revised.rows[0]).toMatchObject({ testRunId: Number(run.id), phase: 'review-required', outcome: 'unknown' });
    await writeFile(path.join(h.repoRoot, 'src/reconnect.ts'), 'export const reconnect = "changed after execution";\n');
    await finishTestEvidence(prepared, runId, runId, scope, result, deps);
    const changed = await evidenceStore.listSpecEvidence({ harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'] });
    expect(changed.every(row => row.currentness.overall === 'stale')).toBe(true);
  });
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
        planItemId: 'P-900',
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
        clause({
          planSlug: undefined,
          // A `P-NNN` label, not the work-item id: the revisions CHECK enforces that shape.
          // Per-item identity rides on `spec_id` and the edge row's `work_item_id`.
          planItemId: `P-${wi.slice(-3)}`,
          specId: `${wi}:S-001`,
          sourceValId: null,
        }),
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
    expect(items.map((r) => r.item_id)).toEqual(['P-900', 'P-901']);
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

  it('preserves executable details when a same-binding replay omits details', async () => {
    await specs.setSpecClause(clause({ mutationRequired: false }));
    const binding = {
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'test' as const,
      evidenceRef: 'test/reconnect.integration.ts#adequacy-replay',
      sourceFingerprint: 'git:adequacy-v1',
      testFingerprint: 'sha256:test-adequacy-v1',
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      actorId: 'su-test',
    };
    const executableDetails = {
      testExecution: {
        schemaVersion: 1,
        phase: 'settled',
        runId: 'run-adequacy-1',
        binding: { testPath: 'test/reconnect.integration.ts', testLayer: 'integration' },
      },
      adequacy: {
        outcome: 'pass',
        executed: true,
        pathReachable: true,
        oracleIndependent: true,
        testLayer: 'integration',
      },
    };
    const first = await evidenceStore.bindSpecEvidence({ ...binding, details: executableDetails });
    expect(first).toMatchObject({ status: 'created', specRevision: 1 });

    const replay = await evidenceStore.bindSpecEvidence(binding);
    expect(replay).toMatchObject({ status: 'unchanged', id: ('id' in first ? first.id : undefined) });

    const rows = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      workItemIds: ['WI-101'],
      evidenceRefs: [binding.evidenceRef],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual(executableDetails);
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
      currentness: {
        overall: 'unknown',
        provenance: 'attested-current',
        staleReasons: [],
        unknownReasons: ['current-fingerprints-attested-not-independently-measured'],
      },
    });
    expect(read.data.currentness).toEqual({ current: 0, stale: 0, unknown: 1 });
  });

  it('binds repository measurement recipes and recomputes currentness server-side', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const measurement = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/reconnect.ts'],
      testPaths: ['test/reconnect.test.ts'],
    };
    const created = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        binding: {
          workItemId: 'WI-101',
          specId: 'SPEC-003-01',
          evidenceKind: 'test',
          evidenceRef: 'test/reconnect.test.ts#server-measured',
          measurement,
          testRunId: external.testRunId,
          details: { adequacy: { executed: true, skipped: false, collected: true, outcome: 'passed' } },
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(created.data.results[0]).toMatchObject({ ok: true, status: 'created' });

    const [current] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/reconnect.test.ts#server-measured'],
    });
    expect(current).toMatchObject({
      details: { currentMeasurement: measurement },
      serverMeasurement: { status: 'measured' },
      currentness: {
        overall: 'current',
        provenance: 'server-measured',
        dimensions: { source: 'current', test: 'current', testRun: 'current' },
      },
    });

    await writeFile(path.join(h.repoRoot, 'src', 'reconnect.ts'), 'export const reconnect = false;\n');
    const [stale] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/reconnect.test.ts#server-measured'],
    });
    expect(stale.currentness).toMatchObject({
      overall: 'stale',
      provenance: 'server-measured',
      staleReasons: ['source-stale'],
    });
  });

  it('recomputes a registered sibling checkout recipe without widening to an arbitrary path', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const measurement = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      rootHarnessSlug: 'portal',
      sourcePaths: ['src/portal.ts'],
      testPaths: ['test/portal.test.ts'],
    };
    const created = (await bindTool.handler(
      {
        harness: HARNESS,
        slug: 'reconnect-plan',
        binding: {
          workItemId: 'WI-101',
          specId: 'SPEC-003-01',
          evidenceKind: 'test',
          evidenceRef: 'test/portal.test.ts#registered-sibling',
          measurement,
          testRunId: external.testRunId,
          details: { adequacy: { executed: true, skipped: false, collected: true, outcome: 'passed' } },
        },
      } as never,
      CTX,
    )) as { data: { results: Array<Record<string, unknown>> } };
    expect(created.data.results[0]).toMatchObject({ ok: true, status: 'created' });

    const [current] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/portal.test.ts#registered-sibling'],
    });
    expect(current).toMatchObject({
      details: { currentMeasurement: measurement },
      serverMeasurement: { status: 'measured' },
      currentness: { overall: 'current', provenance: 'server-measured' },
    });

    await writeFile(path.join(h.siblingRoot, 'src', 'portal.ts'), 'export const rendererTrust = false;\n');
    const [stale] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/portal.test.ts#registered-sibling'],
    });
    expect(stale.currentness).toMatchObject({
      overall: 'stale',
      provenance: 'server-measured',
      staleReasons: ['source-stale'],
    });
  });

  it('refuses a sibling measurement root that is not registered in this workspace', async () => {
    await expect(
      evidenceStore.measureRepoFilesEvidence(WORKSPACE, HARNESS, {
        schemaVersion: 1,
        kind: 'repo-files',
        rootHarnessSlug: 'not-registered',
        sourcePaths: ['src/portal.ts'],
      }),
    ).rejects.toThrow('repo_measurement_harness_root_unavailable:not-registered');
  });

  it('keeps legacy mixed repo and opaque fingerprints partially measured instead of promoting them', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const measurement = {
      schemaVersion: 1 as const,
      kind: 'repo-files' as const,
      sourcePaths: ['src/reconnect.ts'],
      testPaths: ['test/reconnect.test.ts'],
    };
    const measured = await evidenceStore.measureRepoFilesEvidenceAtRoot(h.repoRoot, measurement);
    await evidenceStore.bindSpecEvidence({
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'test',
      evidenceRef: 'test/reconnect.test.ts#legacy-mixed-measurement',
      ...measured,
      environmentFingerprint: 'node:24-postgres:17',
      testRunId: external.testRunId,
      details: { currentMeasurement: measurement },
      actorId: 'su-legacy-fixture',
    });

    const [mixed] = await evidenceStore.listSpecEvidence({
      harnessSlug: HARNESS,
      planSlugs: ['reconnect-plan'],
      evidenceRefs: ['test/reconnect.test.ts#legacy-mixed-measurement'],
      current: [
        {
          evidenceKind: 'test',
          evidenceRef: 'test/reconnect.test.ts#legacy-mixed-measurement',
          sourceFingerprint: measured.sourceFingerprint,
          testFingerprint: measured.testFingerprint,
          environmentFingerprint: 'node:24-postgres:17',
        },
      ],
    });
    expect(mixed).toMatchObject({
      serverMeasurement: {
        status: 'measured',
        measuredDimensions: ['source', 'test'],
        attestedDimensions: ['environment'],
      },
      currentness: {
        overall: 'unknown',
        provenance: 'partially-server-measured',
        dimensions: { source: 'current', test: 'current', environment: 'current' },
        unknownReasons: [
          'current-fingerprints-partially-attested-not-independently-measured:environment',
        ],
      },
    });
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

    // NARROWED, not loosened, by migration 1174 (WI-10001850 / D-011). Forging a
    // fingerprint is still rejected — but the table is no longer refusing EVERY update,
    // so a bare /append-only/ would now also be satisfied by the re-retraction and
    // alters-another-column errors and could no longer tell this case apart. Pin the
    // specific non-retraction message instead; the retraction cases are asserted in
    // their own describe block below.
    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings SET source_fingerprint = 'forged'
       WHERE id = ${(bound as { id: number }).id}`)
      .rejects.toThrow(/append-only; the only permitted update is a complete retraction stamp/);
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
      INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq)
      VALUES (${WORKSPACE}, ${HARNESS}, 'other-plan', 'P-009', 1)`;
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

describe('promotion contract join (P-006)', () => {
  it('attaches a promoted work-item to each current clause revision and is idempotent', async () => {
    const authored = await specs.setSpecClause(clause());
    expect(authored).toMatchObject({ status: 'created', revision: 1 });

    const first = await evidenceStore.ensureWorkItemSpecRevisionEdges({
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      planItemIds: ['P-003'],
      workItemId: 'WI-101',
      actorId: 'su-test',
    });
    expect(first).toEqual([
      {
        workItemId: 'WI-101',
        planSlug: 'reconnect-plan',
        specId: 'SPEC-003-01',
        specRevision: 1,
        specFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);

    const replay = await evidenceStore.ensureWorkItemSpecRevisionEdges({
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      planItemIds: ['P-003'],
      workItemId: 'WI-101',
      actorId: 'su-test',
    });
    expect(replay).toEqual(first);
    expect(
      await evidenceStore.listWorkItemSpecRevisionEdges({ harnessSlug: HARNESS, workItemId: 'WI-101' }),
    ).toEqual(first);
  });
});

/**
 * SPEC-P006-FAILED-SCENARIO-RERUN@1, integration layer (requiredTestLayers: integration + unit).
 *
 * The unit control for this guard hands `deps.list` a hand-built prior row, so it proves the
 * DECISION and nothing about the READ. The step it cannot reach is the one that actually has
 * to work here: `readSiblingEvidence` has to find the previous run's settled row through the
 * REAL `listSpecEvidence` query, against real Postgres, with fingerprints really measured off
 * disk — scoped by harness, plan, work item, spec, kind, and pinned to the same spec REVISION.
 *
 * That read failing is INVISIBLE to the falsifier arm on its own: `listSpecEvidence` throwing,
 * or simply matching nothing, resolves to `no-sibling-evidence`, which is ALSO `full-matrix`
 * and ALSO lands phase `stale-sibling-evidence`. A broken query and a correctly-detected stale
 * carry are indistinguishable at the phase. So the currency arm below is not decoration: it is
 * the only assertion that can tell "the guard fired because the row was stale" apart from "the
 * guard fired because the row was never found", and it must pass BEFORE and AFTER the fix.
 */
describe('narrowed reruns carry sibling scenarios only from a CURRENT ledger row (SPEC-P006-FAILED-SCENARIO-RERUN)', () => {
  const testPath = 'test/matrix.test.ts';
  const sourcePath = 'src/matrix.ts';
  const SCENARIOS = ['boot', 'retry', 'teardown', 'recover'];
  const PRIOR_RUN = 'aa4c9d0e-6d41-4a7e-9a1f-2b7d1c5e8f30';
  const RERUN = 'bb51e7c2-90d3-4f28-8c6a-3e9f0a4d7b11';

  beforeEach(async () => {
    await writeFile(path.join(h.repoRoot, sourcePath), 'export const matrix = true;\n');
    await writeFile(path.join(h.repoRoot, testPath), 'expect(matrix).toBe(true);\n');
    await specs.setSpecClause(clause({ mutationRequired: false }));
  });

  async function harness() {
    const { prepareTestEvidence, finishTestEvidence } = await import('../testing/evidence');
    const { readHarnessTestRunEvidence, countUnattributedTestRunRows } = await import('../../testing-run-store');
    const scope = { workspaceId: WORKSPACE, harnessSlug: HARNESS, actorId: 'su-test', root: h.repoRoot };
    const deps = {
      bind: evidenceStore.bindSpecEvidence,
      measure: evidenceStore.measureRepoFilesEvidenceAtRoot,
      // The REAL query — the whole point of exercising this at the integration layer.
      list: evidenceStore.listSpecEvidence,
      ledger: (args: Parameters<typeof readHarnessTestRunEvidence>[0]) => readHarnessTestRunEvidence({
        ...args, sql: h.sql as unknown as NonNullable<Parameters<typeof readHarnessTestRunEvidence>[0]['sql']>,
      }),
      unattributed: countUnattributedTestRunRows,
    };
    /** One run of the matrix file. `pattern` undefined = the unfiltered whole-file run. */
    const run = async (opts: { runId: string; pattern?: string; scenarioIds?: string[] }) => {
      const ids = opts.scenarioIds ?? SCENARIOS;
      const executed = opts.pattern ? 1 : ids.length;
      const prepared = await prepareTestEvidence({
        workItemId: 'WI-101', planSlug: 'reconnect-plan',
        bindings: [{ specId: 'SPEC-003-01', specRevision: 1, testPath, sourcePaths: [sourcePath],
          testLayer: 'integration' as const, scenarioIds: ids }],
      }, opts.runId, [testPath], scope, deps);
      await db.sql`INSERT INTO harness_shared.test_runs
        (workspace_id,harness_slug,file_path,status,finished_at,run_group_id)
        VALUES (${WORKSPACE},${HARNESS},${testPath},'pass',now(),${opts.runId})`;
      const result = {
        ok: true as const, runId: opts.runId, root: h.repoRoot, files: 1,
        passed: executed, failed: 0, skipped: ids.length - executed,
        failures: [], failuresTruncated: false, durationMs: 1,
        byFile: { [testPath]: { passed: executed, failed: 0, skipped: ids.length - executed, collectionFailed: false } },
        ...(opts.pattern ? { testNamePattern: opts.pattern } : {}),
      };
      return finishTestEvidence(prepared, opts.runId, opts.runId, scope, result, deps);
    };
    /**
     * The persisted row the guard has to re-read, as the REAL store returns it.
     *
     * The store types `details` as opaque `Record<string, unknown>` — it is jsonb, and it is
     * not this module's job to know what a caller put there. The shape THIS spec asserts on is
     * therefore named once, at the single point the opaque value is read back, rather than
     * re-asserted at each call site: four separate casts would let the recorded shape drift
     * while four assertions kept passing against four independent descriptions of it.
     */
    type PersistedDetails = {
      testExecution: {
        phase?: string; testNamePattern?: string; sourceStable?: boolean; siblingEvidenceRef?: string;
        rerunScope?: { scope?: string; reason?: string; carried?: string[]; stale?: string[] };
      };
      adequacy: { outcome?: string; executed?: boolean; scenarioIds?: string[] };
    };
    const persisted = async (runId: string) => {
      const rows = await evidenceStore.listSpecEvidence({
        harnessSlug: HARNESS, planSlugs: ['reconnect-plan'], workItemIds: ['WI-101'],
        specIds: ['SPEC-003-01'], evidenceKinds: ['test'], limit: 50,
      });
      const row = rows.find(candidate => String(candidate.evidenceRef).includes(runId));
      return row && { ...row, details: row.details as PersistedDetails };
    };
    return { run, persisted };
  }

  /** Edit the source AFTER the prior run settled: its recorded fingerprint now trails disk. */
  const editSourceAfterPriorRun = () =>
    writeFile(path.join(h.repoRoot, sourcePath), 'export const matrix = "edited after the matrix run";\n');

  // CURRENCY ARM / CALIBRATION. Must pass before AND after the fix. It is the only assertion
  // that proves the real query RESOLVED the sibling row — without it, a query that silently
  // matches nothing makes the falsifier arm below green for entirely the wrong reason.
  it('settles a narrowed rerun and names the real prior row it carried', async () => {
    const { run, persisted } = await harness();
    const prior = await run({ runId: PRIOR_RUN });
    expect(prior.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });

    const bundle = await run({ runId: RERUN, pattern: 'recover' });
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(bundle.verificationFingerprint).toBeTruthy();

    const settled = await persisted(RERUN);
    const priorRow = await persisted(PRIOR_RUN);
    expect(settled!.details.testExecution).toMatchObject({
      testNamePattern: 'recover',
      rerunScope: { scope: 'failed-scenario', reason: 'sibling-evidence-current', carried: SCENARIOS, stale: [] },
      // Read back through the store, so this is the ROW the query found — not a fake.
      siblingEvidenceRef: priorRow!.evidenceRef,
    });
  });

  // FALSIFIER ARM. The identical rerun with ONE variable moved: the source on disk changed
  // after the prior run recorded its proof, so the sibling scenarios' evidence no longer
  // describes the code under test and may not be carried.
  it('refuses to carry the remaining matrix once the prior row trails disk', async () => {
    const { run, persisted } = await harness();
    expect((await run({ runId: PRIOR_RUN })).rows[0]).toMatchObject({ phase: 'settled' });
    await editSourceAfterPriorRun();

    const bundle = await run({ runId: RERUN, pattern: 'recover' });
    expect(bundle.rows[0]).toMatchObject({ phase: 'stale-sibling-evidence', outcome: 'unknown' });
    expect(bundle.verificationFingerprint).toBeNull();

    const refused = await persisted(RERUN);
    expect(refused!.details.adequacy).toMatchObject({ outcome: 'unknown', executed: false });
    // `reason` and `stale` are load-bearing: a query that found NOTHING would report
    // `no-sibling-evidence` with an empty `stale`, at this very same phase.
    expect(refused!.details.testExecution.rerunScope).toMatchObject({
      scope: 'full-matrix', reason: 'stale-sibling-evidence', stale: ['source'], carried: [],
    });
    // The pre-existing prepare-vs-finish check cannot cover this case and must not be
    // credited with it: both measurements happen AFTER the edit, so the source looks stable.
    expect(refused!.details.testExecution.sourceStable).toBe(true);
  });

  // CALIBRATION. The guard must fire on the NARROWING, not on a stale prior row alone. An
  // unfiltered run re-measures the whole matrix itself, so it carries nothing and must still
  // settle against the very same stale row. Without this, an implementation that simply
  // refused any stale prior row would pass both arms above while taxing every ordinary rerun —
  // which is precisely the saving this plan exists to produce.
  it('still settles an UNFILTERED rerun against that same stale prior row', async () => {
    const { run, persisted } = await harness();
    expect((await run({ runId: PRIOR_RUN })).rows[0]).toMatchObject({ phase: 'settled' });
    await editSourceAfterPriorRun();

    const bundle = await run({ runId: RERUN });
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(bundle.verificationFingerprint).toBeTruthy();
    expect((await persisted(RERUN))!.details.testExecution.rerunScope).toBeUndefined();
  });

  // CALIBRATION. A binding claiming ONE scenario has no remaining matrix to carry, so the
  // narrowed run measured everything it claims and settles against the same stale row.
  it('still settles a single-scenario narrowed rerun against that same stale prior row', async () => {
    const { run, persisted } = await harness();
    expect((await run({ runId: PRIOR_RUN })).rows[0]).toMatchObject({ phase: 'settled' });
    await editSourceAfterPriorRun();

    const bundle = await run({ runId: RERUN, pattern: 'recover', scenarioIds: ['recover'] });
    expect(bundle.rows[0]).toMatchObject({ phase: 'settled', outcome: 'pass' });
    expect(bundle.verificationFingerprint).toBeTruthy();
    expect((await persisted(RERUN))!.details.testExecution.rerunScope).toBeUndefined();
  });
});

/**
 * Migration 1174 / WI-10001850 / decision D-011.
 *
 * The adequacy evaluator scans EVERY bound row for a (spec, revision) cohort and fails
 * the clause if ANY row names an uncollected/unexecuted run or has gone stale. Bindings
 * are append-only with no DISTINCT ON in the loader, so appending a corrected row cannot
 * outrank a bad one, and spec_revision is the only partitioning dimension — which left
 * bumping a clause revision purely to shed failing evidence as the only escape. D-011
 * forbids that as gate evasion. A recorded retraction is the sanctioned repair, so these
 * cases pin BOTH halves: the one mutation now permitted, and every mutation still refused.
 */
describe('recorded retraction is the one sanctioned repair for a malformed binding (D-011)', () => {
  const RETRACTOR = 'su-retraction-integration';

  async function bindOne(): Promise<number> {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
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
    return Number((bound as { id: number }).id);
  }

  const visibleIds = async (includeRetracted?: boolean): Promise<number[]> =>
    (
      await evidenceStore.listSpecEvidence({
        harnessSlug: HARNESS,
        planSlugs: ['reconnect-plan'],
        workItemIds: ['WI-101'],
        ...(includeRetracted === undefined ? {} : { includeRetracted }),
      })
    ).map((r) => Number((r as { id: number }).id));

  /**
   * THE REPAIR MUST ACTUALLY REPAIR. Retracting a malformed binding is only half of D-011's
   * sanctioned path; the other half is binding the corrected evidence afterwards. Migration
   * 1174 left spec_evidence_bindings_dedup a TOTAL unique index, so a retracted row kept its
   * dedup slot: the re-bind's `INSERT ... ON CONFLICT DO NOTHING` returned nothing, the
   * writer's fallback lookup matched that one retracted row (the index is unique over exactly
   * those columns, so it can match nothing else), and the call answered 'unchanged' naming it.
   * The caller was told the evidence was bound while every default reader excluded it — silent
   * success with zero live evidence, which is the undiagnosable state D-011 exists to end.
   *
   * Migration 1175 scopes the index to `retracted_at IS NULL` so a withdrawn row releases its
   * slot, and the writer's fallback lookup gained the matching filter. Binding the SAME payload
   * twice is the whole point of this test: a fresh testRunId would produce a different
   * binding_fingerprint and never reach the dedup path at all, which is why `bindOne` above
   * (it re-seeds external evidence per call) cannot be reused here.
   */
  it('lets identical evidence be re-bound after a retraction instead of deduping onto the withdrawn row', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const identical = {
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      workItemId: 'WI-101',
      specId: 'SPEC-003-01',
      evidenceKind: 'coverage-census' as const,
      evidenceRef: 'surface:POST /events',
      sourceFingerprint: 'git:abc123',
      coverageEvidenceRef: external.coverageEvidenceRef,
      testRunId: external.testRunId,
      actorId: 'su-test',
    };

    const first = await evidenceStore.bindSpecEvidence(identical);
    expect(first.status).toBe('created');
    const firstId = Number((first as { id: number }).id);

    // Positive control for the dedup path itself. While the row is LIVE the same payload must
    // still dedup onto it — otherwise the re-bind below would be proving only that two
    // different payloads insert twice, which says nothing about retraction.
    const replay = await evidenceStore.bindSpecEvidence(identical);
    expect(replay.status).toBe('unchanged');
    expect(Number((replay as { id: number }).id)).toBe(firstId);

    const withdrawn = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS,
      bindingId: firstId,
      reason: 'bound run was never collected or executed',
      actorId: RETRACTOR,
    });
    expect(withdrawn.status).toBe('retracted');

    const rebound = await evidenceStore.bindSpecEvidence(identical);
    expect(rebound.status).toBe('created');
    const reboundId = Number((rebound as { id: number }).id);
    expect(reboundId).not.toBe(firstId);

    // The decisive assertion: the default read carries LIVE proof again. Before 1175 this read
    // was empty for this binding while the call above reported success.
    const live = await visibleIds();
    expect(live).toContain(reboundId);
    expect(live).not.toContain(firstId);
    // The withdrawal itself stays auditable — the repair adds a row, it never erases one.
    expect(await visibleIds(true)).toContain(firstId);
  });

  it('accepts one complete stamp, then hides the row from default reads but not from an audit read', async () => {
    const id = await bindOne();
    expect(await visibleIds()).toContain(id);

    const result = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS,
      bindingId: id,
      reason: 'bound run was never collected or executed',
      actorId: RETRACTOR,
    });
    expect(result.status).toBe('retracted');
    // "Returns it in full" is the point of the audit read — a retraction must never be an
    // unattributable disappearance, so assert the recorded author and cause, not just the id.
    expect(result.binding).toMatchObject({
      retracted_by: RETRACTOR,
      retraction_reason: 'bound run was never collected or executed',
    });
    expect(result.binding?.retracted_at).toBeTruthy();

    // The default read is what the evaluator consumes: the bad row must stop counting.
    expect(await visibleIds()).not.toContain(id);
    expect(await visibleIds(false)).not.toContain(id);
    expect(await visibleIds(true)).toContain(id);

    // The row is hidden, never deleted — the withdrawn claim stays auditable.
    const [row] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.spec_evidence_bindings WHERE id = ${id}`;
    expect(row.n).toBe(1);
  });

  it('refuses a second retraction, so the recorded author and reason are final', async () => {
    const id = await bindOne();
    await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS, bindingId: id, reason: 'first and only withdrawal', actorId: RETRACTOR,
    });

    // The store reports the benign replay as a status rather than surfacing an opaque 55000.
    const replay = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS, bindingId: id, reason: 'rewriting history', actorId: 'su-someone-else',
    });
    expect(replay.status).toBe('already_retracted');
    expect(replay.binding).toMatchObject({
      retracted_by: RETRACTOR,
      retraction_reason: 'first and only withdrawal',
    });

    // …and the trigger refuses it underneath, so a raw writer cannot rewrite it either.
    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings
         SET retracted_at = now(), retracted_by = 'su-forger', retraction_reason = 'rewritten'
       WHERE id = ${id}`).rejects.toThrow(/already retracted; a retraction is one-way/);
  });

  it('refuses a retraction that alters any other column, and still refuses DELETE', async () => {
    const id = await bindOne();

    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings
         SET retracted_at = now(), retracted_by = ${RETRACTOR},
             retraction_reason = 'smuggling a fingerprint rewrite',
             source_fingerprint = 'forged'
       WHERE id = ${id}`).rejects.toThrow(/may not alter any other column/);

    await expect(db.sql`
      DELETE FROM harness_shared.spec_evidence_bindings WHERE id = ${id}`)
      .rejects.toThrow(/append-only; append a new exact evidence binding/);

    // Neither refusal left a mark: the row is untouched and still live proof.
    const [row] = await db.sql<{ source_fingerprint: string; retracted_at: Date | null }[]>`
      SELECT source_fingerprint, retracted_at
        FROM harness_shared.spec_evidence_bindings WHERE id = ${id}`;
    expect(row).toMatchObject({ source_fingerprint: 'git:abc123', retracted_at: null });
  });

  it('refuses a half-written stamp at BOTH rails — the trigger, and the CHECK beneath it', async () => {
    const id = await bindOne();

    // Rail 1, the trigger, which is what a real writer meets first.
    await expect(db.sql`
      UPDATE harness_shared.spec_evidence_bindings SET retracted_at = now()
       WHERE id = ${id}`).rejects.toThrow(/only permitted update is a complete retraction stamp/);

    // Rail 2, the CHECK. The trigger SHADOWS it for every update, so without disabling the
    // trigger this constraint is asserted by nothing and its absence would be invisible —
    // exactly the untested defence-in-depth claim this suite exists to keep honest.
    await db.sql.unsafe(
      'ALTER TABLE harness_shared.spec_evidence_bindings DISABLE TRIGGER spec_evidence_bindings_immutable',
    );
    try {
      await expect(db.sql`
        UPDATE harness_shared.spec_evidence_bindings SET retracted_at = now()
         WHERE id = ${id}`).rejects.toThrow(/spec_evidence_bindings_retraction_complete/);
      // A blank author or reason is half-written too, not a complete stamp.
      await expect(db.sql`
        UPDATE harness_shared.spec_evidence_bindings
           SET retracted_at = now(), retracted_by = '  ', retraction_reason = 'stated cause'
         WHERE id = ${id}`).rejects.toThrow(/spec_evidence_bindings_retraction_complete/);
    } finally {
      await db.sql.unsafe(
        'ALTER TABLE harness_shared.spec_evidence_bindings ENABLE TRIGGER spec_evidence_bindings_immutable',
      );
    }

    expect(await visibleIds()).toContain(id);
  });

  it('reports an unknown binding rather than silently succeeding', async () => {
    const missing = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS, bindingId: 2_147_000_001, reason: 'no such row', actorId: RETRACTOR,
    });
    expect(missing).toMatchObject({ status: 'not_found', binding: null });
  });

  /* Hiding a retraction from READS is only half the repair. `carryUnchangedBarEvidenceBindings`
   * is the one reader outside this store that does not merely READ the table — it re-INSERTS
   * prior-revision rows under the next revision on every bar amendment. Unfiltered, it would
   * therefore RESURRECT a retracted binding as a fresh, un-retracted row, silently undoing the
   * repair at a later revision bump that nobody would connect to the retraction. That is worse
   * than never retracting: the clause goes green in between, and a green verdict is exactly what
   * stops anyone looking. D-011 makes recorded retraction the ONLY sanctioned repair, so a carry
   * that reverses one defeats the whole path. */
  it('does not resurrect a retracted binding when a bar amendment carries proof forward', async () => {
    await specs.setSpecClause(clause());
    const external = await seedExternalEvidence();
    const bind = async (evidenceRef: string): Promise<number> => {
      const bound = await evidenceStore.bindSpecEvidence({
        harnessSlug: HARNESS,
        planSlug: 'reconnect-plan',
        workItemId: 'WI-101',
        specId: 'SPEC-003-01',
        evidenceKind: 'coverage-census',
        evidenceRef,
        sourceFingerprint: 'git:abc123',
        coverageEvidenceRef: external.coverageEvidenceRef,
        testRunId: external.testRunId,
        actorId: 'su-test',
      });
      expect(bound.status).toBe('created');
      return Number((bound as { id: number }).id);
    };

    const poisoned = await bind('surface:POST /events');
    // POSITIVE CONTROL, and it is load-bearing: a carry of 0 is ambiguous on its own, because
    // "the retraction filter worked" and "the carry matched nothing at all" (a mis-seeded edge,
    // the wrong prior revision, a broken join) produce an identical reading. The surviving row
    // proves the carry ran, saw this cohort, and rejected only the retracted member.
    await bind('surface:GET /events');

    const withdrawn = await evidenceStore.retractSpecEvidence({
      harnessSlug: HARNESS,
      bindingId: poisoned,
      reason: 'bound run was never collected or executed',
      actorId: RETRACTOR,
    });
    expect(withdrawn.status).toBe('retracted');

    // Amend the clause (revision 1 -> 2) and attach the work-item to the NEW revision: that
    // edge is what the carry joins through, so without it nothing is eligible to carry.
    const amended = await specs.setSpecClause(
      clause({
        expectedRevision: 1,
        behavior: 'Acknowledged event 42 is not replayed after reconnect, even across a restart.',
      }),
    );
    expect(amended.status).not.toBe('conflict');
    const [next] = await db.sql<{ revision: number; content_hash: string }[]>`
      SELECT revision, content_hash FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'
       ORDER BY revision DESC LIMIT 1`;
    expect(Number(next.revision)).toBe(2);
    await db.sql`
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision,
         spec_fingerprint, created_by)
      VALUES (${WORKSPACE}, ${HARNESS}, 'WI-101', 'reconnect-plan', 'SPEC-003-01',
              ${next.revision}, ${next.content_hash}, 'su-test')
      ON CONFLICT DO NOTHING`;

    const carried = await carryUnchangedBarEvidenceBindings(db.sql, {
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
      planSlug: 'reconnect-plan',
      specId: 'SPEC-003-01',
      priorRevision: 1,
      nextRevision: Number(next.revision),
      nextSpecFingerprint: next.content_hash,
    });
    expect(carried).toBe(1);

    const landed = (
      await db.sql<{ evidence_ref: string }[]>`
        SELECT evidence_ref FROM harness_shared.spec_evidence_bindings
         WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
           AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'
           AND spec_revision = ${next.revision}
         ORDER BY evidence_ref`
    ).map((row) => row.evidence_ref);
    expect(landed).toEqual(['surface:GET /events']);
    expect(landed).not.toContain('surface:POST /events');

    // And the withdrawal itself is still the only record of that proof: the retracted row stays
    // retracted at its own revision rather than being joined by an un-retracted twin.
    const [{ count }] = await db.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS}
         AND plan_slug = 'reconnect-plan' AND spec_id = 'SPEC-003-01'
         AND evidence_ref = 'surface:POST /events' AND retracted_at IS NULL`;
    expect(Number(count)).toBe(0);
  });
});
