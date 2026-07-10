/**
 * throughput.integration.test.ts — pot throughput ticks against real migrated
 * PG (mug-autonomous-execution B-11 / P-050, migration 261).
 *
 * Validates the schema end-to-end: the migration applies (a broken 261 throws
 * in beforeAll), the exact column list recordPotThroughputTick INSERTs is
 * accepted, and readHiveThroughputSnapshot's query round-trips real rows —
 * grouping by pot, picking the newest tick, and computing the operating-well
 * verdict over live data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { readHiveThroughputSnapshot } from '../sync-resolver/learning-hive-throughput-read';

const WS = 'ws-throughput';

/** Insert one tick row with the SAME column list recordPotThroughputTick uses. */
async function insertTick(
  sql: Sql,
  row: {
    potSlug: string;
    tickAt: string;
    frontierDepth: number;
    placements: number;
    cupsBusy: number;
    cupsCap: number;
    stuckCount: number;
    completed: number;
    mttcMs: number | null;
    questionRungs: Record<string, number>;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.hive_throughput_ticks
      (workspace_id, pot_slug, tick_at, frontier_depth, placements, bees_busy, bees_cap,
       stuck_count, completed, mttc_ms, question_rungs, detail)
    VALUES
      (${WS}, ${row.potSlug}, ${row.tickAt}, ${row.frontierDepth}, ${row.placements},
       ${row.cupsBusy}, ${row.cupsCap}, ${row.stuckCount}, ${row.completed}, ${row.mttcMs},
       ${JSON.stringify(row.questionRungs)}::text::jsonb, ${JSON.stringify(row.detail)}::text::jsonb)`;
}

describe('hive_throughput_ticks (real PG, migration 261)', () => {
  let db: OrgTestDb;
  let sql: Sql;
  beforeAll(async () => {
    db = await createOrgTestDb();
    sql = db.adminSql;
  }, 120_000);
  afterAll(async () => {
    await db?.cleanup();
  });

  it('round-trips ticks: newest-per-pot latest, recent trend, operating-well verdict', async () => {
    await insertTick(sql, {
      potSlug: 'papercup',
      tickAt: '2026-06-13T08:00:00Z',
      frontierDepth: 5,
      placements: 3,
      cupsBusy: 4,
      cupsCap: 16,
      stuckCount: 0,
      completed: 2,
      mttcMs: 90_000,
      questionRungs: {},
      detail: { utilization: 0.25 },
    });
    await insertTick(sql, {
      potSlug: 'papercup',
      tickAt: '2026-06-13T08:00:30Z', // newer
      frontierDepth: 2,
      placements: 1,
      cupsBusy: 5,
      cupsCap: 16,
      stuckCount: 0,
      completed: 1,
      mttcMs: 120_000,
      questionRungs: { 'cup-self': 2, owner: 1 },
      detail: { utilization: 0.3125 },
    });

    const snap = await readHiveThroughputSnapshot(sql, WS);
    expect(snap.hives).toHaveLength(1);
    const h = snap.hives[0]!;
    expect(h.potSlug).toBe('papercup');
    expect(h.latest?.frontierDepth).toBe(2); // newest tick
    expect(h.latest?.cupsBusy).toBe(5);
    expect(h.latest?.utilization).toBeCloseTo(0.3125, 4);
    expect(h.latest?.questionRungs).toEqual({ 'cup-self': 2, owner: 1 });
    expect(h.recent).toHaveLength(2);
    expect(h.operatingWell).toBe(true);
  });

  it('a starved latest tick (busy==cap, frontier>0) reads as not operating well', async () => {
    await insertTick(sql, {
      potSlug: 'busypot',
      tickAt: '2026-06-13T09:00:00Z',
      frontierDepth: 9,
      placements: 0,
      cupsBusy: 8,
      cupsCap: 8,
      stuckCount: 0,
      completed: 0,
      mttcMs: null,
      questionRungs: {},
      detail: { utilization: 1 },
    });
    const snap = await readHiveThroughputSnapshot(sql, WS, { potSlug: 'busypot' });
    expect(snap.hives).toHaveLength(1);
    expect(snap.hives[0]?.operatingWell).toBe(false);
    expect(snap.hives[0]?.latest?.mttcMs).toBeNull();
  });

  it('scopes by workspace — another workspace\'s ticks are invisible', async () => {
    await sql`
      INSERT INTO harness_shared.hive_throughput_ticks
        (workspace_id, pot_slug, frontier_depth, bees_busy, bees_cap)
      VALUES ('ws-other', 'papercup', 1, 1, 16)`;
    const snap = await readHiveThroughputSnapshot(sql, WS);
    // Only WS hives — 'papercup' + 'busypot', never ws-other's row.
    expect(snap.hives.every((h) => h.latest != null)).toBe(true);
    expect(snap.hives.map((h) => h.potSlug).sort()).toEqual(['busypot', 'papercup']);
  });
});
