/**
 * hive-loop-e2e.integration.test.ts — plan hive-loop-e2e-testing-2026-06-10
 * P-001: the whole-chain happy path of the autonomous hive loop, proven against
 * a REAL DBOS runtime + a REAL fully-migrated Postgres (per-file throwaway DB).
 *
 * The chain under test (links 1→4 of the loop; D-002 — the autonomous trigger
 * chain previously had ZERO end-to-end coverage):
 *
 *   routineFireWorkflow (the durable per-routine fire the 30s routinesTick
 *   enqueues — fired DIRECTLY here; the cron wrapper is DBOS's own machinery)
 *     → system:blueprint-run handler (real registry dispatch, real
 *       effective-blueprint resolution falling back to the built-in `coding`
 *       blueprint, real autoloop fire-gate read against harness_shared.autoloop_state)
 *     → the Pot/Queen turn at the agent boundary (setBlueprintRunFire seam — the
 *       fake Pot queues two features into harness_shared.harness_features_consolidated,
 *       exactly the write a real Pot turn's work_items:create lands)
 *     → dispatchOneHarness (the REAL dispatcher — the single choke point both the
 *       30s orchestratorTick and refillHarnessOnSettle funnel through): frontier
 *       read from the work_items view, durable-ownership carve-out against
 *       dbos.workflow_status, blueprint dispatch gate (safe default cap=1)
 *     → featurePipelineWorkflow turns director→worker→director→validator→director
 *       via the injected fake PipelineInvokeRunner (the same agent boundary the
 *       operator wires to invoke())
 *     → DONE → finalizer exactly once (checkpointed step)
 *     → settled hook → refillHarnessOnSettle: the freed slot starts the NEXT
 *       queued feature with NO further manual kick.
 *
 * Oracle families asserted (plan §Oracles):
 *   - Liveness: each queued feature reaches DONE within its turn budget; the
 *     freed slot starts the next queued feature autonomously.
 *   - Safety: finalizer fires exactly once per pipeline; idempotency keys are
 *     the replay-stable `<slug>:<feature>:<role>:t<turn>`.
 *   - Resources: with cap=1 (the dispatch gate's safe default) the second
 *     feature never runs concurrently with the first — strict serialization.
 *   - Hygiene: the routine row records no last_error; both features leave the
 *     NEEDS_WORK set in real PG state (status 'passed' via the work_items view).
 *
 * Setup mirrors orchestrator-dedup.integration.test.ts (DBOS: setConfig →
 * import workflows → launch) + _baseline-coord-fixture.ts (env-routing the REAL
 * getOrgPg()/getHarnessAdminUrl() at a migrated throwaway DB — no module mocks,
 * the production connection path end to end). The DBOS system schema lives in
 * the SAME throwaway DB (schema `dbos`), as in production, so the dispatcher's
 * durable-ownership carve-out (durableOwnedFeatureIdsPg) reads real state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-hive-e2e';
const SLUG = 'hive-e2e';
const RID = 'rt-hive-e2e-0';
const F1 = 'F-HIVE-1';
const F2 = 'F-HIVE-2';

// Env pins — set BEFORE any module under test is (dynamically) imported.
// Workspace pin: activeWorkspaceId()/backgroundWorkspaceIds() resolve to the
// test workspace without an FS registry (the gym boot-spec does the same).
process.env.PAPERCUSP_WORKSPACE_ID = WS;
// Never resolve a PG URL from ~/.papercusp/embedded-pg.json on this box.
process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
// The routinesTick scheduled workflow registers at import — pin its crontab to
// Jan 1 00:00:00 so the cron NEVER fires mid-test (we fire the routine workflow
// directly; the plan's "never wait for the 30s cron in tests").
process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB = '0 0 0 1 1 *';
// Don't arm the 30s orchestratorTick either — the test drives dispatchOneHarness
// (the exact impl the tick loops over) deterministically.
process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = 'none';

let DBOS: typeof DBOSType;
let db: OrgTestDb;

// Modules under test (dynamically imported after DBOS.setConfig).
let routineFireWorkflow: typeof import('./routines-workflow').routineFireWorkflow;
let dispatchOneHarness: typeof import('./orchestrator-loop').dispatchOneHarness;
let refillHarnessOnSettle: typeof import('./orchestrator-loop').refillHarnessOnSettle;
let runWithWorkspace: typeof import('../workspace-als').runWithWorkspace;

type RunnerCall = { role: string; feature: string; key: string };
const runnerCalls: RunnerCall[] = [];
const finalizeCalls: Array<{ featureId: string; outcome: string }> = [];
const potTurns: Array<{ installSlug: string; role: string }> = [];

// Per-feature director script: the decision sequence a real director's LLM
// output would parse to (the verbs are the coding spine's own vocabulary).
const directorIdx: Record<string, number> = {};
const directorScript = (fid: string): string[] => [`NEXT_WORKER ${fid}`, `NEXT_VALIDATOR ${fid}`, 'DONE'];

beforeAll(async () => {
  db = await createOrgTestDb();

  // Route the REAL connection resolvers at the migrated throwaway DB. Both are
  // read lazily on first client build, which happens after this point.
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.DATABASE_URL = db.adminDsn;

  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: db.adminDsn, // dbos schema in the SAME DB, as in production
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'test-v1',
    runAdminServer: false,
  });

  // Register workflows + system actions AFTER setConfig, BEFORE launch — mirrors
  // lib/dbos/bootstrap.ts. routines-workflow side-effect-imports the full
  // system-action registry (incl. system:blueprint-run).
  const wf = await import('./orchestrator-workflow');
  const loop = await import('./orchestrator-loop');
  const routines = await import('./routines-workflow');
  const bra = await import('../blueprint/blueprint-run-action');
  const als = await import('../workspace-als');

  routineFireWorkflow = routines.routineFireWorkflow;
  dispatchOneHarness = loop.dispatchOneHarness;
  refillHarnessOnSettle = loop.refillHarnessOnSettle;
  runWithWorkspace = als.runWithWorkspace;

  // ── Seam 1: the Pot/Queen turn (agent boundary of system:blueprint-run).
  // The real fire POSTs the invoke route and a Pot agent runs; the fake Pot
  // queues two features — the exact PG write a real Pot's work_items:create
  // lands — and "declares its wake" by leaving the schedule routine active.
  bra.setBlueprintRunFire(async ({ installSlug, workspaceId, role }) => {
    potTurns.push({ installSlug, role });
    const now = Date.now();
    for (const [i, fid] of [F1, F2].entries()) {
      await db.adminSql`
        INSERT INTO harness_shared.harness_features_consolidated
          (harness_slug, feature_id, title, summary, status, attempts, item_kind,
           payload, needs_human_review, workspace_id, feature_order, ts, created_ts, updated_ts)
        VALUES
          (${installSlug}, ${fid}, ${`Toy feature ${fid}`}, null, 'todo', 0, 'feature',
           null, false, ${workspaceId}, ${i + 1}, ${now}, ${now}, ${now})
        ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
    }
  });

  // ── Seam 2: the pipeline agent boundary (PipelineInvokeRunner). The director
  // walks its script; the validator performs the real validator's PG effect
  // (status → 'passed', which removes the feature from the NEEDS_WORK frontier).
  wf.setPipelineInvokeRunner(async (_slug, role, feature, key) => {
    runnerCalls.push({ role, feature, key });
    if (role === 'director') {
      const idx = directorIdx[feature] ?? 0;
      directorIdx[feature] = idx + 1;
      return { output: directorScript(feature)[idx] ?? 'IDLE', exitCode: 0 };
    }
    if (role === 'validator') {
      await db.adminSql`
        UPDATE harness_shared.harness_features_consolidated
           SET status = 'passed', updated_ts = ${Date.now()}
         WHERE harness_slug = ${SLUG} AND feature_id = ${feature}`;
    }
    return { output: `ran ${role}`, exitCode: 0 };
  });

  // ── Seam 3: terminal finalizer — counted to prove exactly-once.
  wf.setPipelineFinalizer(async ({ featureId, outcome }) => {
    finalizeCalls.push({ featureId, outcome });
  });

  // ── Seam 4: the settled hook wired to the PRODUCTION refill — a DONE
  // pipeline immediately re-dispatches its harness (slot refill).
  wf.setPipelineSettledHook((slug, ws) => refillHarnessOnSettle(slug, ws ?? WS));

  await DBOS.launch();
}, 300_000);

afterAll(async () => {
  try {
    await DBOS.shutdown();
  } catch {
    /* best-effort */
  }
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

