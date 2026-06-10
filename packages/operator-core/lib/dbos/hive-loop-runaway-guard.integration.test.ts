/**
 * hive-loop-runaway-guard.integration.test.ts — plan hive-loop-e2e-testing-2026-06-10
 * P-004: the runaway guard, proven against a REAL DBOS runtime + migrated PG.
 *
 * A "validator rejects forever" pathology has two containment layers, and this
 * file proves both (the unit test orchestrator-workflow.test.ts proves the
 * loop math with a mocked DBOS; here the REAL checkpointed loop runs):
 *
 *   1. The hard ceiling — a director that NEVER decides a terminal verb is cut
 *      off at maxTurns (PAPERCUSP_DBOS_PIPELINE_MAX_TURNS=5 here): the workflow
 *      COMPLETES (never an infinite loop), runs exactly maxTurns decide+dispatch
 *      pairs, does NOT finalize, does NOT refill — and the feature remains in
 *      the NEEDS_WORK frontier, so the next dispatch sweep starts a FRESH EPOCH
 *      (e1) rather than stranding the work or resurrecting e0.
 *
 *   2. The judgment path — a director that reacts to persistent validator
 *      rejection by deciding ESCALATE produces the escalate terminal: the
 *      finalizer (the on-escalate hook's checkpointed seam) fires EXACTLY once
 *      with the director's reason, and the settled/refill hook does NOT fire
 *      (escalate leaves the feature re-pickable; an immediate refill would be a
 *      tight re-dispatch loop — the 30s backstop owns that).
 *
 * Pipelines are started through the REAL dispatcher (dispatchOneHarness), so
 * frontier readiness + epoch progression are asserted on real PG state.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const WS = 'ws-runaway';
const SLUG_RUN = 'runaway';
const SLUG_ESC = 'esc';
const F_RUN = 'F-RUNAWAY';
const F_ESC = 'F-ESC';
const MAX_TURNS = 5;

process.env.PAPERCUSP_WORKSPACE_ID = WS;
process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
process.env.PAPERCUSP_DBOS_ROUTINES_CRONTAB = '0 0 0 1 1 *';
process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = 'none';
process.env.PAPERCUSP_DBOS_PIPELINE_MAX_TURNS = String(MAX_TURNS);

let DBOS: typeof DBOSType;
let db: OrgTestDb;
let dispatchOneHarness: typeof import('./orchestrator-loop').dispatchOneHarness;
let runWithWorkspace: typeof import('../workspace-als').runWithWorkspace;

type RunnerCall = { role: string; feature: string; key: string };
const runnerCalls: RunnerCall[] = [];
const finalizeCalls: Array<{ featureId: string; outcome: string; reason?: string }> = [];
let settledCalls = 0;

beforeAll(async () => {
  db = await createOrgTestDb();
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.DATABASE_URL = db.adminDsn;

  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: db.adminDsn,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'test-v1',
    runAdminServer: false,
  });

  const wf = await import('./orchestrator-workflow');
  const loop = await import('./orchestrator-loop');
  const als = await import('../workspace-als');
  dispatchOneHarness = loop.dispatchOneHarness;
  runWithWorkspace = als.runWithWorkspace;

  // Director decisions are a pure function of (feature, turn-from-key) so DBOS
  // replay is deterministic. F-RUNAWAY never terminates: the validator
  // "rejects" every time and the director keeps cycling worker→validator.
  // F-ESC's director reacts to the rejection pattern by ESCALATING at turn 2.
  wf.setPipelineInvokeRunner(async (_slug, role, feature, key) => {
    runnerCalls.push({ role, feature, key });
    if (role === 'director') {
      const turn = Number(/:t(\d+)$/.exec(key)?.[1] ?? '0');
      if (feature === F_RUN) {
        return { output: turn % 2 === 0 ? `NEXT_WORKER ${feature}` : `NEXT_VALIDATOR ${feature}`, exitCode: 0 };
      }
      const script = [`NEXT_WORKER ${feature}`, `NEXT_VALIDATOR ${feature}`, 'ESCALATE validator-rejects-forever'];
      return { output: script[turn] ?? 'IDLE', exitCode: 0 };
    }
    // The validator always rejects (output content is the director's input in
    // production; the machinery under test only sees exitCode 0).
    return { output: role === 'validator' ? 'VALIDATION REJECTED' : `ran ${role}`, exitCode: 0 };
  });

  wf.setPipelineFinalizer(async ({ featureId, outcome, reason }) => {
    finalizeCalls.push({ featureId, outcome, reason });
  });
  wf.setPipelineSettledHook(() => {
    settledCalls++;
  });

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

async function insertFeature(slug: string, fid: string): Promise<void> {
  const now = Date.now();
  await db.adminSql`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, title, summary, status, attempts, item_kind,
       payload, needs_human_review, workspace_id, feature_order, ts, created_ts, updated_ts)
    VALUES
      (${slug}, ${fid}, ${`Pathological feature ${fid}`}, null, 'todo', 0, 'feature',
       null, false, ${WS}, 1, ${now}, ${now}, ${now})`;
}

describe('hive loop runaway guard (P-004)', () => {
  it('a never-terminating pipeline is cut off at maxTurns — completed, unfinalized, feature re-pickable as a fresh epoch', async () => {
    await insertFeature(SLUG_RUN, F_RUN);

    const tick = await runWithWorkspace(WS, () => dispatchOneHarness(SLUG_RUN, WS));
    expect(tick.started).toEqual([F_RUN]);

    // The workflow COMPLETES (the guard) — it does not hang or error.
    const res = await DBOS.getResult<string>(`pipeline:${SLUG_RUN}:${F_RUN}:e0`, 60);
    expect(res).toMatch(/^pipeline-complete \(last=(WORKER|VALIDATOR)\)$/);

    // Exactly maxTurns decide+dispatch pairs — the ceiling, not one more.
    const runCalls = runnerCalls.filter((c) => c.feature === F_RUN);
    expect(runCalls.length).toBe(MAX_TURNS * 2);
    expect(runCalls.filter((c) => c.role === 'director').length).toBe(MAX_TURNS);

    // No terminal: no finalize, no refill.
    expect(finalizeCalls).toEqual([]);
    expect(settledCalls).toBe(0);

    // The feature is still NEEDS_WORK in real PG state…
    const [row] = await db.adminSql`
      SELECT status FROM harness_shared.work_items
       WHERE harness_slug = ${SLUG_RUN} AND feature_id = ${F_RUN}`;
    expect(row.status).toBe('todo');

    // …and the next sweep starts a FRESH EPOCH (e1) — completed e0 is never
    // resurrected, the work is not stranded.
    const tick2 = await runWithWorkspace(WS, () => dispatchOneHarness(SLUG_RUN, WS));
    expect(tick2.started).toEqual([F_RUN]);
    const wfs = await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${SLUG_RUN}:${F_RUN}:e` });
    expect(wfs.map((w) => w.workflowID).sort()).toEqual([
      `pipeline:${SLUG_RUN}:${F_RUN}:e0`,
      `pipeline:${SLUG_RUN}:${F_RUN}:e1`,
    ]);
    // Let e1 run to ITS ceiling too (still bounded) so shutdown is clean.
    const res1 = await DBOS.getResult<string>(`pipeline:${SLUG_RUN}:${F_RUN}:e1`, 60);
    expect(res1).toMatch(/^pipeline-complete \(last=(WORKER|VALIDATOR)\)$/);
  }, 180_000);

  it('a director that ESCALATES after persistent rejection finalizes escalate exactly once, with no refill', async () => {
    await insertFeature(SLUG_ESC, F_ESC);
    settledCalls = 0;

    const tick = await runWithWorkspace(WS, () => dispatchOneHarness(SLUG_ESC, WS));
    expect(tick.started).toEqual([F_ESC]);

    const res = await DBOS.getResult<string>(`pipeline:${SLUG_ESC}:${F_ESC}:e0`, 60);
    expect(res).toBe('pipeline-complete (last=ESCALATE)');

    // The on-escalate hook (finalizer): exactly once, with the director's reason.
    expect(finalizeCalls).toEqual([
      { featureId: F_ESC, outcome: 'escalate', reason: 'validator-rejects-forever' },
    ]);
    // Escalate leaves the feature re-pickable — no immediate refill churn.
    expect(settledCalls).toBe(0);
    const [row] = await db.adminSql`
      SELECT status FROM harness_shared.work_items
       WHERE harness_slug = ${SLUG_ESC} AND feature_id = ${F_ESC}`;
    expect(row.status).toBe('todo');
  }, 120_000);
});
