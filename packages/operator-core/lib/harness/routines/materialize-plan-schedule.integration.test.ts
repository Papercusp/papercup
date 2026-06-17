/**
 * materialize-plan-schedule — a scheduled plan's authored schedule projected onto a
 * harness_shared.routines row, proven against a REAL migrated Postgres (testcontainer).
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/materialize-plan-schedule.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-007 sub-step 7b).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import {
  materializePlanSchedule,
  deactivatePlanSchedule,
  planScheduleRoutineName,
  PLAN_RUN_ACTION,
} from './materialize-plan-schedule';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-sched';
const HARNESS = 'papercup';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql; // RLS-bypass; the materializer takes sql as a seam
});

afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.routines`;
});

async function routineRow(templateSlug: string) {
  const rows = await sql<
    Array<{
      target_role: string;
      trigger_config: Record<string, unknown>;
      payload_template: Record<string, unknown> | null;
      next_fire_at: Date | null;
      active: boolean;
      concurrency: string;
      trigger_kind: string;
    }>
  >`
    SELECT target_role, trigger_config, payload_template, next_fire_at, active, concurrency, trigger_kind
      FROM harness_shared.routines
     WHERE install_slug = ${HARNESS} AND name = ${planScheduleRoutineName(templateSlug)}
  `;
  return rows[0] ?? null;
}

describe('materializePlanSchedule', () => {
  it('projects an RRULE schedule onto a system:plan-run routine with a future next_fire_at', async () => {
    const template = 'monitor-campaigns';
    const res = await materializePlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      templateSlug: template,
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z' },
      sql,
    });
    expect(res.nextFireAt).toBeInstanceOf(Date);
    expect(res.nextFireAt!.getTime()).toBeGreaterThan(Date.now());

    const row = await routineRow(template);
    expect(row).not.toBeNull();
    expect(row!.target_role).toBe(PLAN_RUN_ACTION);
    expect(row!.trigger_kind).toBe('cron'); // next_fire_at-driven; scanned by listDueCronRoutines
    expect(row!.trigger_config.rrule).toBe('FREQ=DAILY');
    expect(row!.payload_template).toMatchObject({ templateSlug: template, harnessSlug: HARNESS });
    expect(row!.active).toBe(true);
    expect(row!.concurrency).toBe('skip'); // D-014 default
    expect(row!.next_fire_at).not.toBeNull();
  });

  it('projects a cron schedule, computing next_fire_at', async () => {
    const template = 'daily-report';
    await materializePlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      templateSlug: template,
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      concurrency: 'queue',
      sql,
    });
    const row = await routineRow(template);
    expect(row!.trigger_config.cron).toBe('0 9 * * *');
    expect(row!.concurrency).toBe('queue');
    expect(row!.next_fire_at).not.toBeNull();
  });

  it('expresses a one-shot (scheduled_at, no recurrence) as next_fire_at + empty trigger_config', async () => {
    const template = 'one-shot-plan';
    const when = new Date(Date.now() + 60 * 60 * 1000);
    await materializePlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      templateSlug: template,
      scheduledAt: when,
      sql,
    });
    const row = await routineRow(template);
    expect(row!.trigger_config).toEqual({}); // no cron/rrule ⇒ claim.ts one-shot path
    expect(new Date(row!.next_fire_at!).getTime()).toBe(when.getTime());
  });

  it('is idempotent on (install_slug, name) — re-arm upserts the one row', async () => {
    const template = 'recurring-plan';
    const sched = { kind: 'rrule' as const, rrule: 'FREQ=WEEKLY;INTERVAL=2', dtstart: '2026-01-06T09:00:00.000Z' };
    await materializePlanSchedule({ workspaceId: WS, harnessSlug: HARNESS, templateSlug: template, schedule: sched, sql });
    await materializePlanSchedule({ workspaceId: WS, harnessSlug: HARNESS, templateSlug: template, schedule: sched, sql });
    const count = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.routines
       WHERE install_slug = ${HARNESS} AND name = ${planScheduleRoutineName(template)}`;
    expect(count[0].n).toBe(1);
  });

  it('deactivatePlanSchedule disarms the routine', async () => {
    const template = 'pausable-plan';
    await materializePlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      templateSlug: template,
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      sql,
    });
    const ok = await deactivatePlanSchedule(HARNESS, template, { sql });
    expect(ok).toBe(true);
    const row = await routineRow(template);
    expect(row!.active).toBe(false);
  });
});