/** Poll until a workflow with the given id-prefix exists and is SUCCESS. */
async function awaitWorkflowSuccess(prefix: string, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const rows = await DBOS.listWorkflows({ workflow_id_prefix: prefix });
    if (rows.length > 0) {
      const id = rows[0].workflowID;
      return (await DBOS.getResult<string>(id, Math.max(1, Math.ceil((deadline - Date.now()) / 1000)))) ?? '';
    }
    if (Date.now() > deadline) throw new Error(`workflow ${prefix} never appeared`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('hive loop whole-chain E2E (P-001)', () => {
  it('routine fire → blueprint-run → Pot queues work → dispatch → pipeline DONE → finalize once → refill starts the next feature', async () => {
    // The bp-schedule-* routine row exactly as materializeBlueprintTriggers
    // writes it (link 1's source of truth), parked far in the future so the
    // scheduled tick never claims it — the test fires the workflow directly.
    await db.adminSql`
      INSERT INTO harness_shared.routines
        (id, install_slug, name, trigger_kind, trigger_config, target_role,
         payload_template, active, next_fire_at, workspace_id)
      VALUES
        (${RID}, ${SLUG}, 'bp-schedule-0', 'cron', ${'{"cron":"*/30 * * * * *"}'}::jsonb,
         'system:blueprint-run', null, true, now() + interval '1 year', ${WS})`;

    // ── Link 1→2: the durable routine fire. Real registry dispatch, real
    // blueprint resolution (falls back to built-in coding → decider 'director'),
    // real fire-gate read (clean autoloop_state → allow), then the fake Pot turn.
    await routineFireWorkflow(RID, WS, SLUG, 'system:blueprint-run', { cron: '*/30 * * * * *' }, null);

    const startCheckpoints = await db.adminSql`
      SELECT workflow_uuid, function_name FROM dbos.operation_outputs
       WHERE function_name = 'routine-fire-start'`;
    expect(startCheckpoints.length).toBeGreaterThan(0);

    expect(potTurns).toEqual([{ installSlug: SLUG, role: 'director' }]);

    // The Pot turn queued both features (real PG state via the work_items view).
    const queued = await db.adminSql`
      SELECT feature_id, status FROM harness_shared.work_items
       WHERE harness_slug = ${SLUG} AND workspace_id = ${WS} ORDER BY feature_order`;
    expect(queued.map((r) => [r.feature_id, r.status])).toEqual([
      [F1, 'todo'],
      [F2, 'todo'],
    ]);

    // ── Link 2→4: the real dispatcher picks up the queued work. Resources
    // oracle: the safe-default cap of 1 admits exactly ONE pipeline.
    const tick = await runWithWorkspace(WS, () => dispatchOneHarness(SLUG, WS));
    expect(tick.started).toEqual([F1]);

    // F1's pipeline runs to DONE.
    const res1 = await DBOS.getResult<string>(`pipeline:${SLUG}:${F1}:e0`, 60);
    expect(res1).toBe('pipeline-complete (last=DONE)');

    // ── Liveness oracle: the freed slot starts F2 with NO further manual kick —
    // the settled hook → refillHarnessOnSettle path is the only dispatcher left.
    const res2 = await awaitWorkflowSuccess(`pipeline:${SLUG}:${F2}:e`, 60_000);
    expect(res2).toBe('pipeline-complete (last=DONE)');

    // ── Safety oracle: finalizer fired exactly once per pipeline, outcome done.
    expect(finalizeCalls).toEqual([
      { featureId: F1, outcome: 'done' },
      { featureId: F2, outcome: 'done' },
    ]);

    // ── Safety oracle: replay-stable idempotency keys, full role sequence.
    const f1Calls = runnerCalls.filter((c) => c.feature === F1);
    expect(f1Calls.map((c) => [c.role, c.key])).toEqual([
      ['director', `${SLUG}:${F1}:director:t0`],
      ['worker', `${SLUG}:${F1}:worker:t0`],
      ['director', `${SLUG}:${F1}:director:t1`],
      ['validator', `${SLUG}:${F1}:validator:t1`],
      ['director', `${SLUG}:${F1}:director:t2`],
    ]);

    // ── Resources oracle: cap=1 strict serialization — every F2 agent run
    // happened AFTER the last F1 agent run (no interleaving at the ceiling).
    const lastF1 = runnerCalls.map((c) => c.feature).lastIndexOf(F1);
    const firstF2 = runnerCalls.map((c) => c.feature).indexOf(F2);
    expect(firstF2).toBeGreaterThan(lastF1);

    // ── Hygiene oracle: both features left the NEEDS_WORK set in real PG state…
    const finalRows = await db.adminSql`
      SELECT feature_id, status FROM harness_shared.work_items
       WHERE harness_slug = ${SLUG} ORDER BY feature_order`;
    expect(finalRows.map((r) => [r.feature_id, r.status])).toEqual([
      [F1, 'passed'],
      [F2, 'passed'],
    ]);

    // …exactly one pipeline lifetime per feature (no phantom re-dispatch of a
    // passed feature by the refill), and the routine recorded no failure.
    const wfs = await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${SLUG}:` });
    expect(wfs.map((w) => w.workflowID).sort()).toEqual([
      `pipeline:${SLUG}:${F1}:e0`,
      `pipeline:${SLUG}:${F2}:e0`,
    ]);
    const [routineRow] = await db.adminSql`
      SELECT metadata FROM harness_shared.routines WHERE id = ${RID}`;
    expect(routineRow.metadata?.last_error).toBeUndefined();
  }, 180_000);
});
