/**
 * hive-canary-action.integration.test.ts — plan hive-loop-e2e-testing-2026-06-10
 * P-009: the daily canary action against a real migrated PG.
 *
 *   - SELF-GATE: an unregistered canary harness → clean no-op (no rows, no throw).
 *   - QUEUE: a registered harness gets today's F-CANARY-<YYYYMMDD> (payload.canary),
 *     idempotent across a same-day re-fire (replay-safety of the durable step).
 *   - CHECK: an overdue, non-terminal canary files ONE forensics-laden
 *     improvement (DBOS pipeline rows + nursery + fire-state in the body) and is
 *     stamped canary_reported (no daily re-file); terminal/fresh/reported
 *     canaries never report. A second tick dedups (watchdogKey + 'open' scope).
 *
 * getOrgPg is env-routed at the throwaway DB (the _baseline-coord-fixture
 * pattern); the registry write goes through the real operator-state PG path.
 */
import { afterAll, beforeAll, describe, expect, it, vi, beforeEach } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const WS = 'ws-canary';
const SLUG = 'canary-h';

process.env.PAPERCUSP_WORKSPACE_ID = WS;
process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';

// EI-7655: hive-canary-action's Phase 2 now wakes the Hive after queuing a
// genuinely NEW canary (requestUrgentHiveWake — the same bypass work_items:
// create's `urgent` flag uses) so the demand isn't invisible to the
// event-driven wake path. That function's real implementation fires an actual
// hive launch (fireLaunchBlueprint) — far too heavy/slow for this unit, and
// exactly the kind of side effect a routine-level test must NOT perform for
// real. Mock it and assert the ROUTINE calls it correctly instead.
const urgentWakeSpy = vi.fn().mockResolvedValue({ fired: true, coalesced: false });
vi.mock('../../hive/urgent-wake', () => ({
  requestUrgentHiveWake: (...args: unknown[]) => urgentWakeSpy(...args),
}));

let db: OrgTestDb;
let getSystemAction: typeof import('./system-actions').getSystemAction;
let canaryIdFor: typeof import('./hive-canary-action').canaryIdFor;

