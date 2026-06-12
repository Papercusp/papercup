/**
 * supervision.integration.test.ts — the spawn tree as a supervision tree (P1, D-002).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Drives the REAL supervision engine
 * against real Postgres: the restart-intensity governor (> MaxR in MaxT ⇒ escalate),
 * the three OTP restart strategies, and the crash-loop → tear-down + escalate decision.
 * The escalation + lock-release effects are injected as spies.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { recordSpawn, finishSpawn, getSpawn } from './spawn-tree';
import {
  recordRestartIntensity,
  restartSet,
  superviseCrash,
  DEFAULT_MAX_RESTARTS,
} from './supervision';
import type { LockTarget, LockReleaseResult } from './lock-release';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY, workspace_id text NOT NULL, harness_slug text NOT NULL,
    parent_spawn_id text, parent_role text, child_role text NOT NULL,
    feature_id text, chunk_id text, run_id text NOT NULL,
    status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz, duration_ms bigint, exit_code int, output_tail text, error_message text,
    cancel_requested boolean NOT NULL DEFAULT false, session_owner text,
    coordination_domain text NOT NULL DEFAULT 'default', plan_slug text, item_id text,
    model_spec text, model_tier text, brief text,
    restart_strategy text NOT NULL DEFAULT 'one_for_one', restart_count int NOT NULL DEFAULT 0,
    restart_window_start timestamptz, cancel_reason text, cancelled_at timestamptz,
    pid int, launcher_host text, heartbeat_at timestamptz NOT NULL DEFAULT now(), last_output_at timestamptz)`;
const HFC_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    harness_slug text NOT NULL, feature_id text NOT NULL, status text NOT NULL DEFAULT 'todo',
    taken_by text, taken_at timestamptz, workspace_id text NOT NULL DEFAULT 'default',
    item_kind text NOT NULL DEFAULT 'feature', created_ts bigint, updated_ts bigint,
    PRIMARY KEY (harness_slug, feature_id))`;
const PLAN_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.plan_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL, item_id text NOT NULL,
    owner text NOT NULL, expires_ts timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id))`;

const WS = 'default';
const ACTOR: AgentIdentity = { ownerId: 'curator', ownerLabel: 'curator', source: 'principal', workspaceId: WS, userId: null };

let db: FreshPgDb;
let escalations: { severity: string; summary: string }[] = [];
let lockCalls: LockTarget[][] = [];
const spyEscalate = async (input: { severity: 'blocker'; summary: string }) => {
  escalations.push(input);
  return { msg_id: 'esc-' + escalations.length };
};
const spyReleaser = async (targets: LockTarget[]): Promise<LockReleaseResult> => {
  lockCalls.push(targets);
  return { owners: targets.map((t) => t.owner), filePathsReleased: targets.length, resourcesReleased: 0 };
};
const spyNotifier = async () => {};

async function spawn(spawnId: string, opts: { parent?: string | null; strategy?: string; owner?: string } = {}) {
  await recordSpawn(db.sql, {
    spawnId, workspaceId: WS, harnessSlug: 'papercup', runId: 'r-' + spawnId, childRole: 'worker',
    parentSpawnId: opts.parent ?? null, sessionOwner: opts.owner ?? spawnId,
    restartStrategy: (opts.strategy as 'one_for_one' | 'one_for_all' | 'rest_for_one') ?? 'one_for_one',
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('supervision');
  await db.sql.unsafe(SPAWNED_AGENTS_DDL);
  await db.sql.unsafe(HFC_DDL);
  await db.sql.unsafe(PLAN_ITEM_CLAIMS_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => {
  escalations = []; lockCalls = [];
  await db.sql`TRUNCATE harness_shared.spawned_agents, harness_shared.harness_features_consolidated, harness_shared.plan_item_claims`;
});

describe('supervision — restart-intensity governor (D-002, real PG)', () => {
  it('counts restarts in a sliding window and trips when count exceeds MaxR', async () => {
    await spawn('w');
    const results = [];
    for (let i = 0; i < DEFAULT_MAX_RESTARTS + 1; i++) {
      results.push(await recordRestartIntensity(db.sql, { workspaceId: WS, spawnId: 'w' }));
    }
    // counts climb 1..MaxR (not exceeded), then MaxR+1 (exceeded).
    expect(results.map((r) => r!.count)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r!.intensityExceeded)).toEqual([false, false, false, true]);
    expect(results[0]!.windowReset).toBe(true);
    expect(results[1]!.windowReset).toBe(false);
  });

  it('resets the window once it has lapsed (windowSec elapsed)', async () => {
    await spawn('w');
    const r1 = await recordRestartIntensity(db.sql, { workspaceId: WS, spawnId: 'w', windowSec: 600 });
    expect(r1!.count).toBe(1);
    // Force the window to look lapsed by backdating its start.
    await db.sql`UPDATE harness_shared.spawned_agents SET restart_window_start = now() - interval '700 seconds' WHERE spawn_id='w'`;
    const r2 = await recordRestartIntensity(db.sql, { workspaceId: WS, spawnId: 'w', windowSec: 600 });
    expect(r2!.windowReset).toBe(true);
    expect(r2!.count).toBe(1); // fresh window
  });

  it('returns null for an unknown spawn', async () => {
    expect(await recordRestartIntensity(db.sql, { workspaceId: WS, spawnId: 'ghost' })).toBeNull();
  });
});

describe('supervision — restart strategies (D-002, real PG)', () => {
  it('one_for_one restarts only the crashed node', async () => {
    await spawn('parent', { strategy: 'one_for_one' });
    await spawn('a', { parent: 'parent', strategy: 'one_for_one' });
    await spawn('b', { parent: 'parent', strategy: 'one_for_one' });
    const rs = await restartSet(db.sql, { workspaceId: WS, crashedSpawnId: 'a' });
    expect(rs.toRestart).toEqual(['a']);
  });

  it('one_for_all restarts the crashed node + all active siblings', async () => {
    await spawn('parent');
    await spawn('a', { parent: 'parent', strategy: 'one_for_all' });
    await spawn('b', { parent: 'parent', strategy: 'one_for_all' });
    await spawn('c', { parent: 'parent', strategy: 'one_for_all' });
    await finishSpawn(db.sql, { spawnId: 'c', workspaceId: WS, status: 'done' }); // terminal sibling excluded
    const rs = await restartSet(db.sql, { workspaceId: WS, crashedSpawnId: 'a' });
    expect(rs.toRestart.sort()).toEqual(['a', 'b']);
  });

  it('rest_for_one restarts the crashed node + siblings started after it', async () => {
    await spawn('parent');
    // created in order a, b, c → started_at order a<b<c (tie-broken by spawn_id).
    await spawn('a', { parent: 'parent', strategy: 'rest_for_one' });
    await spawn('b', { parent: 'parent', strategy: 'rest_for_one' });
    await spawn('c', { parent: 'parent', strategy: 'rest_for_one' });
    const rs = await restartSet(db.sql, { workspaceId: WS, crashedSpawnId: 'b' });
    expect(rs.toRestart).toEqual(['b', 'c']); // a (earlier) untouched
  });
});

describe('supervision — superviseCrash decision (D-002, real PG)', () => {
  it('within budget → marks the restart set as restarting', async () => {
    await spawn('parent');
    await spawn('a', { parent: 'parent', strategy: 'rest_for_one' });
    await spawn('b', { parent: 'parent', strategy: 'rest_for_one' });
    await finishSpawn(db.sql, { spawnId: 'a', workspaceId: WS, status: 'failed', exitCode: 1 });

    const res = await superviseCrash(db.sql, {
      workspaceId: WS, spawnId: 'a', actor: ACTOR, reason: 'exit 1',
      escalate: spyEscalate, lockReleaser: spyReleaser, notifier: spyNotifier,
    });
    expect(res.action).toBe('restart');
    expect(res.toRestart.sort()).toEqual(['a', 'b']);
    expect((await getSpawn(db.sql, WS, 'a'))?.status).toBe('restarting');
    expect((await getSpawn(db.sql, WS, 'b'))?.status).toBe('restarting');
    expect(escalations).toHaveLength(0);
  });

  it('crash-loop (over budget) → tears the subtree down + escalates to a human', async () => {
    await spawn('root', { owner: 'own-root' });
    await spawn('child', { parent: 'root', owner: 'own-child' });
    // Drive it to the brink: MaxR restarts already in the window.
    await db.sql`UPDATE harness_shared.spawned_agents SET restart_count=${DEFAULT_MAX_RESTARTS}, restart_window_start=now() WHERE spawn_id='root'`;

    const res = await superviseCrash(db.sql, {
      workspaceId: WS, spawnId: 'root', actor: ACTOR, reason: 'exit 1',
      escalate: spyEscalate, lockReleaser: spyReleaser, notifier: spyNotifier,
    });

    expect(res.action).toBe('escalate');
    expect(res.intensity?.intensityExceeded).toBe(true);
    expect(res.escalationId).toBe('esc-1');
    // Escalation raised to the human, severity blocker.
    expect(escalations).toEqual([expect.objectContaining({ severity: 'blocker' })]);
    // Subtree torn down: child cancelled, locks released for both owners; root marked failed.
    expect((await getSpawn(db.sql, WS, 'child'))?.status).toBe('cancelled');
    expect((await getSpawn(db.sql, WS, 'root'))?.status).toBe('failed');
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].map((t) => t.owner).sort()).toEqual(['own-child', 'own-root']);
  });
});
