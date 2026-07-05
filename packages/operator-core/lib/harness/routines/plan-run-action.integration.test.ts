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
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { materializePlanSchedule, planScheduleRoutineName } from './materialize-plan-schedule';
import { runScheduledPlanFire } from './plan-run-action';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-planrun';
const HARNESS = 'papercup';
const TEMPLATE = 'monitor-x';

const ITEMS = [
  { id: 'P-001', text: 'check campaign stats', status: 'todo' },
  { id: 'P-002', text: 'already handled', status: 'done' }, // skipped (done)
  { id: 'P-003', text: 'post the summary', status: 'todo' },
];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines`;
  await sql`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
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
    const wis = await sql<Array<{ feature_id: string; source_plan_slug: string; status: string; payload: Record<string, unknown> }>>`
      SELECT feature_id, source_plan_slug, status, payload FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS} AND source_plan_slug = ${TEMPLATE}`;
    expect(wis).toHaveLength(2);
    for (const wi of wis) {
      expect(wi.status).toBe('todo');
      expect(wi.source_plan_slug).toBe(TEMPLATE);
      expect((wi.payload as any).plan_run.runId).toBe(res!.runId);
      expect((wi.payload as any).plan_run.templateSlug).toBe(TEMPLATE);
    }
  });

  it('is replay-safe: re-firing the same claim is a no-op (no duplicate run)', async () => {
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const first = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    const replay = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(first!.replayed).toBe(false);
    expect(replay!.replayed).toBe(true);
    const runCount = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS} AND plan_slug = ${TEMPLATE}`;
    expect(runCount[0].n).toBe(1);
  });

  it('run-now (manual) mints a fresh run after a scheduled fire — never replay-no-ops (EI-1369)', async () => {
    // A scheduled fire stamps last_fired_at (the replay-stable token for the cadence path).
    await stampClaim(new Date('2026-06-16T09:00:00.000Z'));
    const sched = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE });
    expect(sched!.replayed).toBe(false);
    expect(sched!.runSeq).toBe(0);

    // A MANUAL run-now must NOT reuse last_fired_at's token (that would recompute sched's slug and
    // replay-no-op). It mints a fresh run instead — even though last_fired_at is still set.
    const m1 = await runScheduledPlanFire(sql, {
      installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE, trigger: 'manual',
    });
    expect(m1!.replayed).toBe(false);
    expect(m1!.instanceSlug).not.toBe(sched!.instanceSlug);
    expect(m1!.runSeq).toBe(1);

    // A SECOND manual run-now (potentially the same millisecond) still mints a distinct run —
    // the module-monotonic manual token guarantees uniqueness.
    const m2 = await runScheduledPlanFire(sql, {
      installSlug: HARNESS, workspaceId: WS, templateSlug: TEMPLATE, trigger: 'manual',
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
    const res = await runScheduledPlanFire(sql, { installSlug: HARNESS, workspaceId: WS, templateSlug: 'does-not-exist' });
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
});
