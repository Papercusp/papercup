import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../../packages/operator-core/test/_pg-helpers';
import { SUBSTRATE_OUTBOX_DDL } from '../../../../packages/operator-core/test/_work-items-schema';
import { waitForOperatorDrain, withCutSeedSingleton } from './cut-seed-cli';

describe('seed singleton with a live drainer', () => {
  let db: FreshPgDb;
  let data: postgres.Sql;
  let observer: postgres.Sql;
  const createLockClient = () => ({ sql: postgres(db.url, {
    max: 1, prepare: false,
    connection: { idle_in_transaction_session_timeout: 100 },
  }) });

  beforeAll(async () => {
    db = await createFreshPgDb('seed_singleton');
    data = postgres(db.url, { max: 1, prepare: false,
      connection: { idle_in_transaction_session_timeout: 100 } });
    observer = postgres(db.url, { max: 1, prepare: false });
    await data`CREATE TABLE harness_shared.seed_refresh_probe (id text PRIMARY KEY)`;
    await data.unsafe(SUBSTRATE_OUTBOX_DDL);
  }, 60_000);

  afterAll(async () => {
    await Promise.all([data?.end({ timeout: 2 }), observer?.end({ timeout: 2 })]);
    await db?.cleanup();
  });

  it('commits backfill rows before waiting for another connection to drain them', async () => {
    await withCutSeedSingleton({
      pg: data, workspaceId: 'seed-test', hive: 'visibility', createLockClient,
      run: async (pg) => {
        await pg`INSERT INTO harness_shared.seed_refresh_probe VALUES ('visible')`;
        const [{ visible }] = await observer<{ visible: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM harness_shared.seed_refresh_probe WHERE id = 'visible') AS visible`;
        expect(visible, 'the live drainer must see committed backfill while the cut still owns its lock').toBe(true);
        await observer`DELETE FROM harness_shared.seed_refresh_probe WHERE id = 'visible'`;
        const [{ remaining }] = await pg<{ remaining: number }[]>`
          SELECT count(*)::int AS remaining FROM harness_shared.seed_refresh_probe WHERE id = 'visible'`;
        expect(remaining).toBe(0);
      },
    });
  });

  it('keeps mutual exclusion across an external wait longer than the idle transaction limit', async () => {
    const options = { pg: data, workspaceId: 'seed-test', hive: 'external-wait', createLockClient };
    await withCutSeedSingleton({ ...options, run: async (pg) => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      await expect(withCutSeedSingleton({ ...options, run: async () => 'wrong' }))
        .rejects.toThrow('another seed cut is already refreshing or opening');
      const [{ alive }] = await pg<{ alive: number }[]>`SELECT 1 AS alive`;
      expect(alive).toBe(1);
    } });
    await expect(withCutSeedSingleton({ ...options, run: async () => 'released' })).resolves.toBe('released');
  });

  it('releases the lock when the protected callback fails', async () => {
    const options = { pg: data, workspaceId: 'seed-test', hive: 'failure', createLockClient };
    const failure = new Error('refresh failed');
    await expect(withCutSeedSingleton({ ...options, run: async () => { throw failure; } })).rejects.toBe(failure);
    await expect(withCutSeedSingleton({ ...options, run: async () => 'recovered' })).resolves.toBe('recovered');
  });

  const enqueue = async (workspace: string, id: bigint, hive = 'cohort') => {
    await observer`
      INSERT INTO harness_shared.substrate_outbox
        (id, workspace_id, harness_slug, table_name, op, key, ts)
      VALUES (${id.toString()}::bigint, ${workspace}, ${hive}, 'probe', 'put', ${id.toString()}, 0)`;
  };

  it('times out when writers refill the real outbox without delivering the pending cohort', async () => {
    const workspaceId = 'cohort-stuck';
    let id = 9007199254740993n;
    await enqueue(workspaceId, id);
    let t = 0;
    await expect(waitForOperatorDrain({
      pg: data, workspaceId, hive: 'cohort', stallMs: 1_000,
      now: () => t, warn: () => {},
      sleep: async () => {
        t += 600;
        await enqueue(workspaceId, ++id);
      },
    })).rejects.toThrow(/NO progress draining 3/);
    expect(t).toBe(1_200);
    const [{ pending }] = await observer<{ pending: number }[]>`
      SELECT count(*)::int AS pending FROM harness_shared.substrate_outbox
      WHERE workspace_id = ${workspaceId} AND drained_at IS NULL`;
    expect(pending).toBe(3);
  });

  it('completes against the fixed fence while writers keep the total backlog above zero, preserving bigint IDs and workspace/hive scope', async () => {
    // WI-6554700010048913: every poll drains one row and enqueues two, so the TOTAL
    // pending count grows forever and never reaches zero. The old total==0 rule
    // livelocked here; the fence armed at the first poll must still end the wait once
    // every row up to that fence is drained.
    const workspaceId = 'cohort-progress';
    let id = 9007199254741100n;
    await enqueue(workspaceId, id);
    await enqueue(workspaceId, ++id);
    const fence = id.toString();
    await enqueue(workspaceId, ++id, 'unrelated-hive');
    let t = 0;
    let polls = 0;
    const result = await waitForOperatorDrain({
      pg: data, workspaceId, hive: 'cohort', stallMs: 1_000,
      now: () => t, warn: () => {},
      sleep: async () => {
        t += 600;
        polls++;
        await observer`
          UPDATE harness_shared.substrate_outbox SET drained_at = ${t}
          WHERE id IN (
            SELECT id FROM harness_shared.substrate_outbox
            WHERE workspace_id = ${workspaceId} AND harness_slug = 'cohort' AND drained_at IS NULL
            ORDER BY id LIMIT 1)`;
        await enqueue(workspaceId, ++id);
        await enqueue(workspaceId, ++id);
      },
    });
    expect(result).toEqual({ undrained: 0, waitedMs: 1_200, drainedThroughId: fence, newerPending: 4 });
    expect(polls).toBe(2);
    const rows = await observer<{ harness_slug: string; pending: number }[]>`
      SELECT harness_slug, count(*)::int AS pending FROM harness_shared.substrate_outbox
      WHERE workspace_id = ${workspaceId} AND drained_at IS NULL
      GROUP BY harness_slug ORDER BY harness_slug`;
    // Newer cohort rows stay pending (they replicate after the snapshot); the unrelated
    // hive neither blocks nor counts as delivery.
    expect(rows).toEqual([
      { harness_slug: 'cohort', pending: 4 },
      { harness_slug: 'unrelated-hive', pending: 1 },
    ]);
  });
});
