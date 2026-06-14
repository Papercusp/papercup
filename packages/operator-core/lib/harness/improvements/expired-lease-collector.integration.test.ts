/**
 * expired-lease-collector.integration.test.ts — EI-530.
 *
 * `collectExpiredLeaseSignals` (the expired-lease watchdog) must count ONLY
 * plan-item claims whose holder is genuinely gone — the same alias-aware liveness
 * + grace rule the reclaim sweep (`reclaimExpiredPlanItemClaims`) uses. Before
 * EI-530 it counted every expired-but-present claim, so a long-lived session
 * still heartbeating (whose lapsed claim the sweep CORRECTLY skips) was falsely
 * counted as "the holder died/vanished", firing the signal forever.
 *
 * Mirrors stale-claims.integration.test.ts's fixture (real PG, mig 141 + the two
 * liveness-table stubs).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line) && !/\bGRANT\b/.test(line) && !/^\s*(BEGIN|COMMIT);\s*$/.test(line))
    .join('\n');

// acquireClaimLocal writes via getOrgPg().sql — point it at our fresh test DB so
// the claims it creates are the ones collectExpiredLeaseSignals (called with the
// same sql) reads. (Same seam as stale-claims.integration.test.ts.)
const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { collectExpiredLeaseSignals } = await import('./watchdog');
const claims = await import('../../plan-items/claims');

const WS = 'ws-expired-lease-collector';
const HARNESS = 'papercup';
const PLAN = 'demo-plan';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('expired-lease-collector');
  h.sql = db.sql;
  await db.sql`CREATE SCHEMA IF NOT EXISTS harness_shared`;
  await db.sql.unsafe(readMigration('141-plan-item-claims.sql')).simple();
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
async function lapse(itemId: string, secsAgo: number): Promise<void> {
  await db.sql`UPDATE harness_shared.plan_item_claims
                  SET expires_ts = clock_timestamp() - make_interval(secs => ${secsAgo})
                WHERE item_id = ${itemId}`;
}

// minCount:1 so a single qualifying row produces the signal in these small fixtures.
const collect = () => collectExpiredLeaseSignals(db.sql, { expiredLeaseMinCount: 1 });

describe('collectExpiredLeaseSignals — liveness-aware count (EI-530)', () => {
  it('counts a dead-holder claim lapsed past grace', async () => {
    await claim('P-001', 'dead-sess');
    await lapse('P-001', 4000); // ~67 min > 10 min grace
    const sigs = await collect();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.source).toBe('expired-lease');
    expect(sigs[0]!.body).toContain('1 plan-item claim');
  });

  it('does NOT count a lapsed claim whose holder has FRESH coord_presence (the EI-530 false-alarm)', async () => {
    await claim('P-002', 'live-sess');
    await lapse('P-002', 4000);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('live-sess', now())`;
    expect(await collect()).toEqual([]);
  });

  it('does NOT count a lapsed claim whose holder matches a RUNNING nursery alias', async () => {
    await claim('P-003', 'spawn-xyz');
    await lapse('P-003', 4000);
    await db.sql`INSERT INTO harness_shared.spawned_agents (spawn_id, session_owner, run_id, status, heartbeat_at)
                 VALUES ('spawn-xyz', 'o', 'r', 'running', now())`;
    expect(await collect()).toEqual([]);
  });

  it('does NOT count a claim lapsed only within the grace window (sweep will reap it)', async () => {
    await claim('P-004', 'recent-dead');
    await lapse('P-004', 60); // 1 min < 10 min grace
    expect(await collect()).toEqual([]);
  });

  it('does NOT count a non-expired (live-lease) claim', async () => {
    await claim('P-005', 'working');
    expect(await collect()).toEqual([]);
  });

  it('counts only the dead-holder claims in a mixed set', async () => {
    for (const id of ['P-010', 'P-011', 'P-012']) {
      await claim(id, `dead-${id}`);
      await lapse(id, 4000);
    }
    await claim('P-013', 'alive');
    await lapse('P-013', 4000);
    await db.sql`INSERT INTO harness_shared.coord_presence (owner_id, heartbeat_at) VALUES ('alive', now())`;
    const sigs = await collect();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]!.body).toContain('3 plan-item claim'); // the 3 dead, not the live one
  });
});
