/**
 * reconcileScheduledPlanRuns — settling a scheduled run's outcome/finished_at once its
 * work_items terminate, proven against a REAL migrated Postgres (testcontainer).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/harness/routines/reconcile-plan-runs.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (Phase 5 data; unblocks P-012/P-013).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import {
  reconcileScheduledPlanRuns,
  autoPauseOnFailureStreak,
  reconcileAndGovern,
  PLAN_RUN_PROMOTION_GRACE_MS,
} from './reconcile-plan-runs';
import { PLAN_RUN_ORPHAN_FAIL_MS } from '../../agent-tools/plans/runs';

let org: OrgTestDb;
let sql: Sql;
const WS = 'ws-recon';
const HARNESS = 'plan-run-reconcile-fixture';
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

async function instancePlanRow(slug: string) {
  const rows = await sql<{ status: string; template_slug: string | null }[]>`
    SELECT status, template_slug
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  return rows[0];
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

  it('supersedes the active instance plan when its scheduled run settles', async () => {
    const id = await seedRun('p-instance');
    const instanceSlug = `p-instance@run-${id}`;
    await sql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, status, template_slug)
      VALUES (${WS}, ${HARNESS}, ${instanceSlug}, 'active', 'p-instance')`;
    await sql`
      UPDATE harness_shared.plan_runs
         SET workspace_id = ${WS}, instance_plan_slug = ${instanceSlug}
       WHERE id = ${id}`;
    await reconcileScheduledPlanRuns({ sql });

    expect(await instancePlanRow(instanceSlug)).toEqual({ status: 'superseded', template_slug: 'p-instance' });
    expect((await runRow(id)).status).toBe('done');
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

  /*
   * WI-10004731 — a fire that threw after its seed transaction left a run with
   * zero work-items whose instance still has OPEN items. That is "promotion
   * never completed", not a prose plan; it was being settled done/success, so
   * every refused plan-cleanup sweep fire (2026-09-07, 09-14, 10-01) read as a
   * healthy run.
   */
  describe('zero work-items on an instance with open items (WI-10004731)', () => {
    async function seedUnpromoted(slug: string, ageMs: number): Promise<number> {
      const id = await seedRun(slug);
      const instanceSlug = `${slug}@run-${id}`;
      await sql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, status, template_slug, items)
        VALUES (${WS}, ${HARNESS}, ${instanceSlug}, 'active', ${slug},
                ${JSON.stringify([{ id: 'P-001', status: 'todo' }, { id: 'P-002', status: 'done' }])}::text::jsonb)`;
      await sql`
        UPDATE harness_shared.plan_runs
           SET workspace_id = ${WS}, instance_plan_slug = ${instanceSlug}, launched_at = ${Date.now() - ageMs}
         WHERE id = ${id}`;
      return id;
    }

    it('settles it FAILED with a reason once the grace window has passed', async () => {
      const id = await seedUnpromoted('p-unpromoted', PLAN_RUN_PROMOTION_GRACE_MS + 60_000);
      const res = await reconcileScheduledPlanRuns({ sql });
      expect(res.settled).toEqual([expect.objectContaining({ runId: id, outcome: 'failed' })]);
      const row = await runRow(id);
      expect(row.status).toBe('failed');
      expect(row.outcome).toBe('failed');
      const [summary] = await sql<{ result_summary: string | null }[]>`
        SELECT result_summary FROM harness_shared.plan_runs WHERE id = ${id}`;
      expect(summary.result_summary).toMatch(/promotion never completed/);
    });

    it('leaves it running inside the grace window, so an in-flight promotion is never raced', async () => {
      const id = await seedUnpromoted('p-promoting', 5_000);
      const res = await reconcileScheduledPlanRuns({ sql });
      expect(res.reconciled).toBe(0);
      expect((await runRow(id)).status).toBe('running');
    });

    it('still settles success when every instance item is already terminal (nothing to promote)', async () => {
      const id = await seedRun('p-all-done');
      const instanceSlug = `p-all-done@run-${id}`;
      await sql`
        INSERT INTO harness_shared.harness_plans
          (workspace_id, harness_slug, plan_slug, status, template_slug, items)
        VALUES (${WS}, ${HARNESS}, ${instanceSlug}, 'active', 'p-all-done',
                ${JSON.stringify([{ id: 'P-001', status: 'done' }])}::text::jsonb)`;
      await sql`
        UPDATE harness_shared.plan_runs
           SET workspace_id = ${WS}, instance_plan_slug = ${instanceSlug}, launched_at = 0
         WHERE id = ${id}`;
      await reconcileScheduledPlanRuns({ sql });
      expect((await runRow(id)).outcome).toBe('success');
    });
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

/**
 * RECURRENCE GUARD — orphan reclamation must ride the TICK, not only the `plans:runs` read.
 *
 * The damage this prevents (measured 2026-08-16): `sweepPlanRuns` implements running→failed
 * for an orphaned run, but its only caller was the `plans:runs` UI read. An orphan therefore
 * survived until a human opened the Runs tab — and because `runScheduledPlanFire` refuses to
 * mint while ANY run of the template is `running` (concurrency='skip'), that one row silently
 * disabled the whole schedule. It happened to `blender-steward-heartbeat-2026-08-11`, the
 * recovery heartbeat for a dead Blender GOAL steward: nobody was around to execute the run,
 * so nobody was around to read the tab either, and the recovery stayed dead ~21h while the
 * routine kept ticking and minting nothing.
 *
 * These tests drive ONLY reconcileAndGovern (the tick path). If someone unwires the sweep
 * again, the first test fails instead of a schedule going quietly dark.
 */
describe('reconcileAndGovern — orphaned-run reclamation on the tick', () => {
  /** Age a run's updated_at so it is past the orphan threshold. */
  async function ageRun(id: number, byMs: number): Promise<void> {
    await sql`UPDATE harness_shared.plan_runs
                 SET updated_at = ${Date.now() - byMs}
               WHERE id = ${id}`;
  }

  it('reclaims a run stuck running past the threshold WITHOUT any plans:runs read', async () => {
    const id = await seedRun('p-orphan');
    // Non-terminal work_item: reconcile alone can never settle this run, which is exactly
    // the state an abandoned run is left in.
    await seedWi(id, 'todo');
    await ageRun(id, PLAN_RUN_ORPHAN_FAIL_MS + 60_000);

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.orphaned).toBe(1);
    expect((await runRow(id)).status).toBe('failed');
  });

  it('clears the concurrency=skip precondition, so the template can fire again', async () => {
    const id = await seedRun('p-wedged');
    await seedWi(id, 'todo');
    await ageRun(id, PLAN_RUN_ORPHAN_FAIL_MS + 60_000);

    await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    // This is the query runScheduledPlanFire uses to decide whether to skip the fire.
    const stillRunning = await sql<{ id: number }[]>`
      SELECT id FROM harness_shared.plan_runs
       WHERE harness_slug = ${HARNESS} AND plan_slug = 'p-wedged' AND status = 'running'`;
    expect(stillRunning).toHaveLength(0);
  });

  it('does NOT reclaim a fresh running run — a live run must survive the tick', async () => {
    const id = await seedRun('p-live');
    await seedWi(id, 'todo');
    // updated_at = now (seedRun), i.e. well inside the threshold.

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    expect(res.orphaned).toBe(0);
    expect((await runRow(id)).status).toBe('running');
  });

  it('prefers a real reconcile outcome over force-failing: terminal items settle as success', async () => {
    const id = await seedRun('p-finished');
    await seedWi(id, 'done');
    // Old enough that a sweep-first ordering would have force-failed it with a NULL outcome.
    await ageRun(id, PLAN_RUN_ORPHAN_FAIL_MS + 60_000);

    const res = await reconcileAndGovern({ sql, harnessSlug: HARNESS });

    const row = await runRow(id);
    expect(row.status).toBe('done');
    expect(row.outcome).toBe('success');
    expect(res.orphaned).toBe(0);
  });
});
