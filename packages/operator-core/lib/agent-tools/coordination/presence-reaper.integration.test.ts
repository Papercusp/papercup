/**
 * presence-reaper.integration.test.ts — `reapEndedPresenceRows` against REAL
 * Postgres (presence-coord-unification-2026-07-01 P-004, WI-1347).
 *
 * Drives the reaper's own getOrgPg() handle end-to-end: listPresence → real
 * fetchWakeability (a live event_awaits row is the `wakeable` signal) → the
 * planner → the DELETE. Mirrors presence.integration.test.ts's fixture/seed
 * conventions (setupBaselineCoordFixture, explicit heartbeat_at seeding,
 * per-test TRUNCATE for isolation).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { reapEndedPresenceRows } from './presence-reaper';
import { listPresence } from './presence';
import { COORD_INBOX_WAKE_PREFIX } from './inbox-wake';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const TTL = 60 * 60 * 1000; // 1h for the test

/** Seed a presence row with an explicit heartbeat age (seconds in the past). */
async function seedPresence(ownerId: string, ageSeconds: number): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, 'default', 'static-client',
            now() - ${`${ageSeconds} seconds`}::interval)
  `;
}

/** Seed a LIVE standing inbox-wake await for an owner — makes it `wakeable`. */
async function seedLiveAwait(ownerId: string): Promise<void> {
  await admin`
    INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, fired_at, cancelled_at, expires_ts)
    VALUES (${ownerId}, ${`${COORD_INBOX_WAKE_PREFIX}${ownerId}`}, NULL, NULL, NULL)
  `;
}

async function ownerIds(): Promise<string[]> {
  const rows = await admin<{ owner_id: string }[]>`
    SELECT owner_id FROM harness_shared.coord_presence ORDER BY owner_id`;
  return rows.map((r) => r.owner_id);
}

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  admin = fx.admin;
});
afterAll(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`.catch(() => {});
  await admin`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE 'reap-%'`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`;
  await admin`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE 'reap-%'`;
});

describe('reapEndedPresenceRows (real PG)', () => {
  it('reaps an ended (unwakeable) row past the TTL, keeps a fresh ended row and a wakeable (parked) row', async () => {
    await seedPresence('reap-dead', 2 * 60 * 60); // 2h old, no await → ended, past TTL
    await seedPresence('reap-fresh-ended', 60); // 1m old, no await → ended, inside grace
    await seedPresence('reap-parked', 10 * 60 * 60); // 10h old heartbeat, BUT has a live await
    await seedLiveAwait('reap-parked');

    const result = await reapEndedPresenceRows({ ttlMs: TTL });

    expect(result.reaped).toBe(1);
    expect(result.ownerIds).toEqual(['reap-dead']);
    expect(await ownerIds()).toEqual(['reap-fresh-ended', 'reap-parked']);
  });

  it('a wakeable row NEVER gets reaped, however old its heartbeat', async () => {
    await seedPresence('reap-ancient-parked', 100 * 60 * 60); // ~100h old
    await seedLiveAwait('reap-ancient-parked');

    const result = await reapEndedPresenceRows({ ttlMs: TTL });

    expect(result.reaped).toBe(0);
    expect(await ownerIds()).toEqual(['reap-ancient-parked']);
  });

  it('a cancelled await does not count as wakeable — the row is reaped once past TTL', async () => {
    await seedPresence('reap-cancelled', 2 * 60 * 60);
    await admin`
      INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, fired_at, cancelled_at, expires_ts)
      VALUES ('reap-cancelled', ${`${COORD_INBOX_WAKE_PREFIX}reap-cancelled`}, NULL, now(), NULL)
    `;

    const result = await reapEndedPresenceRows({ ttlMs: TTL });

    expect(result.reaped).toBe(1);
    expect(result.ownerIds).toEqual(['reap-cancelled']);
  });

  it('returns a zero result and issues no DELETE on an empty roster', async () => {
    const result = await reapEndedPresenceRows({ ttlMs: TTL });
    expect(result).toEqual({ reaped: 0, ownerIds: [], skipped: 0 });
  });

  it('the surviving rows are visible through listPresence after a reap', async () => {
    await seedPresence('reap-gone', 2 * 60 * 60);
    await seedPresence('reap-kept', 0);
    await reapEndedPresenceRows({ ttlMs: TTL });
    const live = await listPresence();
    expect(live.map((r) => r.ownerId)).toContain('reap-kept');
    expect(live.map((r) => r.ownerId)).not.toContain('reap-gone');
  });
});
