/**
 * substrate-outbox-backstop-gc.integration.test.ts — real testcontainer PG.
 *
 * Proves the GLOBAL backstop GC (P-012, operator-memory-and-psu-resilience
 * D-016): it deletes orphaned/old federation-queue rows the per-harness inline
 * GC never reaches, while preserving every recent / in-flight row — regardless
 * of workspace (the orphaned-by-mis-route case is exactly an un-booted scope).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  runSubstrateOutboxBackstopGc,
  DRAINED_RETENTION_MS,
  ORPHAN_UNDRAINED_RETENTION_MS,
  EPHEMERAL_UNDRAINED_RETENTION_MS,
} from './substrate-outbox-backstop-gc';

/** A fixed epoch-ms clock so the retention windows are deterministic. */
const NOW = 1_800_000_000_000;

async function seed(
  sql: postgres.Sql,
  fields: {
    key: string;
    ts: number;
    drained_at?: number | null;
    workspace_id?: string;
    harness_slug?: string;
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.substrate_outbox
      (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
    VALUES
      (${fields.workspace_id ?? 'default'}, ${fields.harness_slug ?? 'papercup'},
       'harness_plans', 'put', ${fields.key}, ${sql.json({})},
       ${fields.ts}, ${fields.drained_at ?? null})`;
}

async function keysRemaining(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<Array<{ key: string }>>`
    SELECT key FROM harness_shared.substrate_outbox ORDER BY key`;
  return rows.map((r) => r.key);
}

describe('substrate-outbox backstop GC', () => {
  let db: FreshPgDb;
  let sql: postgres.Sql;

  beforeAll(async () => {
    db = await createFreshPgDb('outbox_backstop');
    sql = db.sql;
    // createFreshPgDb only makes the harness_shared schema; create the one table
    // this GC touches (mirrors outbox-drain.integration.test).
    await sql.unsafe(`
      CREATE TABLE harness_shared.substrate_outbox (
        id           BIGSERIAL PRIMARY KEY,
        workspace_id TEXT   NOT NULL,
        harness_slug TEXT   NOT NULL,
        table_name   TEXT   NOT NULL,
        op           TEXT   NOT NULL CHECK (op IN ('put', 'del')),
        key          TEXT   NOT NULL,
        row          JSONB,
        ts           BIGINT NOT NULL,
        drained_at   BIGINT
      );
    `);
  }, 60_000);
  afterAll(async () => {
    await db.cleanup();
  });
  beforeEach(async () => {
    await sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  it('GCs orphaned undrained rows older than 48h, keeps recent undrained', async () => {
    await seed(sql, { key: 'orphan-old', ts: NOW - ORPHAN_UNDRAINED_RETENTION_MS - 1000, drained_at: null });
    await seed(sql, { key: 'undrained-recent', ts: NOW - 1000, drained_at: null });

    const { deleted } = await runSubstrateOutboxBackstopGc({ now: NOW, sql });

    expect(deleted).toBe(1);
    expect(await keysRemaining(sql)).toEqual(['undrained-recent']);
  });

  it('GCs drained rows past the 24h retention, keeps recently-drained', async () => {
    await seed(sql, { key: 'drained-old', ts: NOW - 1_000_000, drained_at: NOW - DRAINED_RETENTION_MS - 1000 });
    await seed(sql, { key: 'drained-recent', ts: NOW - 1_000_000, drained_at: NOW - 1000 });

    const { deleted } = await runSubstrateOutboxBackstopGc({ now: NOW, sql });

    expect(deleted).toBe(1);
    expect(await keysRemaining(sql)).toEqual(['drained-recent']);
  });

  it('GCs orphans under ANY workspace (the un-booted-scope mis-route case)', async () => {
    await seed(sql, { key: 'orphan-default', ts: NOW - ORPHAN_UNDRAINED_RETENTION_MS - 1, workspace_id: 'default' });
    await seed(sql, { key: 'orphan-real', ts: NOW - ORPHAN_UNDRAINED_RETENTION_MS - 1, workspace_id: 'papercusp-workspace' });

    const { deleted } = await runSubstrateOutboxBackstopGc({ now: NOW, sql });

    expect(deleted).toBe(2);
    expect(await keysRemaining(sql)).toEqual([]);
  });

  it('is a no-op when everything is within the retention windows', async () => {
    await seed(sql, { key: 'fresh-undrained', ts: NOW - 1000, drained_at: null });
    await seed(sql, { key: 'fresh-drained', ts: NOW - 1000, drained_at: NOW - 1000 });

    const { deleted } = await runSubstrateOutboxBackstopGc({ now: NOW, sql });

    expect(deleted).toBe(0);
    expect(await keysRemaining(sql)).toEqual(['fresh-drained', 'fresh-undrained']);
  });
});
