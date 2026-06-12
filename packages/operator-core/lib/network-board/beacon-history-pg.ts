/**
 * beacon-history-pg — PG read/write for the cross_hive_beacon_history table
 * (hive-network-surface-2026-06-11 P-014, item 2, migration 236).
 *
 * Each accepted directory announce that carries a C-2 beacon appends one row,
 * so the tier-4 dossier can show how a foreign hive's status has evolved.
 * Write-path is best-effort (a capture failure must NEVER reject the announce).
 * Read-path is the dossier query `network.hive.beacons`.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import type { HiveStatusBeacon } from '../hive-beacon';

function pg(sql?: Sql): Sql {
  return sql ?? getOrgPg().sql;
}

export interface BeaconSnapshot {
  id: string;
  hiveId: string;
  hivePubkey: string | null;
  beacon: HiveStatusBeacon;
  capturedAt: string;
}

interface BeaconRow {
  id: string;
  hive_id: string;
  hive_pubkey: string | null;
  beacon: unknown;
  captured_at: Date | string;
}

function rowToSnapshot(r: BeaconRow): BeaconSnapshot {
  return {
    id: r.id,
    hiveId: r.hive_id,
    hivePubkey: r.hive_pubkey ?? null,
    beacon: r.beacon as HiveStatusBeacon,
    capturedAt: r.captured_at instanceof Date ? r.captured_at.toISOString() : new Date(r.captured_at).toISOString(),
  };
}

/**
 * Append a beacon snapshot when an announce is accepted. Best-effort — caller
 * catches and warns; the announce is never rejected on a PG error here.
 * Pushes the dossier + board queries after the write (lazy fire-and-forget so
 * the PG seam never statically depends on the SSE layer; a missing bus is a no-op).
 */
export async function captureBeaconSnapshot(
  hiveId: string,
  hivePubkey: string | null,
  beacon: HiveStatusBeacon,
  sql?: Sql,
): Promise<void> {
  // The beacon param goes through as the OBJECT — postgres.js serializes it to
  // JSON once. A pre-stringified value double-encodes (driver stringifies the
  // string again → a jsonb STRING, not an object — the known lanes-jsonb bug
  // class); the integration test pins jsonb_typeof = 'object'.
  await pg(sql).unsafe(
    `INSERT INTO harness_shared.cross_hive_beacon_history (hive_id, hive_pubkey, beacon)
     VALUES ($1, $2, $3::jsonb)`,
    [hiveId, hivePubkey ?? null, beacon as never],
  );
  void import('../sync-sse')
    .then((m) => {
      void m.notifySyncInvalidate('network.hive.beacons').catch(() => {});
      void m.notifySyncInvalidate('network.board').catch(() => {});
    })
    .catch(() => {});
}

/**
 * Read the most-recent beacon snapshots for a hive, newest-first. `hiveKey`
 * accepts either the DiscoveredHive.hiveId or its pubkey-b64 — i.e. the C-3
 * tier-4 row key (`pubkey || hiveId`), so the drill-in dossier can query with
 * the only identity it holds. Returns [] on error (best-effort — the dossier
 * panel renders empty).
 */
export async function listBeaconHistory(
  hiveKey: string,
  limit = 50,
  sql?: Sql,
): Promise<BeaconSnapshot[]> {
  const rows = (await pg(sql).unsafe(
    `SELECT id, hive_id, hive_pubkey, beacon, captured_at
       FROM harness_shared.cross_hive_beacon_history
      WHERE hive_id = $1 OR hive_pubkey = $1
      ORDER BY captured_at DESC
      LIMIT $2`,
    [hiveKey, Math.min(Math.max(1, limit), 500)],
  )) as unknown as BeaconRow[];
  return rows.map(rowToSnapshot);
}
