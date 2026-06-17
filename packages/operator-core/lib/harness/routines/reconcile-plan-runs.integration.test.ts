/**
 * reconcileScheduledPlanRuns — settling a scheduled run's outcome/finished_at once its
 * work_items terminate, proven against a REAL migrated Postgres (testcontainer).
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/reconcile-plan-runs.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (Phase 5 data; unblocks P-012/P-013).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { reconcileScheduledPlanRuns, autoPauseOnFailureStreak } from './reconcile-plan-runs';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-recon';
const HARNESS = 'papercup';
let wiSeq = 0;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`;
  await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.harness_plans WHERE harness_slug = ${HARNESS} AND workspace_id = ${WS}`;
});

/** Seed a running scheduled plan_run; returns its id. */
async function seedRun(planSlug: string): Promise<number> {
  const now = Date.now();
  const rows = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.plan_runs
      (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, run_seq)
    VALUES (${HARNESS}, ${planSlug}, 'h', ${'sched:' + planSlug + now}, 'system:plan-run', ${now},
            'running', 'r', ${now}, 'scheduled', 'scheduled', 0)
    RETURNING id`;
  return Number(rows[0].id);
}

/** Seed a work_item for a run with the given status. */
async function seedWi(runId: number, status: string): Promise<void> {
  const now = Date.now();
  const fid = `PR-${runId}-${++wiSeq}`;
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_features_consolidated
       (harness_slug, feature_id, title, status, attempts, item_kind, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts, source_plan_slug)
     VALUES ($1,$2,$3,$4,0,'feature',$5::text::jsonb,FALSE,$6,$7,$7,$7,$8)`,
    [HARNESS, fid, 'wi', status, JSON.stringify({ plan_run: { runId } }), WS, now, 'tmpl'],
  );
}

async function runRow(id: number) {
  const r = await sql<{ status: string; outcome: string | null; finished_at: number | null }[]>`
    SELECT status, outcome, finished_at FROM harness_shared.plan_runs WHERE id = ${id}`;
  return r[0];
}

describe('reconcileScheduledPlanRuns', () => {
  it('leaves a run running while any work_item is non-terminal', async () => {
    const id = await seedRun('p-running');
    await seedWi(id, 'todo');
    await seedWi(id, 'passed');
    const res = await reconcileScheduledPlanRuns({ sql });
    expect(res.reconciled).toBe(0);
    expect((await runRow(id)).status).toBe('running');
  });

  it('settles success when all work_items passed', async () => {
    const id = await seedRun('p-success');
    await seedWi(id, 'passed');
    await seedWi(id, 'done');
    const res = await reconcileScheduledPlanRuns({ sql });
    expect(res.reconciled).toBe(1);
    const row = await runRow(id);
    expect(row.status).toBe('done');
    expect(row.outcome).toBe('success');
    expect(row.finished_at).not.toBeNull();
  });

  it('settles partial when some passed and some failed', async () => {
    const id = await seedRun('p-partial');
    await seedWi(id, 'passed');
    await seedWi(id, 'failed');
    await reconcileScheduledPlanRuns({ sql });
    expect((await runRow(id)).outcome).toBe('partial');
  });

  it('settles failed (status=failed) when all failed', async () => {
    const id = await seedRun('p-failed');
    await seedWi(id, 'failed');
    await seedWi(id, 'dropped');
    await reconcileScheduledPlanRuns({ sql });
    const row = await runRow(id);
    expect(row.outcome).toBe('failed');
    expect(row.status).toBe('failed');
  });

  it('settles a no-work (prose) run as success immediately', async () => {
    const id = await seedRun('p-nowork');
    const res = await reconcileScheduledPlanRuns({ sql });
    expect(res.reconciled).toBe(1);
    expect((await runRow(id)).outcome).toBe('success');
  });
});

/** Seed an ARMED template (schedule_active=true). */
async function seedArmedTemplate(planSlug: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, schedule, schedule_active)
    VALUES (${WS}, ${HARNESS}, ${planSlug}, 'T', 'active', '#T', 'h',
            ${JSON.stringify({ kind: 'cron', cron: '0 9 * * *' })}::text::jsonb, true)`;
}
/** Seed a settled scheduled run with an outcome at an explicit launched_at (ordering). */
async function seedSettledRun(planSlug: string, outcome: 'success' | 'partial' | 'failed', at: number): Promise<void> {
  await sql`
    INSERT INTO harness_shared.plan_runs
      (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, run_seq, outcome, finished_at)
    VALUES (${HARNESS}, ${planSlug}, 'h', ${'s-' + planSlug + '-' + at}, 'system:plan-run', ${at},
            ${outcome === 'failed' ? 'failed' : 'done'}, 'r', ${at}, 'scheduled', 'scheduled', 0, ${outcome}, ${at})`;
}
async function templateArmed(planSlug: string): Promise<boolean> {
  const r = await sql<{ schedule_active: boolean }[]>`
    SELECT schedule_active FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${planSlug}`;
  return r[0]?.schedule_active ?? false;
}

describe('autoPauseOnFailureStreak (P-012, D-011)', () => {
  const T0 = 1_780_000_000_000;
  it('disarms after K consecutive failed runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seedArmedTemplate('p-streak');
    await seedSettledRun('p-streak', 'failed', T0 + 1);
    await seedSettledRun('p-streak', 'failed', T0 + 2);
    await seedSettledRun('p-streak', 'failed', T0 + 3);
    const r = await autoPauseOnFailureStreak({ sql, harnessSlug: HARNESS, planSlug: 'p-streak', k: 3 });
    expect(r.paused).toBe(true);
    expect(await templateArmed('p-streak')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-paused'));
    warn.mockRestore();
  });

  it('does NOT disarm with fewer than K failures', async () => {
    await seedArmedTemplate('p-two');
    await seedSettledRun('p-two', 'failed', T0 + 1);
    await seedSettledRun('p-two', 'failed', T0 + 2);
    const r = await autoPauseOnFailureStreak({ sql, harnessSlug: HARNESS, planSlug: 'p-two', k: 3 });
    expect(r.paused).toBe(false);
    expect(await templateArmed('p-two')).toBe(true);
  });

  it('does NOT disarm when the streak is broken by a recent success', async () => {
    await seedArmedTemplate('p-broken');
    await seedSettledRun('p-broken', 'failed', T0 + 1);
    await seedSettledRun('p-broken', 'failed', T0 + 2);
    await seedSettledRun('p-broken', 'success', T0 + 3); // most recent succeeded
    const r = await autoPauseOnFailureStreak({ sql, harnessSlug: HARNESS, planSlug: 'p-broken', k: 3 });
    expect(r.paused).toBe(false);
    expect(await templateArmed('p-broken')).toBe(true);
  });

  it('is a no-op on an already-disarmed template', async () => {
    // no seedArmedTemplate → schedule_active defaults false (and no row)
    const r = await autoPauseOnFailureStreak({ sql, harnessSlug: HARNESS, planSlug: 'p-absent', k: 3 });
    expect(r.paused).toBe(false);
  });
});
