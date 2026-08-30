/**
 * seat-accounting.integration.test.ts — the seat-consumption liveness ledger
 * against real PG (mig 487). Covers the IO half that seat-accounting.test.ts
 * (pure) does NOT: countConsumedSeats' LIVE_PREDICATE + the release helpers.
 *
 * Regression focus (WI-5317): a member that booted, WROTE presence, and then
 * EXITED must FREE its seat even inside the 10-min boot grace — the grace only
 * shields a member that has not written presence YET (mig 487: "a booting member
 * has a consumption row before its first presence write"). Before the fix, such a
 * member held its seat for the full grace window, so a wound-down member blocked
 * re-spawn with seats_exhausted on the WI-5211 cross-machine rig.
 *
 * countConsumedSeats reads only agent_seat_consumptions + coord_presence
 * (owner_id + heartbeat_at), so we hand-roll those two minimal tables (spawn-admission
 * stand-in pattern) rather than replaying the whole schema.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/fleet/seat-accounting.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  countConsumedSeats,
  releaseSeatConsumption,
  releaseSeatConsumptions,
} from './seat-accounting';

const SEAT_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.agent_seat_consumptions (
    owner_id text PRIMARY KEY, workspace_id text NOT NULL, fleet_slug text NOT NULL,
    seat_ref text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`;
// Minimal coord_presence stand-in — the liveness predicate reads only owner_id + heartbeat_at.
const PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_presence (
    owner_id text PRIMARY KEY, workspace_id text, heartbeat_at timestamptz NOT NULL DEFAULT now())`;

// NON-default: resolveAllotmentWorkspace maps the default coord workspace to
// "unpartitioned" and countConsumedSeats short-circuits to empty for it.
const WS = 'seat-acct-ws-1';
const FLEET = 'fed-drill';
const REF = 'sonnet:medium:AUTO';
let db: FreshPgDb;

async function seatRow(ownerId: string, createdAgoSecs: number): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.agent_seat_consumptions (owner_id, workspace_id, fleet_slug, seat_ref, created_at)
    VALUES (${ownerId}, ${WS}, ${FLEET}, ${REF}, now() - ${`${createdAgoSecs} seconds`}::interval)`;
}
async function presenceRow(ownerId: string, heartbeatAgoSecs: number): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.coord_presence (owner_id, workspace_id, heartbeat_at)
    VALUES (${ownerId}, ${WS}, now() - ${`${heartbeatAgoSecs} seconds`}::interval)`;
}
async function consumed(): Promise<number> {
  const m = await countConsumedSeats({ workspaceId: WS, fleetSlug: FLEET }, db.sql);
  return m.get(REF) ?? 0;
}

const FRESH = 5; // seconds — well within any presence-stale window
const STALE = 24 * 60 * 60; // 24h — stale under any presence-stale window
const IN_GRACE = 60; // seconds — within the 10-min boot grace
const PAST_GRACE = 24 * 60 * 60; // past the boot grace

beforeAll(async () => {
  db = await createFreshPgDb('seat-accounting');
  await db.sql.unsafe(SEAT_DDL);
  await db.sql.unsafe(PRESENCE_DDL);
}, 90_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.agent_seat_consumptions`;
  await db.sql`TRUNCATE harness_shared.coord_presence`;
});

describe('countConsumedSeats — LIVE_PREDICATE (WI-5317, real PG)', () => {
  it('a live member (fresh presence) counts its seat', async () => {
    await seatRow('su-live', IN_GRACE);
    await presenceRow('su-live', FRESH);
    expect(await consumed()).toBe(1);
  });

  it('WI-5317: a member that wrote presence then went STALE frees its seat even inside the boot grace', async () => {
    // booted 1 min ago (well within the 10-min grace) but its presence heartbeat
    // is 24h stale → the member exited. Pre-fix this counted (grace floor); the
    // fix frees it because a presence row EXISTS and is not fresh.
    await seatRow('su-exited', IN_GRACE);
    await presenceRow('su-exited', STALE);
    expect(await consumed()).toBe(0);
  });

  it('the boot grace STILL shields a booting member that has not written presence yet', async () => {
    // consumption row exists, no presence row at all → within grace, protected.
    await seatRow('su-booting', IN_GRACE);
    expect(await consumed()).toBe(1);
  });

  it('a dead member past the grace with no presence is not counted (and is lazily purged)', async () => {
    await seatRow('su-ghost', PAST_GRACE);
    expect(await consumed()).toBe(0);
    const left = await db.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.agent_seat_consumptions WHERE owner_id = 'su-ghost'`;
    expect(Number(left[0]?.n)).toBe(0); // purge removed the ghost row
  });

  it('mixed fleet: only live + booting seats count', async () => {
    await seatRow('su-live', IN_GRACE);
    await presenceRow('su-live', FRESH);
    await seatRow('su-booting', IN_GRACE); // no presence yet
    await seatRow('su-exited', IN_GRACE);
    await presenceRow('su-exited', STALE); // stale → freed
    expect(await consumed()).toBe(2);
  });
});

describe('releaseSeatConsumption(s) (WI-5317, real PG)', () => {
  it('single release frees a live seat immediately (the clean-leave path)', async () => {
    await seatRow('su-a', IN_GRACE);
    await presenceRow('su-a', FRESH);
    expect(await consumed()).toBe(1);
    await releaseSeatConsumption('su-a', db.sql);
    expect(await consumed()).toBe(0);
  });

  it('bulk release frees many seats (the reaper path); empty list is a no-op', async () => {
    await seatRow('su-a', IN_GRACE);
    await presenceRow('su-a', FRESH);
    await seatRow('su-b', IN_GRACE);
    await presenceRow('su-b', FRESH);
    expect(await consumed()).toBe(2);
    await releaseSeatConsumptions([], db.sql); // no-op
    expect(await consumed()).toBe(2);
    await releaseSeatConsumptions(['su-a', 'su-b'], db.sql);
    expect(await consumed()).toBe(0);
  });
});
