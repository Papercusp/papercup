import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

describe('postgres.js reserved query queue after backend close', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('reserved-query-close');
    // One in-flight query fills the only pipeline slot; the next query stays in
    // postgres.js reserve()'s private queue until the backend is killed.
    sql = postgres(db.url, { max: 1, max_pipeline: 1, prepare: false });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 }).catch(() => {});
    await db?.cleanup();
  });

  it('rejects every queued reserved query when Postgres closes the connection', async () => {
    const reserved = await sql.reserve();
    try {
      const [backend] = await reserved<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      const active = reserved`SELECT pg_sleep(60)`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      const pipelined = reserved`SELECT 41 AS answer`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );
      const queued = reserved`SELECT 42 AS answer`.execute().then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      );

      await vi.waitFor(async () => {
        const [activity] = await db.sql<{ state: string }[]>`
          SELECT state FROM pg_stat_activity WHERE pid = ${backend.pid}`;
        expect(activity?.state).toBe('active');
      }, { timeout: 5_000, interval: 20 });

      const [terminated] = await db.sql<{ terminated: boolean }[]>`
        SELECT pg_terminate_backend(${backend.pid}) AS terminated`;
      expect(terminated.terminated).toBe(true);
      await expect(active).resolves.toBe('rejected');
      await expect(pipelined).resolves.toBe('rejected');

      let timer: ReturnType<typeof setTimeout> | undefined;
      const queuedResult = await Promise.race([
        queued,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), 2_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      expect(queuedResult).toBe('rejected');
    } finally {
      reserved.release();
    }
  });
});
