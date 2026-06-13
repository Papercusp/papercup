/**
 * coord-invariant-actions.integration.test.ts — EI-436, real testcontainer PG.
 *
 * Proves `sweepDrainedOutbox`: the single-writer, bounded+batched global GC of
 * drained `substrate_outbox` rows that the P-013 coord-invariant-monitor runs to
 * reclaim rows the per-handle inline drain GC can't reach (a harness that
 * federated then stopped booting has no drain loop, so its drained rows leak).
 *
 *  - deletes drained rows older than the window across EVERY harness_slug in the
 *    workspace (incl. dormant ones), in batches, returning the total deleted;
 *  - NEVER touches recently-drained rows, pending (drained_at IS NULL) rows, or
 *    another workspace's rows;
 *  - batches a large backlog (loops until cleared) and honours the maxBatches cap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { sweepDrainedOutbox } from './coord-invariant-actions';
import { OUTBOX_GC_AGE_MS } from '../../sync/hyperbee/outbox-drain';

const WS = 'ws_gc';
const HOUR = 60 * 60 * 1000;

/** Seed one outbox row; returns its id. */
async function seed(
  sql: postgres.Sql,
  f: { workspace_id?: string; harness_slug: string; drained_at: number | null; ts?: number },
): Promise<number> {
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.substrate_outbox
      (workspace_id, harness_slug, table_name, op, key, row, ts, drained_at)
    VALUES
      (${f.workspace_id ?? WS}, ${f.harness_slug}, 'harness_features_consolidated', 'put', 'F-1',
       ${sql.json({ id: 'F-1' })}, ${f.ts ?? Date.now()}, ${f.drained_at})
    RETURNING id`;
  return Number(r.id);
}

describe('sweepDrainedOutbox (EI-436, real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('coord_outbox_gc');
    await db.sql.unsafe(`
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
      CREATE INDEX substrate_outbox_drain_idx
        ON harness_shared.substrate_outbox (workspace_id, harness_slug, drained_at, id);
    `);
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.substrate_outbox RESTART IDENTITY`;
  });

  it('reclaims old-drained rows across ALL slugs in the workspace; keeps recent/pending/other-workspace', async () => {
    const now = Date.now();
    await seed(db.sql, { harness_slug: 'dormant-a', drained_at: now - 25 * HOUR }); // delete
    await seed(db.sql, { harness_slug: 'dormant-b', drained_at: now - 48 * HOUR }); // delete (other slug — the point)
    await seed(db.sql, { harness_slug: 'active', drained_at: now - 1 * HOUR });      // keep — recently drained
    await seed(db.sql, { harness_slug: 'active', drained_at: null, ts: now - 99 * HOUR }); // keep — pending, even if ancient
    await seed(db.sql, { workspace_id: 'ws_other', harness_slug: 'dormant-a', drained_at: now - 48 * HOUR }); // keep — other ws

    const deleted = await sweepDrainedOutbox(db.sql, WS, now);
    expect(deleted).toBe(2);

    // Survivors: recent-drained + pending (this ws) + the other workspace's row.
    const survivors = await db.sql<{ workspace_id: string; harness_slug: string; drained_at: string | null }[]>`
      SELECT workspace_id, harness_slug, drained_at FROM harness_shared.substrate_outbox ORDER BY id`;
    expect(survivors).toHaveLength(3);
    // No old-drained row remains for WS.
    const [{ n: oldDrainedLeft }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
       WHERE workspace_id = ${WS} AND drained_at IS NOT NULL AND drained_at < ${now - OUTBOX_GC_AGE_MS}`;
    expect(oldDrainedLeft).toBe(0);
    // The pending row is untouched.
    const [{ n: pending }] = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.substrate_outbox WHERE drained_at IS NULL`;
    expect(pending).toBe(1);
  });

  it('batches a large backlog, looping until cleared', async () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await seed(db.sql, { harness_slug: `dormant-${i % 3}`, drained_at: now - 30 * HOUR });
    }
    const deleted = await sweepDrainedOutbox(db.sql, WS, now, { batch: 5 }); // 5 + 5 + 2
    expect(deleted).toBe(12);
    const [{ n }] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    expect(n).toBe(0);
  });

  it('honours the maxBatches cap (never an unbounded sweep)', async () => {
    const now = Date.now();
    for (let i = 0; i < 12; i++) {
      await seed(db.sql, { harness_slug: 'dormant-a', drained_at: now - 30 * HOUR });
    }
    const deleted = await sweepDrainedOutbox(db.sql, WS, now, { batch: 5, maxBatches: 1 });
    expect(deleted).toBe(5); // one batch only
    const [{ n }] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    expect(n).toBe(7);
  });
});
