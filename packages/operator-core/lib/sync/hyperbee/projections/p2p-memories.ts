/**
 * Hyperbee → PG projection for `harness_shared.memory_canonical` — SHAREABLE memories
 * federated as first-class Hive state (mem0-cross-machine-federation-2026-07-10,
 * mirroring agent_facts F1-1; D-005 H6, D-006 privacy).
 *
 * Mirrors projections/agent-facts.ts with key differences:
 *
 *   1. Memory identity: (workspace_id, id, source_hive) — keyed by the memory UUID.
 *      SOURCE PARTITIONING (H6): memories are OBSERVATIONS, not consensus. A remote
 *      memory is stored under `source_hive` = the RECEIVER-STAMPED author identity
 *      (provenance.authorPubkey), so every peer's version is stored side-by-side
 *      and can never clobber local (or another peer's) memories.
 *   2. Only SHAREABLE memories federate (mig 562-563 capture triggers fire
 *      WHEN shareable) — a projected remote memory is by construction shareable.
 *
 * LWW applies within one (identity × source) partition via fed_order_key() guard
 * (EI-1698 transitivity-fixed), matching the agent-facts pattern.
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { bumpFederationRefusedOp } from '../federation-refused-op-counter';

/** Wire-shape of a memory row — the federated subset. Defensive on every field. */
export interface MemoryWireRow {
  /** The Hive's home_slug — the per-harness projection guard key. */
  harness_slug: string;
  /** Memory UUID from the source */
  id: string;
  /** The payload JSONB (contains user_id, workspace_id, kind, shareable, etc.) */
  payload: Record<string, unknown>;
  /** ISO timestamps as text on the wire (PG casts on write). */
  created_at: string;
  updated_at: string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isMemoryWireRow(input: unknown): input is MemoryWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.id) || r.id.length === 0) return false;
  if (!isRecord(r.payload)) return false;
  if (!isString(r.created_at)) return false;
  if (!isString(r.updated_at)) return false;
  return true;
}

export interface MemoriesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
}

/** Matches memory_canonical federation identity: workspace_id/id */
function composeKey(row: MemoryWireRow): string {
  return `${row.id}`;
}

function decodeValue(raw: unknown): MemoryWireRow | null {
  return isMemoryWireRow(raw) ? raw : null;
}

/**
 * F1-4 / P-012: record a per-source refused-op counter when a FOREIGN shareable
 * memory op was declined at decode (malformed wire row from a buggy/hostile
 * sender's log). Only REMOTE ops carry an attributable source — a local decode
 * failure is a local bug, not peer spam, so it is not counted.
 */
function onRefusedOp(
  opts: MemoriesProjectionOpts,
  _raw: unknown,
  provenance: ProvenanceContext | undefined,
): Promise<void> | void {
  if (provenance?.origin !== 'remote') return;
  return bumpFederationRefusedOp(
    {
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      sourceHive: provenance.authorPubkey,
      tableTag: 'p2p-memories-by-id',
      reason: 'malformed',
    },
    opts.sql,
  );
}

async function writeToPg(
  opts: MemoriesProjectionOpts,
  row: MemoryWireRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const origin = provenance?.origin ?? 'local';
  // The projection applies LOCAL echoes too (origin 'local' = our own op folding
  // back) — those rows already exist via memory:remember; the source-partitioned
  // upsert below is a no-op refresh for them (source_hive NULL partition).
  const authorPubkey = provenance?.authorPubkey ?? '';
  // H6: receiver-stamped source partition. Remote ⇒ the stamped author key
  // (unforgeable); local ⇒ NULL (the local partition memory:remember owns).
  const sourceHive = origin === 'remote' ? (authorPubkey || 'unknown-remote') : null;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;

  await sql`
    INSERT INTO harness_shared.memory_canonical
      (id, workspace_id, payload, created_at, updated_at, harness_slug,
       author_pubkey, origin, fed_ts, source_hive)
    VALUES
      (${row.id}, ${opts.workspaceId}, ${JSON.stringify(row.payload)}, ${row.created_at}::timestamptz,
       ${row.updated_at}::timestamptz, ${row.harness_slug}, ${authorPubkey}, ${origin},
       ${fedTs}, ${sourceHive})
    ON CONFLICT (workspace_id, id, coalesce(source_hive, ''))
    DO UPDATE SET
      payload       = EXCLUDED.payload,
      updated_at    = EXCLUDED.updated_at,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts
    WHERE harness_shared.fed_order_key(NULL, EXCLUDED.fed_ts)
      >= harness_shared.fed_order_key(NULL, harness_shared.memory_canonical.fed_ts)
  `;
  void fedHlc; // memory_canonical carries no fed_hlc column (wall-clock LWW within a source partition)
}

async function deleteFromPg(
  opts: MemoriesProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const memoryId = key;
  if (!memoryId) return;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  void hlc;
  // A federated delete affects ONLY remote partitions of this identity — a
  // peer's delete must never remove the LOCAL partition (H6 again). Ordered by
  // the same wall-clock guard as the put path. For memories, we mark as deleted
  // by removing the row (no retraction column like agent_facts).
  await sql`
    DELETE FROM harness_shared.memory_canonical
     WHERE workspace_id = ${opts.workspaceId}
       AND id = ${memoryId} AND source_hive IS NOT NULL
       AND (${ts}::bigint IS NULL
         OR harness_shared.fed_order_key(NULL, ${ts}::bigint) >= harness_shared.fed_order_key(NULL, fed_ts))`;
}

/** The registered projection (register-all wires this per booted hive harness). */
export function buildMemoriesProjection(
  opts: MemoriesProjectionOpts,
): TableProjection<MemoryWireRow> {
  return {
    tableTag: 'p2p-memories-by-id',
    // EI-117: CDC-captured table (mig 562-563 triggers) — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    onRefusedOp: (raw, provenance) => onRefusedOp(opts, raw, provenance),
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isMemoryWireRow, onRefusedOp };
