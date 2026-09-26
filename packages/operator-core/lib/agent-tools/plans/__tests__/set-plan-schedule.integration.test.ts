/**
 * setPlanSchedule — authoring a plan's operational schedule columns, proven against a
 * REAL migrated Postgres (testcontainer). Authoring does NOT arm (schedule_active stays
 * false — arming is the autonomy-gated flow, Phase 3).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/set-plan-schedule.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-014).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import { setPlanSchedule } from '../source';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-setsched';
// The OPERATOR-HOME slug, so resolvePlanScope's home short-circuit applies (no
// hive registration needed in this throwaway DB). The old literal 'papercup' is
// a RETIRED alias: canonicalHarnessSlug collapses it to the home slug, so the
// tool wrote under 'papercusp' while the fixture seeded 'papercup' → 0-row
// UPDATEs and silent `false` returns (WI-1992).
const HARNESS = operatorHomeHarnessSlug();
const SLUG = 'monitor-y';

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});

beforeEach(async () => {
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash)
    VALUES (${WS}, ${HARNESS}, ${SLUG}, 'Monitor Y', 'active', ${'# Monitor Y'}, ${'h1'})
  `;
});

async function row() {
  const rows = await sql<
    Array<{
      schedule: Record<string, unknown> | null;
      scheduled_at: Date | null;
      expires_at: Date | null;
      tzid: string | null;
      schedule_active: boolean;
    }>
  >`
    SELECT schedule, scheduled_at, expires_at, tzid, schedule_active
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
  return rows[0];
}

describe('setPlanSchedule', () => {
  it('writes the schedule columns and does NOT arm (schedule_active stays false)', async () => {
    const ok = await setPlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      slug: SLUG,
      schedule: { kind: 'rrule', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00.000Z', concurrency: 'skip' },
      expiresAt: '2026-12-01T00:00:00.000Z',
      tzid: 'America/New_York',
      sql,
    });
    expect(ok).toBe(true);

    const r = await row();
    expect((r.schedule as any).rrule).toBe('FREQ=DAILY');
    expect((r.schedule as any).concurrency).toBe('skip');
    expect(r.tzid).toBe('America/New_York');
    expect(r.expires_at).not.toBeNull();
    expect(r.schedule_active).toBe(false); // authored, not armed (D-010)
  });

  it('round-trips the registered operation reference and literal input', async () => {
    const operation = { harnessSlug: HARNESS, operationId: 'daily-triage', input: { queue: 'support' } };
    expect(await setPlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      slug: SLUG,
      schedule: { kind: 'cron', cron: '0 9 * * *', operation },
      sql,
    })).toBe(true);
    expect((await row()).schedule).toMatchObject({ kind: 'cron', cron: '0 9 * * *', operation });
  });

  it('clears the schedule when passed schedule: null (un-schedule)', async () => {
    await setPlanSchedule({ workspaceId: WS, harnessSlug: HARNESS, slug: SLUG, schedule: { kind: 'cron', cron: '0 9 * * *' }, sql });
    expect((await row()).schedule).not.toBeNull();
    await setPlanSchedule({ workspaceId: WS, harnessSlug: HARNESS, slug: SLUG, schedule: null, sql });
    expect((await row()).schedule).toBeNull();
  });

  it('returns false for an unknown plan', async () => {
    const ok = await setPlanSchedule({
      workspaceId: WS,
      harnessSlug: HARNESS,
      slug: 'no-such-plan',
      schedule: { kind: 'cron', cron: '0 9 * * *' },
      sql,
    });
    expect(ok).toBe(false);
  });
});
