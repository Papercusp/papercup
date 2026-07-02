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

  it('WI-1634: a currently-started hive is EXEMPT from the 48h orphan reap (recoverable halt, not orphaned)', async () => {
    await seed(sql, {
      key: 'started-halted',
      ts: NOW - ORPHAN_UNDRAINED_RETENTION_MS - 1000,
      drained_at: null,
      workspace_id: 'ws-a',
      harness_slug: 'hive-a',
    });
    // A genuinely orphaned (not-started) row at the SAME age is still reaped.
    await seed(sql, {
      key: 'orphan-not-started',
      ts: NOW - ORPHAN_UNDRAINED_RETENTION_MS - 1000,
      drained_at: null,
      workspace_id: 'ws-b',
      harness_slug: 'hive-b',
    });

    const { deleted } = await runSubstrateOutboxBackstopGc({
      now: NOW,
      sql,
      startedHives: [{ workspaceId: 'ws-a', installSlug: 'hive-a' }],
    });

    expect(deleted).toBe(1);
    expect(await keysRemaining(sql)).toEqual(['started-halted']);
  });

  it('WI-1634: the exemption is keyed on the EXACT (workspace, slug) pair — a mis-routed/retired slug under a DIFFERENT started hive is still reaped (M1 preserved)', async () => {
    // The started hive lives under the NEW slug 'papercusp'...
    await seed(sql, {
      key: 'orphan-retired-slug',
      ts: NOW - ORPHAN_UNDRAINED_RETENTION_MS - 1000,
      drained_at: null,
      workspace_id: 'ws-c',
      harness_slug: 'papercup', // ...but this row is captured under the OLD retired slug.
    });

    const { deleted } = await runSubstrateOutboxBackstopGc({
      now: NOW,
      sql,
      startedHives: [{ workspaceId: 'ws-c', installSlug: 'papercusp' }],
    });

    expect(deleted).toBe(1);
    expect(await keysRemaining(sql)).toEqual([]);
  });

  it('WI-1634: no startedHives supplied ⇒ old behavior unchanged (nothing exempt)', async () => {
    await seed(sql, {
      key: 'orphan-default-opts',
      ts: NOW - ORPHAN_UNDRAINED_RETENTION_MS - 1000,
      drained_at: null,
      workspace_id: 'ws-d',
      harness_slug: 'hive-d',
    });

    const { deleted } = await runSubstrateOutboxBackstopGc({ now: NOW, sql }); // no startedHives

    expect(deleted).toBe(1);
    expect(await keysRemaining(sql)).toEqual([]);
  });

  it('reaps undrained one-shot ephemeral test-hive rows on the short TTL, sparing recent + non-ephemeral', async () => {
    // A contract-test-* one-shot hive's undrained row past the 2h ephemeral TTL → reaped...
    await seed(sql, {
      key: 'ct-stale',
      ts: NOW - EPHEMERAL_UNDRAINED_RETENTION_MS - 1000,
      drained_at: null,
      harness_slug: 'contract-test-1782049733979-v3ze7n',
    });
    // ...one still inside the ephemeral TTL is preserved (could be an in-flight drain)...
    await seed(sql, {
      key: 'ct-recent',
      ts: NOW - 60_000,
      drained_at: null,
      harness_slug: 'contract-test-1782050000000-aaaaaa',
    });
    // ...and a NON-ephemeral real-hive undrained row at the SAME 2h+ age is NOT reaped (it keeps the 48h TTL).
    await seed(sql, {
      key: 'real-2h',
      ts: NOW - EPHEMERAL_UNDRAINED_RETENTION_MS - 1000,
      drained_at: null,
      harness_slug: 'papercusp',
    });

    const { deleted } = await runSubstrateOutboxBackstopGc({ now: NOW, sql });

    expect(deleted).toBe(1);
    expect(await keysRemaining(sql)).toEqual(['ct-recent', 'real-2h']);
  });
});
