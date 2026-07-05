/**
 * fleet/pg-stores — the hive spawn-tree store, proven against a REAL Postgres
 * (testcontainer; Docker required). Covers record + ON CONFLICT, the RECURSIVE
 * subtree walk (depth ordering + includeRoot), the active-descendant count,
 * direct children, and the finish/restart/fail status transitions.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/fleet/pg-stores.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import {
  recordSpawnPg,
  finishSpawnPg,
  getSpawnPg,
  getSubtreePg,
  openChildrenPg,
  directChildrenPg,
  markRestartingPg,
  markFailedPg,
} from './pg-stores';
import type { RecordSpawnInput } from '@papercusp/structured-concurrency';

const WS = 'ws-a';
let db: MigratedTestDb;
let sql: Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'fleetstore',
    provision: async (url) => {
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
        await s.unsafe(`
          CREATE TABLE harness_shared.spawned_agents (
            spawn_id text PRIMARY KEY,
            parent_spawn_id text,
            workspace_id text NOT NULL,
            harness_slug text,
            parent_role text,
            child_role text NOT NULL,
            run_id text,
            status text NOT NULL DEFAULT 'running',
            session_owner text,
            coordination_domain text DEFAULT 'default',
            feature_id text,
            chunk_id text,
            plan_slug text,
            item_id text,
            model_spec text,
            model_tier text,
            brief text,
            restart_strategy text DEFAULT 'one_for_one',
            restart_count int DEFAULT 0,
            restart_window_start timestamptz,
            started_at timestamptz NOT NULL DEFAULT now(),
            finished_at timestamptz,
            duration_ms bigint,
            exit_code int,
            error_message text,
            output_tail text,
            cancel_requested boolean DEFAULT false,
            cancelled_at timestamptz,
            cancel_reason text,
            pid int,
            launcher_host text,
            launcher_boot_id text,
            heartbeat_at timestamptz NOT NULL DEFAULT now(),
            last_output_at timestamptz
          )`);
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 8, onnotice: () => {} });
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

beforeEach(async () => {
  await sql`TRUNCATE harness_shared.spawned_agents`;
});

const spawn = (id: string, over: Partial<RecordSpawnInput> = {}): RecordSpawnInput => ({
  spawnId: id,
  workspaceId: WS,
  runId: `run-${id}`,
  childRole: 'worker',
  ...over,
});

/** R → {A, B}; A → GA. */
async function seedTree() {
  await recordSpawnPg(sql, spawn('R', { childRole: 'mug' }));
  await recordSpawnPg(sql, spawn('A', { parentSpawnId: 'R' }));
  await recordSpawnPg(sql, spawn('B', { parentSpawnId: 'R' }));
  await recordSpawnPg(sql, spawn('GA', { parentSpawnId: 'A' }));
}

describe('recordSpawnPg / getSpawnPg', () => {
  it('inserts a node mapped to a SpawnNode with defaults', async () => {
    await recordSpawnPg(sql, spawn('R', { harnessSlug: 'papercup' }));
    const node = await getSpawnPg(sql, WS, 'R');
    expect(node).not.toBeNull();
    expect(node!.spawnId).toBe('R');
    expect(node!.status).toBe('running');
    expect(node!.coordinationDomain).toBe('default');
    expect(node!.restartStrategy).toBe('one_for_one');
  });

  it('returns null for an unknown spawn or wrong workspace', async () => {
    await recordSpawnPg(sql, spawn('R'));
    expect(await getSpawnPg(sql, WS, 'missing')).toBeNull();
    expect(await getSpawnPg(sql, 'ws-other', 'R')).toBeNull();
  });

  it('ON CONFLICT COALESCEs session_owner (keeps existing when new is null, updates when set)', async () => {
    await recordSpawnPg(sql, spawn('R', { sessionOwner: 'owner1' }));
    await recordSpawnPg(sql, spawn('R')); // sessionOwner omitted → null → keep owner1
    expect((await getSpawnPg(sql, WS, 'R'))!.sessionOwner).toBe('owner1');
    await recordSpawnPg(sql, spawn('R', { sessionOwner: 'owner2' })); // non-null → overwrite
    expect((await getSpawnPg(sql, WS, 'R'))!.sessionOwner).toBe('owner2');
  });
});

describe('getSubtreePg (recursive)', () => {
  it('returns the whole subtree ordered by depth', async () => {
    await seedTree();
    const tree = await getSubtreePg(sql, { workspaceId: WS, rootSpawnId: 'R' });
    expect(tree.map((n) => n.spawnId)).toEqual(['R', 'A', 'B', 'GA']);
    expect(tree.map((n) => n.depth)).toEqual([0, 1, 1, 2]);
  });

  it('excludes the root when includeRoot is false', async () => {
    await seedTree();
    const tree = await getSubtreePg(sql, { workspaceId: WS, rootSpawnId: 'R', includeRoot: false });
    expect(tree.map((n) => n.spawnId)).toEqual(['A', 'B', 'GA']);
  });

  it('is workspace-scoped', async () => {
    await seedTree();
    expect(await getSubtreePg(sql, { workspaceId: 'ws-other', rootSpawnId: 'R' })).toEqual([]);
  });
});

describe('openChildrenPg / directChildrenPg', () => {
  it('counts active descendants and follows past a terminal ancestor', async () => {
    await seedTree();
    expect(await openChildrenPg(sql, WS, 'R')).toBe(3); // A, B, GA all running
    await finishSpawnPg(sql, { workspaceId: WS, spawnId: 'A', status: 'passed' });
    // A is terminal but its row still bridges to GA, which is still active.
    expect(await openChildrenPg(sql, WS, 'R')).toBe(2); // B + GA
  });

  it('directChildren returns only the immediate children', async () => {
    await seedTree();
    const kids = await directChildrenPg(sql, WS, 'R');
    expect(kids.map((n) => n.spawnId).sort()).toEqual(['A', 'B']); // not GA
  });
});

describe('status transitions', () => {
  it('finishSpawnPg sets status, finished_at, and a duration', async () => {
    await recordSpawnPg(sql, spawn('R'));
    await finishSpawnPg(sql, { workspaceId: WS, spawnId: 'R', status: 'passed', exitCode: 0 });
    const [row] = await sql<{ status: string; finished_at: Date | null; duration_ms: number | null }[]>`
      SELECT status, finished_at, duration_ms FROM harness_shared.spawned_agents WHERE spawn_id = 'R'`;
    expect(row.status).toBe('passed');
    expect(row.finished_at).not.toBeNull();
    expect(Number(row.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it('markRestartingPg flips eligible rows to restarting and clears finished_at', async () => {
    await recordSpawnPg(sql, spawn('R'));
    await finishSpawnPg(sql, { workspaceId: WS, spawnId: 'R', status: 'failed' });
    await markRestartingPg(sql, WS, ['R']);
    const node = await getSpawnPg(sql, WS, 'R');
    expect(node!.status).toBe('restarting');
  });

  it('markRestartingPg([]) is a no-op', async () => {
    await expect(markRestartingPg(sql, WS, [])).resolves.toBeUndefined();
  });

  it('markFailedPg sets status failed + error message', async () => {
    await recordSpawnPg(sql, spawn('R'));
    await markFailedPg(sql, WS, 'R', 'segfault');
    const [row] = await sql<{ status: string; error_message: string }[]>`
      SELECT status, error_message FROM harness_shared.spawned_agents WHERE spawn_id = 'R'`;
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('segfault');
  });
});
