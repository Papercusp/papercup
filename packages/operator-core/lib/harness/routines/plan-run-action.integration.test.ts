/**
 * system:plan-run — one fire of a scheduled plan, proven end-to-end against a REAL
 * migrated Postgres (testcontainer): a template + its materialized routine → a run
 * (instance plan + plan_runs ledger row + run-scoped frontier work_items), replay-safe,
 * with distinct runs across fires.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/plan-run-action.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-007 sub-step 7c).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { hashPlanContent } from '@papercusp/plan-parser';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { materializePlanSchedule, planScheduleRoutineName } from './materialize-plan-schedule';
import { runScheduledPlanFire } from './plan-run-action';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));

// Canonical promotion deliberately routes through the shared stores rather than
// borrowing runScheduledPlanFire's transaction client. Point every production
// store seam at this file's throwaway DB so the suite exercises the real
// promoter/reader/work-item/DAG path without ever touching the developer DB.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
  };
});
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual,
    getFlag: async (flag: string) => (flag === 'papercusp-spec-triad-required' ? false : true),
  };
});
vi.mock('../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-registry')>('../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'ws-planrun' };
});
vi.mock('../../agent-tools/plans/plan-spec-quality-gate', () => ({
  evaluatePlanSpecQualityGate: vi.fn(async ({ planSlug }: { planSlug: string }) => ({
    satisfied: true,
    applicable: false,
    mode: 'report-only',
    planSlug,
    specSetHash: null,
    wouldBlock: ['no-first-class-spec-clauses'],
  })),
}));

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-planrun';
// WI-7311: 'papercup' is a RETIRED slug — migration 656's `harness_plans_canonicalize_slug`
// trigger unconditionally rewrites `harness_slug='papercup'` to 'papercusp' on INSERT
// (WHEN clause, workspace-independent), while the app-level `routineStorageSlug` read
// path is workspace/pot-scoped and fails open to the RAW slug in this isolated test
// fixture's fake workspace (which has no seeded pots). That mismatch — write-side
// trigger canonicalizes, read-side resolver doesn't — made every test in this file fail
// "template not found" even though the row genuinely exists (just under 'papercusp', not
// the 'papercup' the test asked for and later reads back). Any non-reserved slug avoids
// the trigger's WHEN clause entirely.
const HARNESS = 'plan-run-it-fixture';
const APP_HARNESS = 'email-plan-run-it-fixture';
const TEMPLATE = 'monitor-x';

const ITEMS = [
  { id: 'P-001', text: 'check campaign stats', status: 'todo' },
  { id: 'P-002', text: 'already handled', status: 'done' }, // skipped (done)
  { id: 'P-003', text: 'post the summary', status: 'todo', blockedBy: ['P-001'] },
];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HARNESS}, ${Buffer.from([0])}, 'kc-plan-run-it', 0),
           (${WS}, ${APP_HARNESS}, ${Buffer.from([1])}, 'kc-plan-run-app-it', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
});
afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE harness_slug IN (${HARNESS}, ${APP_HARNESS})`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug IN (${HARNESS}, ${APP_HARNESS}) AND workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug IN (${HARNESS}, ${APP_HARNESS}) AND workspace_id = ${WS}`;
  // Seed the TEMPLATE plan with a parsed items index.
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, items)
    VALUES (${WS}, ${HARNESS}, ${TEMPLATE}, 'Monitor X', 'active',
            ${'# Monitor X\n\n## Now\n**State:** recurring.\n**Next:** run.'},
            ${'hash-monitor-x-v1'}, ${JSON.stringify(ITEMS)}::text::jsonb)
  `;
  // Materialize its schedule → the plan-schedule routine (7b).
  await materializePlanSchedule({
    workspaceId: WS,
    harnessSlug: HARNESS,
    templateSlug: TEMPLATE,
    schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' },
    sql,
  });
});

/** Simulate the routinesTick claim stamping last_fired_at (the replay-stable run token). */
async function stampClaim(at: Date): Promise<void> {
  await sql`
    UPDATE harness_shared.routines
       SET last_fired_at = ${at.toISOString()}::timestamptz
     WHERE install_slug = ${HARNESS} AND name = ${planScheduleRoutineName(TEMPLATE)}
  `;
}

