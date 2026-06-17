/**
 * Enriched plans:runs data layer (P-022/P-023): per-run outcome/duration/work-item
 * rollup/cost from listPlanRuns (against a real migrated Postgres), and the pure
 * computePlanRunRollup aggregate.
 *
 * Run: npx vitest run --config vitest.integration.config.ts \
 *        lib/agent-tools/plans/__tests__/run-enrichment.integration.test.ts
 *
 * Plan: scheduled-recurring-plans-2026-06-16 (P-022 / P-023).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../../test/_org-test-db';

let org: OrgTestDb;

// runs.ts routes its reads through withWorkspace — point it at the admin test client.
vi.mock('@papercusp/db-org', () => ({
  withWorkspace: (_ws: string, cb: (tx: unknown) => unknown) => cb(org.adminSql),
}));

// Import AFTER the mock is declared (vi.mock is hoisted).
const { listPlanRuns, computePlanRunRollup } = await import('../runs');
type PlanRunSummary = Awaited<ReturnType<typeof listPlanRuns>>[number];

const HARNESS = 'papercup';
const TEMPLATE = 'tmpl-runs';

beforeAll(async () => {
  org = await createOrgTestDb();
});
afterAll(async () => {
  await org?.cleanup();
});
beforeEach(async () => {
  await org.adminSql`DELETE FROM harness_shared.plan_runs WHERE harness_slug = ${HARNESS}`;
  await org.adminSql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS}`;
});

async function seedRun(opts: { outcome: 'success' | 'partial' | 'failed'; launchedAt: number; durationMs: number }): Promise<number> {
  const sql = org.adminSql;
  const rows = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.plan_runs
      (harness_slug, plan_slug, plan_content_hash, session_id, launched_by, launched_at,
       status, title, updated_at, run_type, trigger, run_seq, outcome, finished_at, instance_plan_slug)
    VALUES (${HARNESS}, ${TEMPLATE}, 'h', ${'s' + opts.launchedAt}, 'system:plan-run', ${opts.launchedAt},
            ${opts.outcome === 'failed' ? 'failed' : 'done'}, 'r', ${opts.launchedAt}, 'scheduled', 'scheduled', 0,
            ${opts.outcome}, ${opts.launchedAt + opts.durationMs}, ${TEMPLATE + '@run-' + opts.launchedAt})
    RETURNING id`;
  return Number(rows[0].id);
}
async function seedWi(runId: number, status: string): Promise<void> {
  const sql = org.adminSql;
  const now = Date.now();
  await sql.unsafe(
    `INSERT INTO harness_shared.harness_features_consolidated
       (harness_slug, feature_id, title, status, attempts, item_kind, payload, needs_human_review, workspace_id, ts, created_ts, updated_ts)
     VALUES ($1,$2,'wi',$3,0,'feature',$4::text::jsonb,FALSE,'ws-x',$5,$5,$5)`,
    [HARNESS, `PR-${runId}-${status}-${Math.random()}`, status, JSON.stringify({ plan_run: { runId } }), now],
  );
}

describe('listPlanRuns enrichment (P-022)', () => {
  it('returns outcome, duration, run_type/trigger, and a work-item rollup per run', async () => {
    const id = await seedRun({ outcome: 'partial', launchedAt: 1_780_000_000_000, durationMs: 5000 });
    await seedWi(id, 'passed');
    await seedWi(id, 'failed');
    await seedWi(id, 'todo'); // open

    const runs = await listPlanRuns(TEMPLATE, { harnessSlug: HARNESS });
    expect(runs).toHaveLength(1);
    const r = runs[0]!;
    expect(r.runType).toBe('scheduled');
    expect(r.trigger).toBe('scheduled');
    expect(r.outcome).toBe('partial');
    expect(r.durationMs).toBe(5000);
    expect(r.instancePlanSlug).toBe(`${TEMPLATE}@run-1780000000000`);
    expect(r.workItems).toEqual({ total: 3, passed: 1, failed: 1, open: 1 });
  });

  it('orders newest-first', async () => {
    await seedRun({ outcome: 'success', launchedAt: 1_780_000_000_000, durationMs: 1000 });
    await seedRun({ outcome: 'failed', launchedAt: 1_780_000_100_000, durationMs: 1000 });
    const runs = await listPlanRuns(TEMPLATE, { harnessSlug: HARNESS });
    expect(runs.map((r) => r.outcome)).toEqual(['failed', 'success']);
  });
});

describe('computePlanRunRollup (P-023, pure)', () => {
  const mk = (over: Partial<PlanRunSummary>): PlanRunSummary =>
    ({
      id: 1, planSlug: TEMPLATE, planContentHash: 'h', sessionId: 's', note: null,
      launchedBy: 'x', launchedAt: 0, status: 'done', title: null, updatedAt: 0,
      runType: 'scheduled', trigger: 'scheduled', outcome: 'success', finishedAt: 0,
      runSeq: 0, instancePlanSlug: null, durationMs: 100, turnCount: 0,
      workItems: { total: 0, passed: 0, failed: 0, open: 0 }, costUsd: 0,
      ...over,
    }) as PlanRunSummary;

  it('computes success rate over settled runs + duration stats + regression flags', () => {
    const runs = [
      mk({ id: 3, outcome: 'failed', status: 'failed', durationMs: 1000, costUsd: 0.5 }), // newest
      mk({ id: 2, outcome: 'success', durationMs: 100, costUsd: 0.2 }),
      mk({ id: 1, outcome: 'success', durationMs: 100, costUsd: 0.3 }),
    ];
    const r = computePlanRunRollup(runs);
    expect(r.total).toBe(3);
    expect(r.success).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.successRate).toBeCloseTo(2 / 3);
    expect(r.medianDurationMs).toBe(100); // sorted [100,100,1000], middle element = 100
    expect(r.totalCostUsd).toBeCloseTo(1.0);
    expect(r.lastOutcome).toBe('failed');
    expect(r.regression.lastFailed).toBe(true);
  });

  it('successRate is 0 when nothing has settled', () => {
    const r = computePlanRunRollup([mk({ outcome: null, status: 'running', durationMs: null })]);
    expect(r.running).toBe(1);
    expect(r.successRate).toBe(0);
    expect(r.medianDurationMs).toBeNull();
  });
});
