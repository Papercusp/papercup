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
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../../_baseline-coord-fixture';
import { reapEndedPresenceRows } from './presence-reaper';
import { listPresence } from './presence';
import { COORD_INBOX_WAKE_PREFIX } from './inbox-wake';

let fx: BaselineCoordFixture;
let admin: postgres.Sql;

const TTL = 60 * 60 * 1000; // 1h for the test
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_871_ARMED = resolve(
  HERE,
  '../../../../../libs/papercusp/libs/db/sql/871-lifecycle-bound-watches.sql',
);
const MIGRATION_871 = existsSync(MIGRATION_871_ARMED)
  ? MIGRATION_871_ARMED
  : `${MIGRATION_871_ARMED}.DRAFT`;

/** Seed a presence row with an explicit heartbeat age (seconds in the past).
 *  WI-5964: coord_presence_pkey is PRIMARY KEY(owner_id) ONLY — globally unique,
 *  not scoped by workspace_id — so a bare INSERT can collide with a same-named
 *  literal owner_id seeded by another concurrent *.integration.test.ts process on
 *  this shared fixture. Upsert so this test's own values always win. */
async function seedPresence(ownerId: string, ageSeconds: number): Promise<void> {
  await admin`
    INSERT INTO harness_shared.coord_presence (owner_id, owner_label, workspace_id, source, heartbeat_at)
    VALUES (${ownerId}, ${ownerId}, 'default', 'static-client',
            now() - ${`${ageSeconds} seconds`}::interval)
    ON CONFLICT (owner_id) DO UPDATE SET
      owner_label = EXCLUDED.owner_label,
      workspace_id = EXCLUDED.workspace_id,
      source = EXCLUDED.source,
      heartbeat_at = EXCLUDED.heartbeat_at
  `;
}

/** Seed a LIVE standing inbox-wake await for an owner — makes it `wakeable`. */
async function seedLiveAwait(ownerId: string): Promise<void> {
  await admin`
    INSERT INTO harness_shared.event_awaits (subscriber_id, event_key, fired_at, cancelled_at, expires_ts)
    VALUES (${ownerId}, ${`${COORD_INBOX_WAKE_PREFIX}${ownerId}`}, NULL, NULL, NULL)
  `;
}

async function seedBoundAndManualWatches(ownerId: string): Promise<void> {
  const binding = JSON.stringify({ kind: 'presence-owner', ref: ownerId });
  await admin`
    INSERT INTO harness_shared.event_awaits
      (subscriber_id, event_key, once, fired_at, cancelled_at, expires_ts, bound_to)
    VALUES
      (${ownerId}, ${`fleet:item-completed:${ownerId}`}, false, NULL, NULL, NULL, ${binding}::text::jsonb),
      (${ownerId}, ${`manual:${ownerId}`}, false, NULL, NULL, NULL, NULL)
  `;
  await admin`
    INSERT INTO harness_shared.predicate_watches
      (owner_id, event_key, tool, path, op, once, bound_to)
    VALUES
      (${ownerId}, ${`predicate:bound:${ownerId}`}, 'state:read', 'value', 'exists', false, ${binding}::text::jsonb),
      (${ownerId}, ${`predicate:manual:${ownerId}`}, 'state:read', 'value', 'exists', false, NULL)
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
  await admin.unsafe(readFileSync(MIGRATION_871, 'utf8'));
});
afterAll(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`.catch(() => {});
  await admin`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE 'reap-%'`.catch(() => {});
  await admin`DELETE FROM harness_shared.predicate_watches WHERE owner_id LIKE 'reap-%'`.catch(() => {});
  await fx.dispose();
});
beforeEach(async () => {
  await admin`TRUNCATE harness_shared.coord_presence`;
  await admin`DELETE FROM harness_shared.event_awaits WHERE subscriber_id LIKE 'reap-%'`;
  await admin`DELETE FROM harness_shared.predicate_watches WHERE owner_id LIKE 'reap-%'`;
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
    expect(result).toEqual({ reaped: 0, ownerIds: [], skipped: 0, boundWatchesRetired: 0 });
  });

  it('retires only lifecycle-bound rows before reaping a dead owner', async () => {
    await seedPresence('reap-bound', 2 * 60 * 60);
    await seedBoundAndManualWatches('reap-bound');

    await expect(reapEndedPresenceRows({ ttlMs: TTL })).resolves.toMatchObject({
      reaped: 1,
      ownerIds: ['reap-bound'],
      boundWatchesRetired: 2,
    });

    const awaits = await admin<{ event_key: string; cancelled_at: string | null }[]>`
      SELECT event_key, cancelled_at
        FROM harness_shared.event_awaits
       WHERE subscriber_id = 'reap-bound'
       ORDER BY event_key`;
    expect(awaits).toEqual([
      expect.objectContaining({ event_key: 'fleet:item-completed:reap-bound', cancelled_at: expect.anything() }),
      { event_key: 'manual:reap-bound', cancelled_at: null },
    ]);
    const predicates = await admin<{ event_key: string; active: boolean }[]>`
      SELECT event_key, active
        FROM harness_shared.predicate_watches
       WHERE owner_id = 'reap-bound'
       ORDER BY event_key`;
    expect(predicates).toEqual([
      { event_key: 'predicate:bound:reap-bound', active: false },
      { event_key: 'predicate:manual:reap-bound', active: true },
    ]);
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
