/**
 * spawn-admission.integration.test.ts — atomic spawn admission against real PG
 * (audit P-017 + P-039, EI-73).
 *
 * Proves the two race fixes with REAL concurrency:
 *   • N concurrent admissions against a cap of 1 admit exactly ONE spawn
 *     (the advisory-lock-serialized reclaim+count+record closes the
 *     read-committed gap the old sequence had);
 *   • two concurrent admissions sharing an idempotencyKey produce ONE row —
 *     the loser gets `duplicate` with the winner's spawnId (a route-timeout
 *     retry no longer double-spawns).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { admitSpawn } from './operator-spawn';

const SPAWNED_AGENTS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text PRIMARY KEY, workspace_id text NOT NULL, harness_slug text,
    parent_spawn_id text, parent_role text, child_role text NOT NULL,
    feature_id text, chunk_id text, run_id text,
    status text NOT NULL DEFAULT 'running', started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz, duration_ms bigint, exit_code int, output_tail text, error_message text,
    cancel_requested boolean NOT NULL DEFAULT false, session_owner text,
    coordination_domain text NOT NULL DEFAULT 'default', plan_slug text, item_id text,
    restart_strategy text NOT NULL DEFAULT 'one_for_one', restart_count int NOT NULL DEFAULT 0,
    restart_window_start timestamptz, cancel_reason text, cancelled_at timestamptz,
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key text);
  CREATE UNIQUE INDEX IF NOT EXISTS spawned_agents_idempotency_key_uq
    ON harness_shared.spawned_agents (workspace_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL`;

const WS = 'default';
let db: FreshPgDb;

function recordRow(spawnId: string) {
  return async (tx: Parameters<Parameters<typeof admitSpawn>[1]['record']>[0]) => {
    await tx`
      INSERT INTO harness_shared.spawned_agents
        (spawn_id, workspace_id, harness_slug, child_role, run_id, status)
      VALUES (${spawnId}, ${WS}, 'papercup', 'worker', ${'r-' + spawnId}, 'running')`;
  };
}

async function rowCount(): Promise<number> {
  const rows = await db.sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM harness_shared.spawned_agents WHERE workspace_id = ${WS}`;
  return Number(rows[0]?.n ?? 0);
}

beforeAll(async () => {
  db = await createFreshPgDb('spawn-admission');
  await db.sql.unsafe(SPAWNED_AGENTS_DDL);
}, 90_000);
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.spawned_agents`; });

describe('admitSpawn (P-017 + P-039, real PG)', () => {
  it('admits below the cap and records the row', async () => {
    const { admission } = await admitSpawn(db.sql, {
      workspaceId: WS, spawnId: 's-a', idempotencyKey: null, cap: 2, record: recordRow('s-a'),
    });
    expect(admission).toEqual({ kind: 'admitted' });
    expect(await rowCount()).toBe(1);
  });

  it('rejects over the cap without recording', async () => {
    await admitSpawn(db.sql, {
      workspaceId: WS, spawnId: 's-a', idempotencyKey: null, cap: 1, record: recordRow('s-a'),
    });
    const { admission } = await admitSpawn(db.sql, {
      workspaceId: WS, spawnId: 's-b', idempotencyKey: null, cap: 1, record: recordRow('s-b'),
    });
    expect(admission).toEqual({ kind: 'over_cap', running: 1, cap: 1 });
    expect(await rowCount()).toBe(1);
  });

  it('CONCURRENT: 8 simultaneous admissions at cap=1 admit exactly one (P-039)', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        admitSpawn(db.sql, {
          workspaceId: WS,
          spawnId: `s-race-${i}`,
          idempotencyKey: null,
          cap: 1,
          record: recordRow(`s-race-${i}`),
        }),
      ),
    );
    const admitted = results.filter((r) => r.admission.kind === 'admitted');
    const overCap = results.filter((r) => r.admission.kind === 'over_cap');
    expect(admitted).toHaveLength(1);
    expect(overCap).toHaveLength(7);
    expect(await rowCount()).toBe(1); // no ceiling overshoot, ever
  });

  it('CONCURRENT: two admissions sharing an idempotencyKey yield one row + a duplicate pointing at it (P-017/EI-73)', async () => {
    const [a, b] = await Promise.all([
      admitSpawn(db.sql, {
        workspaceId: WS, spawnId: 's-idem-a', idempotencyKey: 'retry-1', cap: 10, record: recordRow('s-idem-a'),
      }),
      admitSpawn(db.sql, {
        workspaceId: WS, spawnId: 's-idem-b', idempotencyKey: 'retry-1', cap: 10, record: recordRow('s-idem-b'),
      }),
    ]);
    const kinds = [a.admission.kind, b.admission.kind].sort();
    expect(kinds).toEqual(['admitted', 'duplicate']);
    const dup = (a.admission.kind === 'duplicate' ? a : b).admission as { kind: 'duplicate'; spawnId: string };
    const winner = a.admission.kind === 'admitted' ? 's-idem-a' : 's-idem-b';
    expect(dup.spawnId).toBe(winner);
    expect(await rowCount()).toBe(1);
  });

  it('a SEQUENTIAL retry with the same key dedupes against the committed row', async () => {
    await admitSpawn(db.sql, {
      workspaceId: WS, spawnId: 's-first', idempotencyKey: 'k1', cap: 10, record: recordRow('s-first'),
    });
    const { admission } = await admitSpawn(db.sql, {
      workspaceId: WS, spawnId: 's-second', idempotencyKey: 'k1', cap: 10, record: recordRow('s-second'),
    });
    expect(admission).toEqual({ kind: 'duplicate', spawnId: 's-first' });
    expect(await rowCount()).toBe(1);
  });

  it('different keys spawn independently', async () => {
    await admitSpawn(db.sql, {
      workspaceId: WS, spawnId: 's-k1', idempotencyKey: 'k1', cap: 10, record: recordRow('s-k1'),
    });
    const { admission } = await admitSpawn(db.sql, {
      workspaceId: WS, spawnId: 's-k2', idempotencyKey: 'k2', cap: 10, record: recordRow('s-k2'),
    });
    expect(admission).toEqual({ kind: 'admitted' });
    expect(await rowCount()).toBe(2);
  });
});
