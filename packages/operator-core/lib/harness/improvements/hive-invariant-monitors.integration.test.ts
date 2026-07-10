/**
 * hive-invariant-monitors.integration.test.ts — plan hive-loop-e2e-testing-2026-06-10
 * P-010: the three hive-loop invariant collectors' SQL halves, proven against a
 * real migrated PG (the pure halves are unit-tested in watchdog.test.ts).
 *
 *   - stalled-feature: fires for a dispatchable NEEDS_WORK feature untouched
 *     for > N hours; silent for fresh features, plan-gated (draft-plan)
 *     features, and features a live (PENDING) pipeline owns.
 *   - orphaned-spawn: fires for running rows whose heartbeat is far past the
 *     reclaim threshold; silent for freshly-heartbeated and terminal rows.
 *   - escalation-spike: fires when escalation volume in the window crosses the
 *     threshold; silent below it and for old escalations outside the window.
 *
 * Violations route through the watchdog's captureImprovement core — the
 * "issues:create (tagged, deduped)" sink (plan D-005 note: the improvements
 * backlog IS the papercusp-internal issue surface, with search-first dedup +
 * topic tagging built in).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import {
  collectStalledFeatureSignals,
  collectOrphanedSpawnSignals,
  collectEscalationSpikeSignals,
} from './watchdog';

const WS = 'ws-invariants';
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const HOUR = 3_600_000;

async function insertFeature(
  slug: string,
  fid: string,
  opts: { ageHours: number; sourcePlan?: string; takenBy?: string },
) {
  // EI-9019: this fixture represents a harness WITH a wired blueprint. The
  // collector must still report its stale dispatchable features; blueprint-
  // less harnesses are covered separately as expected manual work.
  await db.adminSql.unsafe(
    `INSERT INTO harness_shared.blueprints
       (workspace_id, harness_slug, blueprint_id, version, resolved, content_hash)
     VALUES ($1, $2, 'coding', '0.1.0', '{}'::jsonb, 'watchdog-test')
     ON CONFLICT (workspace_id, harness_slug) DO NOTHING`,
    [WS, slug],
  );
  const ts = Date.now() - opts.ageHours * HOUR;
  const metadata = opts.sourcePlan ? JSON.stringify({ source_plan: opts.sourcePlan }) : null;
  await db.adminSql.unsafe(
    `INSERT INTO harness_shared.harness_features_consolidated
       (harness_slug, feature_id, title, status, attempts, item_kind, needs_human_review,
        workspace_id, metadata, ts, created_ts, updated_ts, taken_by)
     VALUES ($1, $2, $3, 'todo', 0, 'feature', false, $4, $5::text::jsonb, $6, $6, $6, $7)`,
    [slug, fid, `feature ${fid}`, WS, metadata, ts, opts.takenBy ?? null],
  );
}

describe('stalled-feature collector (SQL half)', () => {
  it('fires only for stale dispatchable features; respects plan gate and live-pipeline carve-out', async () => {
    await insertFeature('inv-a', 'F-STALE', { ageHours: 20 });
    await insertFeature('inv-a', 'F-FRESH', { ageHours: 1 });
    await insertFeature('inv-a', 'F-GATED', { ageHours: 20, sourcePlan: 'unstarted-plan' });
    await insertFeature('inv-a', 'F-OWNED', { ageHours: 20 });

    // A live pipeline owns F-OWNED (the dbos schema exists in this DB only if a
    // test created it — create the minimal table the carve-out reads).
    await db.adminSql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS dbos;
      CREATE TABLE IF NOT EXISTS dbos.workflow_status (workflow_uuid text PRIMARY KEY, status text NOT NULL)`);
    await db.adminSql`
      INSERT INTO dbos.workflow_status (workflow_uuid, status)
      VALUES ('pipeline:inv-a:F-OWNED:e0', 'PENDING')`;

    const signals = await collectStalledFeatureSignals(db.adminSql as never, WS, { stalledFeatureHours: 12 });
    expect(signals).toHaveLength(1);
    expect(signals[0].key).toBe('stalled:inv-a');
    expect(signals[0].body).toContain('F-STALE');
    expect(signals[0].body).not.toContain('F-FRESH');
    expect(signals[0].body).not.toContain('F-GATED');
    expect(signals[0].body).not.toContain('F-OWNED');
  });

  it('a STARTED plan satisfies the gate (its stale features report)', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, op_status)
      VALUES (${WS}, 'inv-b', 'started-plan', 'started')`;
    await insertFeature('inv-b', 'F-PLANNED', { ageHours: 20, sourcePlan: 'started-plan' });

    const signals = await collectStalledFeatureSignals(db.adminSql as never, WS, { stalledFeatureHours: 12 });
    const b = signals.find((s) => s.key === 'stalled:inv-b');
    expect(b?.body).toContain('F-PLANNED');
  });

  it('EI-8781: a CLAIMED stale feature does not fire — that is stalled-claim\'s domain', async () => {
    await insertFeature('inv-c', 'F-CLAIMED', { ageHours: 20, takenBy: 'su-someone' });
    await insertFeature('inv-c', 'F-UNCLAIMED', { ageHours: 20 });

    const signals = await collectStalledFeatureSignals(db.adminSql as never, WS, { stalledFeatureHours: 12 });
    const c = signals.find((s) => s.key === 'stalled:inv-c');
    expect(c?.body).toContain('F-UNCLAIMED');
    expect(c?.body).not.toContain('F-CLAIMED');
  });
});

describe('orphaned-spawn collector (SQL half)', () => {
  it('fires for running rows far past the reclaim threshold; silent for fresh + terminal rows', async () => {
    // heartbeat_at is NOT NULL in the real schema — the collector's COALESCE
    // fallback to started_at is purely defensive.
    const mk = (sid: string, status: string, heartbeatAgoMin: number) => db.adminSql`
      INSERT INTO harness_shared.spawned_agents
        (spawn_id, workspace_id, harness_slug, child_role, parent_role, run_id, status, started_at, heartbeat_at)
      VALUES
        (${sid}, ${WS}, 'inv-a', 'worker', 'operator', ${`r-${sid}`}, ${status},
         now() - interval '2 hours', now() - make_interval(mins => ${heartbeatAgoMin}))`;
    await mk('s-inv-orphan', 'running', 60);
    await mk('s-inv-fresh', 'running', 1);
    await mk('s-inv-done', 'done', 60);
    await mk('s-inv-restarting', 'restarting', 45); // restarting holds a slot too

    const signals = await collectOrphanedSpawnSignals(db.adminSql as never, WS, { orphanedSpawnStaleMinutes: 15 });
    expect(signals).toHaveLength(1);
    expect(signals[0].body).toContain('2 spawned_agents row(s)');
    expect(signals[0].body).toContain('s-inv-orphan');
    expect(signals[0].body).toContain('s-inv-restarting');
  });
});

describe('escalation-spike collector (SQL half)', () => {
  it('silent below threshold / outside the window; fires with the breakdown at the threshold', async () => {
    const now = Date.now();
    const mk = (slug: string, phase: string, ageHours: number) => db.adminSql`
      INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, workspace_id, mtime_ms)
      VALUES (${slug}, ${phase}, 'pipeline escalated', ${WS}, ${now - ageHours * HOUR})`;
    await mk('inv-a', 'p1', 1);
    await mk('inv-a', 'p2', 2);
    await mk('inv-c', 'p1', 48); // outside the 6h window — must not count

    expect(await collectEscalationSpikeSignals(db.adminSql as never, WS, { escalationSpikeMinCount: 3 })).toEqual([]);

    await mk('inv-b', 'p1', 1);
    const signals = await collectEscalationSpikeSignals(db.adminSql as never, WS, { escalationSpikeMinCount: 3 });
    expect(signals).toHaveLength(1);
    expect(signals[0].body).toContain('3 escalation(s)');
    expect(signals[0].body).toContain('inv-a×2');
    expect(signals[0].body).toContain('inv-b×1');
  });
});
