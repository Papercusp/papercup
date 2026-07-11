/**
 * beacon-history-pg.integration.test.ts — the tier-4 dossier's beacon history
 * (hive-network-surface-2026-06-11 P-014 item 2, migration 236) against real
 * PG. Proves the capture→list round-trip, newest-first ordering, the dual-key
 * read (potId OR pubkey — the C-3 tier-4 row key), per-hive isolation, and
 * the limit clamp.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { HiveStatusBeacon } from '../hive-beacon';
import { captureBeaconSnapshot, listBeaconHistory } from './beacon-history-pg';

// Mirrors migration 236 (minus the psql directives + role grants the test DB lacks).
// Table renamed cross_hive_beacon_history -> cross_pot_beacon_history by migration 557
// (cup-lexicon-full-rename-2026-07-09 P-009); hive_id/hive_pubkey columns deliberately
// left as-is (557 renamed the table but not these columns — see WI-3953's checkpoint).
const BEACON_HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.cross_pot_beacon_history (
    id           uuid        NOT NULL DEFAULT gen_random_uuid(),
    hive_id      text        NOT NULL,
    hive_pubkey  text,
    beacon       jsonb       NOT NULL,
    captured_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT cross_pot_beacon_history_pkey PRIMARY KEY (id),
    CONSTRAINT cross_pot_beacon_history_hive_id_nonempty CHECK (hive_id <> ''))`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('beacon-history');
  await db.sql.unsafe(BEACON_HISTORY_DDL);
});
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.cross_pot_beacon_history`;
});

function beacon(over: Partial<HiveStatusBeacon> = {}): HiveStatusBeacon {
  return { v: 1, liveAgents: 2, queueDepth: 5, focus: 'shipping', lastCompleted: 'X', ts: '2026-06-12T00:00:00.000Z', ...over };
}

describe('captureBeaconSnapshot → listBeaconHistory', () => {
  it('round-trips the jsonb beacon payload with a DB-minted id + capture timestamp', async () => {
    await captureBeaconSnapshot('hid-1', 'pk-1', beacon({ focus: 'first' }), db.sql);
    const rows = await listBeaconHistory('hid-1', 50, db.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].potId).toBe('hid-1');
    expect(rows[0].hivePubkey).toBe('pk-1');
    expect(rows[0].beacon.focus).toBe('first');
    expect(typeof rows[0].capturedAt).toBe('string');
    // Pin single-encoding: the column must hold a jsonb OBJECT, not a
    // double-encoded JSON string (the lanes-jsonb bug class).
    const [t] = await db.sql`
      SELECT jsonb_typeof(beacon) AS t FROM harness_shared.cross_pot_beacon_history LIMIT 1`;
    expect((t as { t: string }).t).toBe('object');
  });

  it('lists newest-first (the dossier reads the evolution backwards)', async () => {
    await captureBeaconSnapshot('hid-1', 'pk-1', beacon({ liveAgents: 1 }), db.sql);
    await db.sql`UPDATE harness_shared.cross_pot_beacon_history SET captured_at = now() - interval '1 hour'`;
    await captureBeaconSnapshot('hid-1', 'pk-1', beacon({ liveAgents: 9 }), db.sql);
    const rows = await listBeaconHistory('hid-1', 50, db.sql);
    expect(rows.map((r) => r.beacon.liveAgents)).toEqual([9, 1]);
  });

  it('reads by EITHER key — potId or pubkey-b64 (whichever the C-3 row carries)', async () => {
    await captureBeaconSnapshot('hid-1', 'pk-1', beacon(), db.sql);
    expect(await listBeaconHistory('hid-1', 50, db.sql)).toHaveLength(1);
    expect(await listBeaconHistory('pk-1', 50, db.sql)).toHaveLength(1);
    expect(await listBeaconHistory('nope', 50, db.sql)).toHaveLength(0);
  });

  it('tolerates a pubkey-less capture (directory entries may lack one) and isolates per hive', async () => {
    await captureBeaconSnapshot('hid-bare', null, beacon(), db.sql);
    await captureBeaconSnapshot('hid-other', 'pk-other', beacon(), db.sql);
    const rows = await listBeaconHistory('hid-bare', 50, db.sql);
    expect(rows).toHaveLength(1);
    expect(rows[0].hivePubkey).toBeNull();
  });

  it('clamps limit to the requested window', async () => {
    for (let i = 0; i < 4; i++) await captureBeaconSnapshot('hid-1', 'pk-1', beacon({ queueDepth: i }), db.sql);
    expect(await listBeaconHistory('hid-1', 2, db.sql)).toHaveLength(2);
  });
});
