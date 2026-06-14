/**
 * stale-claims.integration.test.ts — EI-179 plan-item lease GC.
 *
 * Exercises `reclaimExpiredPlanItemClaims` against a real Postgres: a lapsed
 * claim whose holder is gone is deleted; a non-expired claim, a within-grace
 * lapse, and a lapsed claim whose holder is still alive (fresh coord_presence
 * OR a running nursery alias) are all left untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { reclaimExpiredPlanItemClaims } = await import('./stale-claims');
const claims = await import('./claims');

const WS = 'ws-stale-plan-claims';
const HARNESS = 'papercup';
const PLAN = 'demo-plan';
const GRACE = 10 * 60 * 1000; // 10 min

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('stale-plan-claims');
  h.sql = db.sql;
  await db.sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await db.sql.unsafe(readMigration('141-plan-item-claims.sql')).simple();
  // Minimal stubs for the liveness join — the real tables live in 000-baseline;
  // only the columns the live_holder CTE reads are needed here.
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text NOT NULL,
    heartbeat_at timestamptz DEFAULT now() NOT NULL )`;
  await db.sql`CREATE TABLE IF NOT EXISTS harness_shared.spawned_agents (
    spawn_id text, session_owner text, run_id text, status text, heartbeat_at timestamptz )`;
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_claims`;
  await db.sql`TRUNCATE harness_shared.coord_presence`;
  await db.sql`TRUNCATE harness_shared.spawned_agents`;
});

async function claim(itemId: string, owner: string): Promise<void> {
  const r = await claims.acquireClaimLocal({ workspaceId: WS, harnessSlug: HARNESS, planSlug: PLAN, itemId, owner });
  expect(r.ok).toBe(true);
}
/** Force a claim's lease to have lapsed `secsAgo` seconds ago. */
async function lapse(itemId: string, secsAgo: number): Promise<void> {
  await db.sql`UPDATE harness_shared.plan_item_claims
                  SET expires_ts = clock_timestamp() - make_interval(secs => ${secsAgo})
                WHERE item_id = ${itemId}`;
}
async function present(itemId: string): Promise<boolean> {
  const r = await db.sql`SELECT 1 FROM harness_shared.plan_item_claims WHERE item_id = ${itemId}`;
  return r.length > 0;
}

describe('reclaimExpiredPlanItemClaims (EI-179 plan-item lease GC)', () => {
  it('reaps a long-lapsed claim whose holder has no live presence', async () => {
    await claim('P-001', 'dead-sess');
    await lapse('P-001', 4000); // ~67 min lapsed > grace
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id)).toEqual(['P-001']);
    expect(r.released[0]!.former_owner).toBe('dead-sess');
    expect(r.released[0]!.lapsed_secs).toBeGreaterThan(GRACE / 1000);
    expect(await present('P-001')).toBe(false);
  });

  it('does NOT reap a non-expired (live-lease) claim', async () => {
    await claim('P-002', 'live-sess');
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-002')).toBe(true);
  });

  it('does NOT reap a claim lapsed within the grace window', async () => {
    await claim('P-003', 'recent-sess');
    await lapse('P-003', 60); // 1 min lapsed < 10 min grace
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-003')).toBe(true);
  });

  it('does NOT reap a long-lapsed claim whose holder has FRESH coord_presence (alive mid-long-turn)', async () => {
    await claim('P-004', 'busy-sess');
    await lapse('P-004', 4000);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('busy-sess', now())`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-004')).toBe(true);
  });

  it('does NOT reap a claim whose holder matches a RUNNING nursery alias', async () => {
    await claim('P-005', 'spawn-xyz');
    await lapse('P-005', 4000);
    await db.sql`INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at)
                 VALUES ('spawn-xyz', 'sess-owner', 'run-1', 'running', now())`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released).toEqual([]);
    expect(await present('P-005')).toBe(true);
  });

  it('does NOT count a STALE nursery row as alive (dead spawn, old heartbeat)', async () => {
    await claim('P-006', 'spawn-old');
    await lapse('P-006', 4000);
    await db.sql`INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at)
                 VALUES ('spawn-old', 'o', 'r', 'running', now() - interval '2 hours')`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id)).toEqual(['P-006']);
    expect(await present('P-006')).toBe(false);
  });

  it('reaps several dead-holder claims in one sweep, leaving the live one', async () => {
    for (const id of ['P-010', 'P-011', 'P-012']) {
      await claim(id, `dead-${id}`);
      await lapse(id, 4000);
    }
    await claim('P-013', 'alive');
    await lapse('P-013', 4000);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('alive', now())`;
    const r = await reclaimExpiredPlanItemClaims(db.sql, { graceMs: GRACE });
    expect(r.released.map((x) => x.item_id).sort()).toEqual(['P-010', 'P-011', 'P-012']);
    expect(await present('P-013')).toBe(true);
  });
});