beforeAll(async () => {
  db = await createOrgTestDb();
  process.env.HARNESS_DATABASE_URL = db.appDsn;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
  process.env.DATABASE_URL = db.adminDsn;

  ({ getSystemAction } = await import('./system-actions'));
  ({ canaryIdFor } = await import('./hive-canary-action'));
  await import('./hive-canary-action'); // registers system:hive-canary

  // Minimal dbos schema so forensics' pipeline read has a real surface.
  await db.adminSql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS dbos;
    CREATE TABLE IF NOT EXISTS dbos.workflow_status (
      workflow_uuid text PRIMARY KEY, status text NOT NULL, created_at bigint)`);
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const fire = (slug = SLUG) =>
  getSystemAction('hive-canary')!({
    installSlug: slug,
    workspaceId: WS,
    triggerConfig: {},
    payloadTemplate: { deadlineHours: 6 },
  });

async function registerHarness(slug: string): Promise<void> {
  const { saveHarnessRegistry } = await import('../../harness-registry');
  await saveHarnessRegistry({ projects: [{ slug, path: `/tmp/${slug}` }] }, WS);
}

async function canaryRows(): Promise<Array<{ feature_id: string; status: string; payload: any }>> {
  return (await db.adminSql`
    SELECT feature_id, status, payload FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND harness_slug = ${SLUG}
     ORDER BY feature_id`) as never;
}

describe('hive-canary action (P-009)', () => {
  beforeEach(() => {
    urgentWakeSpy.mockClear();
  });

  it('self-gates cleanly when the canary harness is not registered', async () => {
    await fire('not-registered');
    const rows = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = 'not-registered'`;
    expect(rows[0].n).toBe(0);
  });

  it('queues today\'s canary once — a same-day re-fire is a no-op (replay-safe)', async () => {
    await registerHarness(SLUG);
    await fire();
    await fire(); // replay / second same-day fire
    const rows = await canaryRows();
    expect(rows.map((r) => r.feature_id)).toEqual([canaryIdFor(Date.now())]);
    expect(rows[0].status).toBe('todo');
    expect(rows[0].payload?.canary).toBe(true);

    // EI-7655: the Hive is woken EXACTLY once — for the genuinely NEW canary on
    // the first fire, never again on the idempotent same-day replay (no double
    // wake per day, and a no-op tick never wakes at all).
    expect(urgentWakeSpy).toHaveBeenCalledTimes(1);
    expect(urgentWakeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ harness: SLUG, reason: expect.stringContaining(canaryIdFor(Date.now())) }),
    );
  });

  it('reports an overdue canary ONCE with forensics attached, never a terminal or fresh one', async () => {
    const old = Date.now() - 20 * 3_600_000;
    const mk = (fid: string, status: string, ts: number) => db.adminSql`
      INSERT INTO harness_shared.harness_features_consolidated
        (harness_slug, feature_id, title, status, attempts, item_kind, payload,
         needs_human_review, workspace_id, ts, created_ts, updated_ts)
      VALUES (${SLUG}, ${fid}, ${fid}, ${status}, 0, 'feature', '{"canary": true}'::jsonb,
              FALSE, ${WS}, ${ts}, ${ts}, ${ts})`;
    await mk('F-CANARY-OVERDUE', 'todo', old);
    await mk('F-CANARY-DONE', 'passed', old); // terminal — never reports
    // Forensics surfaces for the overdue one:
    await db.adminSql`
      INSERT INTO dbos.workflow_status (workflow_uuid, status, created_at)
      VALUES (${'pipeline:' + SLUG + ':F-CANARY-OVERDUE:e0'}, 'ERROR', ${old})`;
    await db.adminSql`
      INSERT INTO harness_shared.spawned_agents
        (spawn_id, workspace_id, harness_slug, child_role, parent_role, run_id,
         feature_id, status, started_at, heartbeat_at, error_message)
      VALUES ('s-canary-1', ${WS}, ${SLUG}, 'worker', 'operator', 'r-canary',
              'F-CANARY-OVERDUE', 'failed', now(), now(), 'agent crashed')`;
    await db.adminSql`
      INSERT INTO harness_shared.autoloop_state
        (workspace_id, harness_slug, role, last_fired_at, last_status, consecutive_errors)
      VALUES (${WS}, ${SLUG}, 'director', now(), 'error: HTTP 400', 4)`;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await fire();

    // The overdue canary filed exactly one improvement, body carrying all
    // three forensics surfaces.
    const issues = await db.adminSql`
      SELECT issue_id, title, body, payload FROM harness_shared.engineer_issues
       WHERE title LIKE '%F-CANARY-OVERDUE%'`;
    expect(issues).toHaveLength(1);
    expect(issues[0].body).toContain('pipeline:canary-h:F-CANARY-OVERDUE:e0=ERROR');
    expect(issues[0].body).toContain('s-canary-1 worker=failed (agent crashed)');
    expect(issues[0].body).toContain('director: error: HTTP 400 (consecutive_errors=4)');
    expect(issues[0].payload?.watchdogKey).toBe(`hive-canary:${SLUG}:F-CANARY-OVERDUE`);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('MISSED'))).toBe(true);

    // Stamped reported; the terminal canary untouched.
    const rows = await canaryRows();
    expect(rows.find((r) => r.feature_id === 'F-CANARY-OVERDUE')?.payload?.canary_reported).toBe(true);
    expect(rows.find((r) => r.feature_id === 'F-CANARY-DONE')?.payload?.canary_reported).toBeUndefined();

    // EI-8524: the overdue canary is auto-deprecated once its miss is reported —
    // the bug already carries the forensics, so leaving it `todo` forever only
    // adds permanent frontier/Kettle "work-feed-stuck" noise. The already-terminal
    // (`passed`) canary is untouched (never entered the overdue candidate set).
    expect(rows.find((r) => r.feature_id === 'F-CANARY-OVERDUE')?.status).toBe('deprecated');
    expect(rows.find((r) => r.feature_id === 'F-CANARY-DONE')?.status).toBe('passed');
    const [deprecated] = await db.adminSql`
      SELECT terminal_owner, terminal_completion_ref FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${WS} AND harness_slug = ${SLUG} AND feature_id = 'F-CANARY-OVERDUE'`;
    expect(deprecated.terminal_owner).toBe('system:hive-canary');
    expect(deprecated.terminal_completion_ref).toContain('Auto-deprecated (EI-8524)');

    // A second tick does NOT re-file (stamp + dedup).
    await fire();
    const again = await db.adminSql`
      SELECT count(*)::int AS n FROM harness_shared.engineer_issues
       WHERE title LIKE '%F-CANARY-OVERDUE%'`;
    expect(again[0].n).toBe(1);
  });
});
