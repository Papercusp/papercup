/**
 * arm/disarm a scheduled plan, proven against a REAL migrated Postgres (testcontainer):
 * arming sets schedule_active + materializes the routine; disarming clears + deactivates.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/arm-plan-schedule.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-016/P-017).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { armPlanSchedule, disarmPlanSchedule } from './arm-plan-schedule';
import { planScheduleRoutineName } from './materialize-plan-schedule';
import { claimDueRoutine } from './claim';
import { listDueCronRoutines } from '@papercusp/db-org';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-arm';
const HARNESS = 'papercup';
const SLUG = 'monitor-z';
const SCHED = { kind: 'rrule' as const, rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z', concurrency: 'skip' as const };

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, schedule)
    VALUES (${WS}, ${HARNESS}, ${SLUG}, 'Monitor Z', 'active', ${'# Monitor Z'}, ${'h'}, ${JSON.stringify(SCHED)}::text::jsonb)
  `;
});

async function planActive(): Promise<boolean> {
  const r = await sql<{ schedule_active: boolean }[]>`
    SELECT schedule_active FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  return r[0]?.schedule_active ?? false;
}
async function routineActive(): Promise<{ exists: boolean; active: boolean; target: string | null }> {
  const r = await sql<{ active: boolean; target_role: string }[]>`
    SELECT active, target_role FROM harness_shared.routines
     WHERE install_slug = ${HARNESS} AND name = ${planScheduleRoutineName(SLUG)}`;
  return { exists: r.length > 0, active: r[0]?.active ?? false, target: r[0]?.target_role ?? null };
}

describe('armPlanSchedule / disarmPlanSchedule', () => {
  it('arming sets schedule_active=true and materializes a system:plan-run routine', async () => {
    const res = await armPlanSchedule({ sql, workspaceId: WS, harnessSlug: HARNESS, templateSlug: SLUG, schedule: SCHED });
    expect(res.ok).toBe(true);
    expect(await planActive()).toBe(true);
    const rt = await routineActive();
    expect(rt.exists).toBe(true);
    expect(rt.active).toBe(true);
    expect(rt.target).toBe('system:plan-run');
  });

  it('disarming sets schedule_active=false and deactivates the routine', async () => {
    await armPlanSchedule({ sql, workspaceId: WS, harnessSlug: HARNESS, templateSlug: SLUG, schedule: SCHED });
    const res = await disarmPlanSchedule({ sql, workspaceId: WS, harnessSlug: HARNESS, templateSlug: SLUG });
    expect(res.ok).toBe(true);
    expect(await planActive()).toBe(false);
    expect((await routineActive()).active).toBe(false);
  });

  it('refuses to arm a plan with neither a recurrence nor a one-shot time', async () => {
    const res = await armPlanSchedule({ sql, workspaceId: WS, harnessSlug: HARNESS, templateSlug: SLUG });
    expect(res).toEqual({ ok: false, reason: 'not_scheduled' });
    expect(await planActive()).toBe(false); // unchanged
  });

  it('a fired one-shot un-arms its owning plan (EI-1371): claim deactivates the routine AND the plan', async () => {
    // Make the fixture a one-shot: drop the recurrence, set a DUE scheduled_at.
    const fireAt = new Date(Date.now() - 1000);
    await sql`
      UPDATE harness_shared.harness_plans
         SET schedule = NULL, scheduled_at = ${fireAt.toISOString()}::timestamptz
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    const res = await armPlanSchedule({ sql, workspaceId: WS, harnessSlug: HARNESS, templateSlug: SLUG, scheduledAt: fireAt });
    expect(res.ok).toBe(true);
    expect(await planActive()).toBe(true);
    expect((await routineActive()).active).toBe(true);

    // The tick claims the due one-shot → deactivates the routine AND un-arms the plan (mirror disarm).
    const mine = (await listDueCronRoutines(sql)).find((r) => r.name === planScheduleRoutineName(SLUG));
    expect(mine).toBeTruthy();
    expect(await claimDueRoutine(sql, mine!)).toBe(true);

    expect((await routineActive()).active).toBe(false); // one-shot deactivated (pre-existing behavior)
    expect(await planActive()).toBe(false); // EI-1371: previously stayed true → UI showed "armed"
  });
});
