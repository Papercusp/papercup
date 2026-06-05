/**
 * nursery.integration.test.ts — structured concurrency over the spawn tree (P0).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04 D-003. Drives the REAL nursery
 * engine against real Postgres (a throwaway DB), proving the missing primitive:
 * transitive cancellation propagates DOWN the whole spawn subtree and releases each
 * descendant's work-item/plan-item claims + locks NOW — while terminal nodes are left
 * untouched and the completion gate refuses to complete a nursery with a live child.
 *
 * The cross-DB lock release (papercusp_su) is injected as a spy here (its real wiring
 * is proved in lock-release.integration.test.ts against a live su DB); everything in
 * harness_shared (spawn status + claim release) is exercised for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { cancelSubtree, assertCanComplete, openChildCount } from './nursery';
import { recordSpawn, finishSpawn, getSpawn } from './spawn-tree';
import type { LockTarget, LockReleaseResult } from './lock-release';
import type { CancelNotice } from './nursery';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

// Post-migration-146 faithful shape (the columns the engine reads/writes).
const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    parent_spawn_id text,
    parent_role text,
    child_role text NOT NULL,
    feature_id text,
    chunk_id text,
    run_id text NOT NULL,
    status text NOT NULL DEFAULT 'running',
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    duration_ms bigint,
    exit_code int,
    output_tail text,
    error_message text,
    cancel_requested boolean NOT NULL DEFAULT false,
    session_owner text,
    coordination_domain text NOT NULL DEFAULT 'default',
    plan_slug text,
    item_id text,
    restart_strategy text NOT NULL DEFAULT 'one_for_one',
    restart_count int NOT NULL DEFAULT 0,
    restart_window_start timestamptz,
    cancel_reason text,
    cancelled_at timestamptz)`;

const HFC_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_features_consolidated (
    harness_slug text NOT NULL, feature_id text NOT NULL, title text, summary text,
    status text NOT NULL DEFAULT 'todo', attempts bigint DEFAULT 0,
    item_kind text NOT NULL DEFAULT 'feature', payload jsonb, parent_id text,
    taken_by text, taken_at timestamptz,
    workspace_id text NOT NULL DEFAULT 'default',
    ts bigint, created_ts bigint, updated_ts bigint,
    PRIMARY KEY (harness_slug, feature_id))`;

const PLAN_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.plan_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL, item_id text NOT NULL,
    claim_id uuid DEFAULT gen_random_uuid() NOT NULL, owner text NOT NULL, owner_label text, owner_name text,
    intent text DEFAULT '' NOT NULL, liveness_mode text DEFAULT 'availability', ttl_sec int DEFAULT 1200 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp(), expires_ts timestamptz NOT NULL, last_activity_ts timestamptz,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id))`;

const WS = 'default';
const HARNESS = 'papercup';
const ACTOR: AgentIdentity = { ownerId: 'op-actor', ownerLabel: 'operator', source: 'principal', workspaceId: WS, userId: null };

let db: FreshPgDb;

// Spies for the injectable effects.
let lockCalls: LockTarget[][] = [];
let notices: CancelNotice[] = [];
const spyReleaser = async (targets: LockTarget[]): Promise<LockReleaseResult> => {
  lockCalls.push(targets);
  return { owners: targets.map((t) => t.owner), filePathsReleased: targets.length, resourcesReleased: 0 };
};
const spyNotifier = async (n: CancelNotice): Promise<void> => {
  notices.push(n);
};

async function spawn(
  spawnId: string,
  opts: { parent?: string | null; owner?: string; role?: string; feature?: string; plan?: string; item?: string },
) {
  await recordSpawn(db.sql, {
    spawnId,
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: `run-${spawnId}`,
    childRole: opts.role ?? 'worker',
    parentSpawnId: opts.parent ?? null,
    parentRole: 'operator',
    sessionOwner: opts.owner ?? null,
    featureId: opts.feature ?? null,
    planSlug: opts.plan ?? null,
    itemId: opts.item ?? null,
  });
}

beforeAll(async () => {
  db = await createFreshPgDb('nursery');
  await db.sql.unsafe(SPAWNED_AGENTS_DDL);
  await db.sql.unsafe(HFC_DDL);
  await db.sql.unsafe(PLAN_ITEM_CLAIMS_DDL);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  lockCalls = [];
  notices = [];
  await db.sql`TRUNCATE harness_shared.spawned_agents,
                       harness_shared.harness_features_consolidated,
                       harness_shared.plan_item_claims`;
});

describe('nursery — transitive cancellation (D-003, real PG)', () => {
  it('cancels the whole active subtree, leaves terminal nodes untouched', async () => {
    // root → A → B (all active); root → C (done). A holds a feature + plan-item claim.
    await spawn('root', { owner: 'own-root', role: 'operator' });
    await spawn('A', { parent: 'root', owner: 'own-A' });
    await spawn('B', { parent: 'A', owner: 'own-B' });
    await spawn('C', { parent: 'root', owner: 'own-C' });
    await finishSpawn(db.sql, { spawnId: 'C', workspaceId: WS, status: 'done', exitCode: 0 });

    const res = await cancelSubtree(db.sql, {
      workspaceId: WS,
      rootSpawnId: 'root',
      reason: 'human abort',
      actor: ACTOR,
      lockReleaser: spyReleaser,
      notifier: spyNotifier,
    });

    expect(res.cancelled.map((c) => c.spawnId).sort()).toEqual(['A', 'B', 'root']);
    expect(res.alreadyTerminal).toEqual(['C']);

    // The active nodes flipped to cancelled with the reason; C stays done.
    expect((await getSpawn(db.sql, WS, 'root'))?.status).toBe('cancelled');
    expect((await getSpawn(db.sql, WS, 'B'))?.status).toBe('cancelled');
    expect((await getSpawn(db.sql, WS, 'C'))?.status).toBe('done');
    const a = await db.sql<{ status: string; cancel_requested: boolean; cancel_reason: string }[]>`
      SELECT status, cancel_requested, cancel_reason FROM harness_shared.spawned_agents WHERE spawn_id='A'`;
    expect(a[0]).toMatchObject({ status: 'cancelled', cancel_requested: true, cancel_reason: 'human abort' });
  });

  it('releases the subtree work-item + plan-item claims immediately', async () => {
    await spawn('root', { owner: 'own-root', role: 'operator' });
    await spawn('A', { parent: 'root', owner: 'own-A', feature: 'F-1', plan: 'plan-x', item: 'P-001' });

    // A's claims: feature taken_by own-A + a plan-item claim owned by own-A.
    await db.sql`INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, taken_by, taken_at, workspace_id, created_ts, updated_ts)
      VALUES (${HARNESS}, 'F-1', 'own-A', now(), ${WS}, 0, 0)`;
    await db.sql`INSERT INTO harness_shared.plan_item_claims
      (workspace_id, harness_slug, plan_slug, item_id, owner, expires_ts)
      VALUES (${WS}, ${HARNESS}, 'plan-x', 'P-001', 'own-A', now() + interval '20 min')`;

    const res = await cancelSubtree(db.sql, {
      workspaceId: WS, rootSpawnId: 'root', reason: 'abort', actor: ACTOR,
      lockReleaser: spyReleaser, notifier: spyNotifier,
    });

    expect(res.claimsReleased).toBe(1);
    expect(res.planClaimsReleased).toBe(1);
    const f = await db.sql<{ taken_by: string | null }[]>`SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-1'`;
    expect(f[0].taken_by).toBeNull();
    const pc = await db.sql`SELECT 1 FROM harness_shared.plan_item_claims WHERE item_id='P-001'`;
    expect(pc).toHaveLength(0);
  });

  it("does NOT release a feature claimed by someone other than the cancelled node's owner", async () => {
    await spawn('root', { owner: 'own-root', role: 'operator' });
    await spawn('A', { parent: 'root', owner: 'own-A', feature: 'F-2' });
    await db.sql`INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, taken_by, workspace_id, created_ts, updated_ts)
      VALUES (${HARNESS}, 'F-2', 'someone-else', ${WS}, 0, 0)`;

    const res = await cancelSubtree(db.sql, {
      workspaceId: WS, rootSpawnId: 'root', reason: 'abort', actor: ACTOR,
      lockReleaser: spyReleaser, notifier: spyNotifier,
    });
    expect(res.claimsReleased).toBe(0);
    const f = await db.sql<{ taken_by: string | null }[]>`SELECT taken_by FROM harness_shared.harness_features_consolidated WHERE feature_id='F-2'`;
    expect(f[0].taken_by).toBe('someone-else');
  });

  it('releases locks for every distinct active owner (not terminal ones) and notifies them', async () => {
    await spawn('root', { owner: 'own-root', role: 'operator' });
    await spawn('A', { parent: 'root', owner: 'own-A' });
    await spawn('B', { parent: 'A', owner: 'own-B' });
    await spawn('C', { parent: 'root', owner: 'own-C' });
    await finishSpawn(db.sql, { spawnId: 'C', workspaceId: WS, status: 'failed', exitCode: 1 });

    const res = await cancelSubtree(db.sql, {
      workspaceId: WS, rootSpawnId: 'root', reason: 'abort', actor: ACTOR,
      lockReleaser: spyReleaser, notifier: spyNotifier,
    });

    expect(lockCalls).toHaveLength(1);
    const owners = lockCalls[0].map((t) => t.owner).sort();
    expect(owners).toEqual(['own-A', 'own-B', 'own-root']); // own-C (terminal) excluded
    expect(res.locks.filePathsReleased).toBe(3);

    expect(notices).toHaveLength(1);
    expect(notices[0].toOwners.sort()).toEqual(['own-A', 'own-B', 'own-root']);
    expect(notices[0].reason).toBe('abort');
    expect(res.notified.sort()).toEqual(['own-A', 'own-B', 'own-root']);
  });

  it('is idempotent — re-cancelling a terminal subtree is a no-op', async () => {
    await spawn('root', { owner: 'own-root', role: 'operator' });
    await spawn('A', { parent: 'root', owner: 'own-A' });

    await cancelSubtree(db.sql, { workspaceId: WS, rootSpawnId: 'root', reason: 'first', actor: ACTOR, lockReleaser: spyReleaser, notifier: spyNotifier });
    lockCalls = []; notices = [];

    const res2 = await cancelSubtree(db.sql, { workspaceId: WS, rootSpawnId: 'root', reason: 'second', actor: ACTOR, lockReleaser: spyReleaser, notifier: spyNotifier });
    expect(res2.cancelled).toHaveLength(0);
    expect(res2.alreadyTerminal.sort()).toEqual(['A', 'root']);
    expect(lockCalls).toHaveLength(0); // no active owners → no lock release
    expect(notices).toHaveLength(0);
    // The original cancel reason is preserved (not overwritten by 'second').
    const a = await db.sql<{ cancel_reason: string }[]>`SELECT cancel_reason FROM harness_shared.spawned_agents WHERE spawn_id='A'`;
    expect(a[0].cancel_reason).toBe('first');
  });
});

describe('nursery — completion gate (D-003, real PG)', () => {
  it('refuses to complete while a child lives; allows it once the subtree is terminal', async () => {
    await spawn('root', { owner: 'own-root', role: 'operator' });
    await spawn('A', { parent: 'root', owner: 'own-A' });
    await spawn('B', { parent: 'A', owner: 'own-B' });
    await spawn('C', { parent: 'root', owner: 'own-C' });
    await finishSpawn(db.sql, { spawnId: 'C', workspaceId: WS, status: 'done', exitCode: 0 });

    // A + B active (C done) → 2 open children, cannot complete.
    expect(await openChildCount(db.sql, WS, 'root')).toBe(2);
    let gate = await assertCanComplete(db.sql, WS, 'root');
    expect(gate).toEqual({ canComplete: false, openChildren: 2 });

    // Finish the live descendants → gate opens.
    await finishSpawn(db.sql, { spawnId: 'B', workspaceId: WS, status: 'done', exitCode: 0 });
    await finishSpawn(db.sql, { spawnId: 'A', workspaceId: WS, status: 'done', exitCode: 0 });
    gate = await assertCanComplete(db.sql, WS, 'root');
    expect(gate).toEqual({ canComplete: true, openChildren: 0 });
  });
});
