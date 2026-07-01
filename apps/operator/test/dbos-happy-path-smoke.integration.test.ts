/**
 * dbos-happy-path-smoke.integration.test.ts — the P-006 early end-to-end smoke
 * gate for `dbos-system-completion-2026-06-01`.
 *
 * D-008's lesson: a static / prompt-centric audit structurally CANNOT see "the
 * path throws." Before the retire plan's D-014 fix (commit e3e688df1) the DBOS
 * worker step threw BEFORE reading a single feature — twice — and it looked like
 * empty output, so the whole audit was moot. This gate makes the happy path
 * observably execute and pins the exact bug class so it can't silently regress.
 * It is the early counterpart to P-030's full real-agent behavioral spot-run; it
 * is deliberately deterministic (no real LLM spawn) so it runs in CI and can be
 * RE-RUN after each Phase-2 fill (P-011 CONVERT_ISSUES, P-012 debugger).
 *
 * Two tiers, matching the pipeline shape dispatch → director → worker → validator
 * → DONE → finalize:
 *
 *   1. Real-Postgres reads do NOT throw (the D-014 regression surface):
 *      - readFeaturesPg reads the plan slug from metadata->>'source_plan' (the
 *        `source_plan_slug does not exist` column bug) and honors started-plan
 *        gating;
 *      - readPlan tolerates BOTH a proper jsonb array AND a legacy double-encoded
 *        `files` string (the `paths.map is not a function` crash).
 *   2. The decision-loop wiring (pure) classifies a full director script
 *      NEXT_WORKER → NEXT_VALIDATOR → DONE to dispatch/dispatch/terminal with no
 *      `unsupported` dead-end, the dispatch frontier (computeFrontier) picks the
 *      ready feature, and planFinalization(done) yields the curator+documenter steps.
 *
 * Tier 2 has no PG dependency and lives in its own describe (no beforeAll), so it
 * runs even if Docker/testcontainers is unavailable; tier 1 is gated on the
 * shared testcontainer like the other engine *-pg integration tests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from './_pg-helpers';
import { readFeaturesPg, parseDecision, type PgStateContext } from '@papercusp/orchestrator';
// eslint-disable-next-line import/no-relative-packages -- exercise the real durable modules
import { readPlan, type ChunkPlanPgCtx } from '../../../libs/papercusp/packages/orchestrator/src/chunk-plan-pg';
import { classifyDecision } from '@papercusp/operator-core/lib/dbos/orchestrator-decide';
import { computeFrontier } from '@papercusp/operator-core/lib/dbos/orchestrator-loop';
import { planFinalization } from '@papercusp/operator-core/lib/dbos/orchestrator-finalize';

const WS = 'ws_smoke';
const SLUG = 'smoke';

// ── Tier 1 — real-Postgres reads must not throw (D-014 regression gate) ────────
describe('DBOS happy-path smoke — real-PG reads do not throw (D-008/D-014 regression)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('dbos_smoke');
    // Per-schema harness_features (faithful column types — metadata JSONB is what
    // makes metadata->>'source_plan' resolve; search_path resolves the unqualified
    // name to public here, exactly as harness_<slug> does in prod).
    await db.sql.unsafe(`
      CREATE TABLE public.harness_features (
        harness_slug TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        feature_id TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        status TEXT NOT NULL,
        attempts BIGINT NOT NULL DEFAULT 0,
        claims TEXT,
        notes TEXT,
        metadata JSONB,
        kind TEXT,
        project_id TEXT,
        expected_cost_cents BIGINT,
        tags JSONB,
        needs_human_review BOOLEAN NOT NULL DEFAULT FALSE,
        ts BIGINT,
        created_ts BIGINT NOT NULL DEFAULT 0,
        updated_ts BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, feature_id)
      );
      -- PG-canonical plans: dispatch gate reads harness_plans.op_status.
      CREATE TABLE harness_shared.harness_plans (
        workspace_id TEXT NOT NULL,
        harness_slug TEXT NOT NULL,
        plan_slug TEXT NOT NULL,
        op_status TEXT,
        op_priority INT,
        op_started_at TIMESTAMPTZ,
        PRIMARY KEY (workspace_id, harness_slug, plan_slug)
      );
      -- G2 auditor-admission gate: readFeaturesPg LEFT JOINs this for origin +
      -- audit_verdict. Seeded EMPTY so the join yields NULL hfc → every feature is
      -- treated as local/pickable (matches the pre-G1 "no consolidated row" path).
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id TEXT,
        harness_slug TEXT NOT NULL,
        feature_id TEXT NOT NULL,
        origin TEXT,
        audit_verdict TEXT,
        source_plan_slug TEXT,
        PRIMARY KEY (harness_slug, feature_id)
      );
      CREATE TABLE harness_shared.harness_chunk_plans (
        workspace_id TEXT NOT NULL,
        harness_slug TEXT NOT NULL,
        feature_id TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        chunk_index INT NOT NULL,
        files JSONB NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        strikes INT NOT NULL DEFAULT 0,
        last_error TEXT,
        commit_sha TEXT,
        PRIMARY KEY (workspace_id, harness_slug, feature_id, chunk_id)
      );
    `);

    // smoke-plan is started; other-plan is NOT — gating must keep its feature out.
    await db.sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, op_status)
      VALUES (${WS}, ${SLUG}, 'smoke-plan', 'started')`;

    const ins = (
      fid: string,
      status: string,
      meta: Record<string, string> | null,
    ) =>
      db.sql`INSERT INTO public.harness_features
        (harness_slug, workspace_id, feature_id, title, status, metadata, created_ts, updated_ts)
        VALUES (${SLUG}, ${WS}, ${fid}, ${`feature ${fid}`}, ${status},
                ${meta === null ? db.sql`NULL` : db.sql.json(meta)}, 0, 0)`;

    await ins('F-001', 'todo', null); // no plan → always eligible
    await ins('F-002', 'todo', { source_plan: 'smoke-plan' }); // started plan → eligible
    await ins('F-003', 'todo', { source_plan: 'other-plan' }); // unstarted plan → excluded
    await ins('F-004', 'passed', null); // terminal → not NEEDS_WORK

    // Two chunks for F-001: a proper jsonb array AND a legacy double-encoded
    // string (the `paths.map is not a function` crash). Both must decode.
    await db.sql`INSERT INTO harness_shared.harness_chunk_plans
      (workspace_id, harness_slug, feature_id, chunk_id, chunk_index, files, description)
      VALUES (${WS}, ${SLUG}, 'F-001', 'F-001-1', 1, ${db.sql.json(['src/a.ts'])}, 'do a')`;
    await db.sql`INSERT INTO harness_shared.harness_chunk_plans
      (workspace_id, harness_slug, feature_id, chunk_id, chunk_index, files, description)
      VALUES (${WS}, ${SLUG}, 'F-001', 'F-001-2', 2, ${db.sql.json('["src/b.ts"]')}, 'do b')`;
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const stateCtx = (): PgStateContext => ({
    pg: db.sql as unknown as PgStateContext['pg'],
    workspaceId: WS,
    harnessSlug: SLUG,
  });
  const planCtx = (): ChunkPlanPgCtx => ({
    pg: db.sql as unknown as ChunkPlanPgCtx['pg'],
    workspaceId: WS,
    harnessSlug: SLUG,
  });

  it('readFeaturesPg reads metadata->>source_plan + started-plan gating without throwing', async () => {
    const features = await readFeaturesPg(stateCtx());
    const ids = features.map((f) => f.id).sort();
    // F-001 (no plan) + F-002 (started plan) + F-004 (passed, still a row) — but
    // NOT F-003 (its plan isn't started).
    expect(ids).toContain('F-001');
    expect(ids).toContain('F-002');
    expect(ids).not.toContain('F-003');
  });

  it('readPlan tolerates both a jsonb array and a legacy double-encoded files string', async () => {
    const chunks = await readPlan(planCtx(), 'F-001');
    expect(chunks).toHaveLength(2);
    expect(chunks[0].files).toEqual(['src/a.ts']); // proper array
    expect(chunks[1].files).toEqual(['src/b.ts']); // legacy string → parsed, no paths.map throw
  });

  it('the dispatch frontier selects ready features from the real read', async () => {
    const features = (await readFeaturesPg(stateCtx())).map((f) => ({
      id: f.id,
      status: f.status,
      blockedBy: [] as string[],
      sourcePlan: null,
      order: null,
    }));
    const { toStart } = computeFrontier(features, new Map(), new Set(), 4);
    expect(toStart).toContain('F-001');
    expect(toStart).toContain('F-002');
    expect(toStart).not.toContain('F-004'); // passed is terminal, not NEEDS_WORK
  });
});

// ── Tier 2 — decision-loop wiring (pure, no PG) ────────────────────────────────
describe('DBOS happy-path smoke — decision loop classifies director → worker → validator → DONE', () => {
  const FID = 'F-001';

  it('a full happy-path director script flows to dispatch/dispatch/terminal with no dead-end', () => {
    const script = ['NEXT_WORKER', 'NEXT_VALIDATOR', 'DONE'];
    const actions = script.map((line) => classifyDecision(parseDecision(line), FID));

    expect(actions[0]).toEqual({ kind: 'dispatch', role: 'worker', feature: FID, extras: [`FEATURE_ID=${FID}`] });
    expect(actions[1]).toEqual({ kind: 'dispatch', role: 'validator', feature: FID, extras: [`FEATURE_ID=${FID}`] });
    expect(actions[2]).toEqual({ kind: 'terminal', outcome: 'done' });

    // The D-002 failure mode: a verb the engine silently drops. The happy path
    // must never classify to `unsupported` (which dead-ends the pipeline).
    expect(actions.some((a) => a.kind === 'unsupported')).toBe(false);
  });

  it('planFinalization(done) yields the curator + documenter finalize steps, unblocked', () => {
    const plan = planFinalization({
      outcome: 'done',
      needsHumanOpen: false,
      smokeEnabled: false,
      smokePassed: null,
      archiveOnDone: false,
    });
    expect(plan.blocked).toBe(false);
    const invokeRoles = plan.steps.filter((s) => s.kind === 'invoke').map((s) => (s as { role: string }).role);
    expect(invokeRoles).toContain('curator');
    expect(invokeRoles).toContain('documenter');
  });
});
