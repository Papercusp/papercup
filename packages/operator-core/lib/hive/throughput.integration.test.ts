/**
 * throughput.integration.test.ts — hive throughput ticks against real migrated
 * PG (queen-autonomous-execution B-11 / P-050, migration 261).
 *
 * Validates the schema end-to-end: the migration applies (a broken 261 throws
 * in beforeAll), the exact column list recordHiveThroughputTick INSERTs is
 * accepted, and readHiveThroughputSnapshot's query round-trips real rows —
 * grouping by hive, picking the newest tick, and computing the operating-well
 * verdict over live data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { readHiveThroughputSnapshot } from '../sync-resolver/learning-hive-throughput-read';

const WS = 'ws-throughput';

/** Insert one tick row with the SAME column list recordHiveThroughputTick uses. */
async function insertTick(
  sql: Sql,
  row: {
    hiveSlug: string;
    tickAt: string;
    frontierDepth: number;
    placements: number;
    beesBusy: number;
    beesCap: number;
    stuckCount: number;
    completed: number;
    mttcMs: number | null;
    questionRungs: Record<string, number>;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await sql`
    INSERT INTO harness_shared.hive_throughput_ticks
      (workspace_id, hive_slug, tick_at, frontier_depth, placements, bees_busy, bees_cap,
       stuck_count, completed, mttc_ms, question_rungs, detail)
    VALUES
      (${WS}, ${row.hiveSlug}, ${row.tickAt}, ${row.frontierDepth}, ${row.placements},
       ${row.beesBusy}, ${row.beesCap}, ${row.stuckCount}, ${row.completed}, ${row.mttcMs},
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

  it('round-trips ticks: newest-per-hive latest, recent trend, operating-well verdict', async () => {
    await insertTick(sql, {
      hiveSlug: 'papercup',
      tickAt: '2026-06-13T08:00:00Z',
      frontierDepth: 5,
      placements: 3,
      beesBusy: 4,
      beesCap: 16,
      stuckCount: 0,
      completed: 2,
      mttcMs: 90_000,
      questionRungs: {},
      detail: { utilization: 0.25 },
    });
    await insertTick(sql, {
      hiveSlug: 'papercup',
      tickAt: '2026-06-13T08:00:30Z', // newer
      frontierDepth: 2,
      placements: 1,
      beesBusy: 5,
      beesCap: 16,
      stuckCount: 0,
      completed: 1,
      mttcMs: 120_000,
      questionRungs: { 'bee-self': 2, owner: 1 },
      detail: { utilization: 0.3125 },
    });

    const snap = await readHiveThroughputSnapshot(sql, WS);
    expect(snap.hives).toHaveLength(1);
    const h = snap.hives[0]!;
    expect(h.hiveSlug).toBe('papercup');
    expect(h.latest?.frontierDepth).toBe(2); // newest tick
    expect(h.latest?.beesBusy).toBe(5);
    expect(h.latest?.utilization).toBeCloseTo(0.3125, 4);
    expect(h.latest?.questionRungs).toEqual({ 'bee-self': 2, owner: 1 });
    expect(h.recent).toHaveLength(2);
    expect(h.operatingWell).toBe(true);
  });

  it('a starved latest tick (busy==cap, frontier>0) reads as not operating well', async () => {
    await insertTick(sql, {
      hiveSlug: 'busyhive',
      tickAt: '2026-06-13T09:00:00Z',
      frontierDepth: 9,
      placements: 0,
      beesBusy: 8,
      beesCap: 8,
      stuckCount: 0,
      completed: 0,
      mttcMs: null,
      questionRungs: {},
      detail: { utilization: 1 },
    });
    const snap = await readHiveThroughputSnapshot(sql, WS, { hiveSlug: 'busyhive' });
    expect(snap.hives).toHaveLength(1);
    expect(snap.hives[0]?.operatingWell).toBe(false);
    expect(snap.hives[0]?.latest?.mttcMs).toBeNull();
  });

  it('scopes by workspace — another workspace\'s ticks are invisible', async () => {
    await sql`
      INSERT INTO harness_shared.hive_throughput_ticks
        (workspace_id, hive_slug, frontier_depth, bees_busy, bees_cap)
      VALUES ('ws-other', 'papercup', 1, 1, 16)`;
    const snap = await readHiveThroughputSnapshot(sql, WS);
    // Only WS hives — 'papercup' + 'busyhive', never ws-other's row.
    expect(snap.hives.every((h) => h.latest != null)).toBe(true);
    expect(snap.hives.map((h) => h.hiveSlug).sort()).toEqual(['busyhive', 'papercup']);
  });
});
