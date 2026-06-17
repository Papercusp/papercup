/**
 * Retention/GC for scheduled plan runs (P-027, D-015), proven against a real migrated
 * Postgres: keep the plan_runs ledger; sweep instance plans + transcripts + work_items
 * past the last-N / older-than-T bound.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/gc-plan-runs.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { gcScheduledPlanRuns } from './gc-plan-runs';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-gc';
const HARNESS = 'papercup';
const TEMPLATE = 'gc-tmpl';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
  // plan_run_turns FK to plan_runs(id); the plan_runs delete above cascades? No FK cascade — clear explicitly.
  await sql`DELETE FROM harness_shared.plan_run_turns WHERE plan_run_id IN (
    SELECT id FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS})`;
});

async function seedFullRun(launchedAt: number): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.plan_runs
      (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, run_seq)
    VALUES (${HARNESS}, ${TEMPLATE}, 'h', ${'s' + launchedAt}, 'system:plan-run', ${launchedAt},
            'done', 'r', ${launchedAt}, 'scheduled', 'scheduled', 0)
    RETURNING id`;
  const id = Number(rows[0].id);
  const inst = `${TEMPLATE}@run-${id}`;
  await sql`UPDATE harness_shared.plan_runs SET instance_plan_slug = ${inst} WHERE id = ${id}`;
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, template_slug, run_seq)
    VALUES (${WS}, ${HARNESS}, ${inst}, 'i', 'active', '#i', 'h', ${TEMPLATE}, 0)`;
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_features_consolidated
       (harness_slug, feature_id, title, status, attempts, item_kind, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts)
     VALUES ($1,$2,'wi','passed',0,'feature',$3::text::jsonb,FALSE,$4,$5,$5,$5)`,
    [HARNESS, `PR-${id}-1`, JSON.stringify({ plan_run: { runId: id } }), WS, launchedAt],
  );
  await sql`INSERT INTO harness_shared.plan_run_turns (plan_run_id, seq, role, content, created_at)
            VALUES (${id}, 0, 'assistant', 'hi', ${launchedAt})`;
  return id;
}

async function counts(id: number, instSlug: string) {
  const [run, plan, wi, turn] = await Promise.all([
    sql<{ n: number }[]>`SELECT count(*)::int n FROM harness_shared.plan_runs WHERE id = ${id}`,
    sql<{ n: number }[]>`SELECT count(*)::int n FROM harness_shared.harness_plans WHERE plan_slug = ${instSlug}`,
    sql<{ n: number }[]>`SELECT count(*)::int n FROM harness_shared.harness_features_consolidated WHERE payload->'plan_run'->>'runId' = ${String(id)}`,
    sql<{ n: number }[]>`SELECT count(*)::int n FROM harness_shared.plan_run_turns WHERE plan_run_id = ${id}`,
  ]);
  return { run: run[0].n, plan: plan[0].n, wi: wi[0].n, turn: turn[0].n };
}

describe('gcScheduledPlanRuns (P-027 retention)', () => {
  const T = 1_780_000_000_000;
  it('keeps the last N runs, GCs older runs’ artifacts, keeps all ledger rows', async () => {
    const ids = [await seedFullRun(T + 1), await seedFullRun(T + 2), await seedFullRun(T + 3), await seedFullRun(T + 4)];
    const res = await gcScheduledPlanRuns({ sql, keepLastN: 2, maxAgeDays: 36500, now: T + 10 });
    expect(res.gcRuns).toBe(2); // the 2 oldest
    expect(res.instancePlans).toBe(2);
    expect(res.workItems).toBe(2);
    expect(res.transcriptTurns).toBe(2);

    // Oldest two: artifacts gone, ledger row KEPT.
    for (const id of [ids[0]!, ids[1]!]) {
      const c = await counts(id, `${TEMPLATE}@run-${id}`);
      expect(c).toEqual({ run: 1, plan: 0, wi: 0, turn: 0 });
    }
    // Newest two: everything kept.
    for (const id of [ids[2]!, ids[3]!]) {
      const c = await counts(id, `${TEMPLATE}@run-${id}`);
      expect(c).toEqual({ run: 1, plan: 1, wi: 1, turn: 1 });
    }
  });

  it('GCs a run older than maxAgeDays even within last-N', async () => {
    const oldId = await seedFullRun(T - 100 * 86_400_000); // 100 days before T
    const res = await gcScheduledPlanRuns({ sql, keepLastN: 50, maxAgeDays: 90, now: T });
    expect(res.gcRuns).toBe(1);
    expect((await counts(oldId, `${TEMPLATE}@run-${oldId}`)).plan).toBe(0);
  });

  it('is idempotent — a second pass GCs nothing new', async () => {
    await seedFullRun(T + 1);
    await seedFullRun(T + 2);
    await seedFullRun(T + 3);
    await gcScheduledPlanRuns({ sql, keepLastN: 1, maxAgeDays: 36500, now: T + 10 });
    const second = await gcScheduledPlanRuns({ sql, keepLastN: 1, maxAgeDays: 36500, now: T + 10 });
    expect(second.instancePlans).toBe(0);
    expect(second.workItems).toBe(0);
    expect(second.transcriptTurns).toBe(0);
  });
});