describe('runScheduledPlanFire (system:plan-run)', () => {
  it('mints a run: instance plan + plan_runs row + run-scoped work_items', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res).not.toBeNull();
    expect(res!.replayed).toBe(false);
    expect(res!.runSeq).toBe(0);
    expect(res!.minted).toBe(2); // P-001 + P-003 (P-002 is done → skipped)
    expect(res!.workItemIds).toHaveLength(2);
    expect(res!.actionableWorkItemIds).toHaveLength(1); // P-003 is blocked by P-001

    // Instance plan: a copy pinned to the template, hidden from the main list.
    const inst = await sql<Array<{ template_slug: string; run_seq: number; content: string }>>`
      SELECT template_slug, run_seq, content FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${res!.instanceSlug}`;
    expect(inst[0]).toBeTruthy();
    expect(inst[0].template_slug).toBe(TEMPLATE);
    expect(inst[0].run_seq).toBe(0);
    expect(inst[0].content).toContain('Monitor X');

    // plan_runs ledger row, keyed on the TEMPLATE slug.
    const run = await sql<
      Array<{ run_type: string; trigger: string; instance_plan_slug: string; status: string; workspace_id: string }>
    >`
      SELECT run_type, trigger, instance_plan_slug, status, workspace_id FROM harness_shared.plan_runs
       WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(run).toHaveLength(1);
    expect(run[0].run_type).toBe('scheduled');
    expect(run[0].trigger).toBe('scheduled');
    expect(run[0].instance_plan_slug).toBe(res!.instanceSlug);
    expect(run[0].status).toBe('running');
    // EI-1368: the fire MUST stamp workspace_id (was '' before), else the run is invisible to
    // the workspace-scoped listPlanRuns/getPlanRun reads (Runs/Agents tab + plans:runs/run-transcript).
    expect(run[0].workspace_id).toBe(WS);

    // Run-scoped frontier work_items: source_plan_slug = TEMPLATE, payload.plan_run = the run.
    const wis = await sql<
      Array<{ feature_id: string; source_plan_slug: string; status: string; payload: Record<string, unknown> }>
    >`
      SELECT feature_id, source_plan_slug, status, payload FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS} AND source_plan_slug = ${TEMPLATE}`;
    expect(wis).toHaveLength(2);
    expect(wis.map((wi) => wi.status).sort()).toEqual(['blocked', 'open']);
    for (const wi of wis) {
      expect(wi.source_plan_slug).toBe(TEMPLATE);
      expect((wi.payload as any).plan_run.runId).toBe(res!.runId);
      expect((wi.payload as any).plan_run.templateSlug).toBe(TEMPLATE);
      expect((wi.payload as any).plan_item.plan_slug).toBe(res!.instanceSlug);
    }
    const edges = await sql<Array<{ blocked_ref: string; blocker_ref: string }>>`
      SELECT blocked_ref, blocker_ref
        FROM harness_shared.work_item_deps
       WHERE dep_type = 'blocks'`;
    expect(edges).toHaveLength(1);
  });

  it('inherits schedule execution, promotes in the app harness, and dispatches only the actionable frontier', async () => {
    const execution = { appHarnessSlug: APP_HARNESS, agentName: 'email-agent' };
    await sql`
      UPDATE harness_shared.harness_plans
         SET schedule = ${JSON.stringify({ kind: 'rrule', rrule: 'FREQ=DAILY', execution })}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    await stampClaim(new Date('2026-06-16T10:00:00.000Z'));
    const dispatch = vi.fn(async (args: { workItemIds: readonly string[]; targetAgent: string }) => ({
      ok: true,
      target: {
        requested: args.targetAgent,
        ownerId: 'su-email-live',
        present: true,
        sessionState: 'parked',
        wakeable: true,
      },
      assignment: {
        ok: true,
        targetAgent: args.targetAgent,
        requested: [...args.workItemIds],
        actionable: [...args.workItemIds],
        assigned: [...args.workItemIds],
        retained: [],
        skipped: [],
        failed: [],
        executionWorkItemIds: [...args.workItemIds],
      },
      wake: {
        targets: ['su-email-live'],
        keys: ['coord:inbox-wake:su-email-live'],
        queued: 1,
        woken: 1,
        pickupConfirmed: false,
        staged: 0,
        stagedTargets: [],
        fanoutCapped: [],
        timedOutTargets: [],
      },
    }));

    const result = await runScheduledPlanFire(
      sql,
      { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE },
      { dispatch },
    );

    expect(result).toMatchObject({ execution, dispatch: { ok: true } });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemIds: result!.actionableWorkItemIds,
        targetAgent: 'email-agent',
        workspaceId: WS,
        harness: APP_HARNESS,
      }),
    );
    expect(result!.actionableWorkItemIds).toHaveLength(1);
    expect(result!.workItemIds).toHaveLength(2);

    const appRows = await sql<Array<{ harness: string; payload: Record<string, any> }>>`
      SELECT harness_slug AS harness, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS}
         AND payload -> 'plan_run' ->> 'runId' = ${String(result!.runId)}
       ORDER BY feature_id`;
    expect(appRows).toHaveLength(2);
    expect(appRows.every((row) => row.harness === APP_HARNESS)).toBe(true);
    expect(appRows.every((row) => row.payload.plan_run.execution.agentName === 'email-agent')).toBe(true);
    const ledger = await sql<Array<{ harness: string }>>`
      SELECT harness_slug AS harness FROM harness_shared.plan_runs
       WHERE workspace_id = ${WS} AND id = ${result!.runId}`;
    expect(ledger[0].harness).toBe(APP_HARNESS);
  });

  it('is replay-safe: re-firing the same claim is a no-op (no duplicate run)', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    const replay = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(first!.replayed).toBe(false);
    expect(replay!.replayed).toBe(true);
    expect(replay!.runId).toBe(first!.runId);
    expect(replay!.minted).toBe(0);
    expect(replay!.workItemIds).toEqual(first!.workItemIds);
    const runCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runCount[0].n).toBe(1);
  });

  it('rolls back a partial mint so a durable replay can heal the complete run', async () => {
    const runToken = '1780000000001';
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.fail_plan_run_insert_once()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected plan_runs failure';
      END
      $$;
      CREATE TRIGGER fail_plan_run_insert_once
      BEFORE INSERT ON harness_shared.plan_runs
      FOR EACH ROW EXECUTE FUNCTION harness_shared.fail_plan_run_insert_once();
    `);
    try {
      await expect(
        runScheduledPlanFire(sql, {
          installSlug: HARNESS,
          workspaceId: WS,
          templateSlug: TEMPLATE,
          trigger: 'event',
          runToken,
        }),
      ).rejects.toThrow(/injected plan_runs failure/);
    } finally {
      await sql.unsafe(`
        DROP TRIGGER IF EXISTS fail_plan_run_insert_once ON harness_shared.plan_runs;
        DROP FUNCTION IF EXISTS harness_shared.fail_plan_run_insert_once();
      `);
    }

    const instanceSlug = `${TEMPLATE}@run-${runToken}`;
    const partial = await sql<{ plans: number; runs: number; items: number }[]>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.harness_plans
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
            AND plan_slug = ${instanceSlug}) AS plans,
        (SELECT count(*)::int FROM harness_shared.plan_runs
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
            AND instance_plan_slug = ${instanceSlug}) AS runs,
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
            AND payload -> 'plan_run' ->> 'instancePlanSlug' = ${instanceSlug}) AS items`;
    expect(partial[0]).toEqual({ plans: 0, runs: 0, items: 0 });

    const replay = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: TEMPLATE,
      trigger: 'event',
      runToken,
    });
    expect(replay).toMatchObject({ instanceSlug, replayed: false, minted: 2 });
  });

  // EI-1386 — the overlap policy (D-014) was authored (set-schedule → routines.concurrency)
  // but nothing at fire time ever read it. beforeEach's default materialize omits
  // `concurrency`, which materializePlanSchedule defaults to 'skip'.
  it("concurrency='skip' (default): a fire is skipped while a prior run of the same template is still 'running' (EI-1386)", async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(first!.replayed).toBe(false);
    expect(first!.minted).toBeGreaterThan(0);

    // Second fire: a DIFFERENT claim token (so it is not just a replay no-op), while the
    // first run's plan_runs row is still 'running'.
    await stampClaim(new Date('2026-06-17T09:00:00.000Z'));
    const second = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(second!.skippedForConcurrency).toBe(true);
    expect(second!.minted).toBe(0);
    expect(second!.replayed).toBe(false); // a distinct outcome from replay, not conflated with it

    // Only ONE plan_runs row exists — the skip genuinely prevented a second mint, not just
    // a display-layer suppression.
    const runCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runCount[0].n).toBe(1);
  });

  it("concurrency='skip': once the prior run settles (status != 'running'), the next fire mints normally", async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${first!.runId}`;

    await stampClaim(new Date('2026-06-17T09:00:00.000Z'));
    const second = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(second!.skippedForConcurrency).toBeFalsy();
    expect(second!.minted).toBeGreaterThan(0);
    expect(second!.runSeq).toBe(1);
  });

  it("concurrency='queue': mints anyway even while a prior run is still 'running' (unchanged default DB-column behavior)", async () => {
    // Re-materialize this template with an EXPLICIT 'queue' policy (overrides beforeEach's
    // app-layer 'skip' default).
    await materializePlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      templateSlug: TEMPLATE,
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' },
      concurrency: 'queue',
      sql,
    });

    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(first!.minted).toBeGreaterThan(0);

    await stampClaim(new Date('2026-06-17T09:00:00.000Z'));
    const second = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(second!.skippedForConcurrency).toBeFalsy();
    expect(second!.minted).toBeGreaterThan(0);
    expect(second!.runSeq).toBe(1);

    const runCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runCount[0].n).toBe(2);
  });

  it('run-now (manual) mints a fresh run after a scheduled fire — never replay-no-ops (EI-1369)', async () => {
    // A scheduled fire stamps last_fired_at (the replay-stable token for the cadence path).
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const sched = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(sched!.replayed).toBe(false);
    expect(sched!.runSeq).toBe(0);
    // EI-1386: the default concurrency policy is 'skip', which now genuinely skips a fire
    // while a prior run is still 'running' — settle it first, matching what a real manual
    // run-now against a completed cadence fire would see (this test is about run-TOKEN
    // uniqueness, not concurrency policy, which has its own dedicated tests above).
    await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${sched!.runId}`;

    // A MANUAL run-now must NOT reuse last_fired_at's token (that would recompute sched's slug and
    // replay-no-op). It mints a fresh run instead — even though last_fired_at is still set.
    const m1 = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: TEMPLATE,
      trigger: 'manual',
    });
    expect(m1!.replayed).toBe(false);
    expect(m1!.instanceSlug).not.toBe(sched!.instanceSlug);
    expect(m1!.runSeq).toBe(1);
    await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${m1!.runId}`;

    // A SECOND manual run-now (potentially the same millisecond) still mints a distinct run —
    // the module-monotonic manual token guarantees uniqueness.
    const m2 = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: TEMPLATE,
      trigger: 'manual',
    });
    expect(m2!.replayed).toBe(false);
    expect(m2!.instanceSlug).not.toBe(m1!.instanceSlug);
    expect(m2!.runSeq).toBe(2);

    const runs = await sql<{ trigger: string }[]>`
      SELECT trigger FROM harness_shared.plan_runs
       WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE} ORDER BY id`;
    expect(runs.map((r) => r.trigger)).toEqual(['scheduled', 'manual', 'manual']);
  });

  it('mints DISTINCT runs across fires (run_seq increments, fresh work_items)', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const r0 = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    // EI-1386: settle r0 before the next fire — the default 'skip' policy now genuinely
    // skips while a prior run is 'running' (this test is about run-token/run_seq
    // mechanics across SETTLED fires, not concurrency policy, which has its own tests).
    await sql`UPDATE harness_shared.plan_runs SET status = 'done' WHERE id = ${r0!.runId}`;
    await stampClaim(new Date('2026-06-17T09:00:00.000Z')); // next day's fire
    const r1 = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });

    expect(r0!.runSeq).toBe(0);
    expect(r1!.runSeq).toBe(1);
    expect(r1!.instanceSlug).not.toBe(r0!.instanceSlug);

    const runs = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runs[0].n).toBe(2);
    // Each run's work_items are distinct (PR-<runId>-...), so audit trails never collide.
    const wiCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND source_plan_slug = ${TEMPLATE}`;
    expect(wiCount[0].n).toBe(4); // 2 open items × 2 runs
  });

  it('returns null for an unknown template', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runScheduledPlanFire(sql, {
      installSlug: HARNESS,
      workspaceId: WS,
      templateSlug: 'does-not-exist',
    });
    expect(res).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("template 'does-not-exist' not found"));
    warn.mockRestore();
  });

  it('mints schedule.executorKind (D-006: a non-default feature-family executor kind, e.g. chunk)', async () => {
    await sql`
      UPDATE harness_shared.harness_plans
         SET schedule = ${JSON.stringify({ kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z', executorKind: 'chunk' })}::text::jsonb
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res!.minted).toBe(2);
    const kinds = await sql<{ item_kind: string }[]>`
      SELECT DISTINCT item_kind FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND source_plan_slug = ${TEMPLATE}`;
    expect(kinds).toHaveLength(1);
    expect(kinds[0].item_kind).toBe('chunk');
  });

  it('defaults to feature item_kind when no executorKind is authored', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    const kinds = await sql<{ item_kind: string }[]>`
      SELECT DISTINCT item_kind FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND source_plan_slug = ${TEMPLATE}`;
    expect(kinds[0].item_kind).toBe('feature');
  });

  it("EI-19389216343173748: the instance's self-declared frontmatter `slug:` is rewritten to the INSTANCE slug, not left as the template's — and content_hash matches what is actually stored", async () => {
    // Re-seed the template with a REAL frontmatter block (the beforeEach fixture has none,
    // so it can't exercise this bug: setFrontmatterScalar is a no-op on frontmatter-less
    // content). This mirrors the shape every real plan actually has.
    const fmContent = `---\nslug: ${TEMPLATE}\nstatus: active\n---\n# Monitor X\n\n## Now\n**State:** recurring.`;
    await sql`
      UPDATE harness_shared.harness_plans
         SET content = ${fmContent}, content_hash = ${hashPlanContent(fmContent)}
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;

    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(res).not.toBeNull();

    const inst = await sql<Array<{ content: string; content_hash: string }>>`
      SELECT content, content_hash FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${res!.instanceSlug}`;
    expect(inst[0]).toBeTruthy();
    // The clone's self-declared slug is the INSTANCE's, not the template's — the exact
    // `slug_mismatch` condition plans/lint.ts flags when these disagree.
    expect(inst[0].content).toContain(`slug: ${res!.instanceSlug}`);
    expect(inst[0].content).not.toContain(`slug: ${TEMPLATE}\n`);
    // Every other frontmatter line survives untouched (surgical, not a full rewrite).
    expect(inst[0].content).toContain('status: active');
    expect(inst[0].content).toContain('**State:** recurring.');
    // content_hash reflects what is ACTUALLY stored (the rewritten content), not the
    // template's original hash — a stale hash would fail plans:set-content's
    // compare-and-swap the moment anyone tried to edit the run snapshot.
    expect(inst[0].content_hash).toBe(hashPlanContent(inst[0].content));
    expect(inst[0].content_hash).not.toBe(hashPlanContent(fmContent));
  });
});
