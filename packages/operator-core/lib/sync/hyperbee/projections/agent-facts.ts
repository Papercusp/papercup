/**
 * Hyperbee → PG projection for `harness_shared.agent_facts` — SHAREABLE standing
 * facts federated as first-class Hive state
 * (federated-scout-gym-learning-2026-07-02 F1-1; D-005 H6, D-006 privacy).
 *
 * Mirrors projections/hive-settings.ts (the closest analog: a workspace-owned
 * key riding the peer-log), with TWO deliberate differences:
 *
 *   1. SOURCE PARTITIONING (H6): facts are OBSERVATIONS, not consensus. A remote
 *      fact is stored under `source_hive` = the RECEIVER-STAMPED author identity
 *      (`provenance.authorPubkey` — for a remote op this is the immutable
 *      sourceLogKeyHex the receiver stamped, never a sender-claimed field), so
 *      the identity index `(ws, scope, ref, key, source)` keeps every peer's
 *      version side-by-side: a peer can NEVER clobber a local (or another
 *      peer's) fact — including the adversarial negative→positive replacement
 *      the review flagged. Local rows keep `source_hive` NULL.
 *   2. Only SHAREABLE rows ever ride the wire (mig 461/462 capture triggers fire
 *      WHEN shareable) — a projected remote fact is by construction shareable.
 *
 * LWW applies only WITHIN one (identity × source) partition, via the same
 * fed_order_key() guard hive-settings uses (EI-1698 transitivity-fixed).
 */
import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';

/** Wire-shape of an agent_facts row — the federated subset. Defensive on every field. */
export interface AgentFactWireRow {
  /** The Hive's home_slug — the per-harness projection guard key. */
  harness_slug: string;
  scope: string;
  scope_ref: string | null;
  key: string;
  body: string;
  source_ref: string | null;
  /** ISO timestamps as text on the wire (PG casts on write). */
  expires_at: string;
  retracted_at: string | null;
  created_by: string;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

const FACT_SCOPES = ['workspace', 'role', 'owner', 'harness', 'work_item'];

export function isAgentFactWireRow(input: unknown): input is AgentFactWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.scope) || !FACT_SCOPES.includes(r.scope)) return false;
  if (!isStringOrNull(r.scope_ref)) return false;
  if (!isString(r.key) || r.key.length === 0 || r.key.length > 120) return false;
  if (!isString(r.body) || r.body.length === 0 || r.body.length > 500) return false;
  if (!isStringOrNull(r.source_ref)) return false;
  if (!isString(r.expires_at)) return false;
  if (!isStringOrNull(r.retracted_at)) return false;
  if (!isString(r.created_by)) return false;
  return true;
}

export interface AgentFactsProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
}

/** Matches mig 462's generated fed_key: scope/coalesce(ref,'')/key. */
function composeKey(row: AgentFactWireRow): string {
  return `${row.scope}/${row.scope_ref ?? ''}/${row.key}`;
}

function decodeValue(raw: unknown): AgentFactWireRow | null {
  return isAgentFactWireRow(raw) ? raw : null;
}

async function writeToPg(
  opts: AgentFactsProjectionOpts,
  row: AgentFactWireRow,
  provenance?: ProvenanceContext,
): Promise<void> {
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const origin = provenance?.origin ?? 'local';
  // The projection applies LOCAL echoes too (origin 'local' = our own op folding
  // back) — those rows already exist via assertFact; the source-partitioned
  // upsert below is a no-op refresh for them (source_hive NULL partition).
  const authorPubkey = provenance?.authorPubkey ?? '';
  // H6: receiver-stamped source partition. Remote ⇒ the stamped author key
  // (unforgeable); local ⇒ NULL (the local partition assertFact owns).
  const sourceHive = origin === 'remote' ? (authorPubkey || 'unknown-remote') : null;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;
  await sql`
    INSERT INTO harness_shared.agent_facts
      (workspace_id, harness_slug, scope, scope_ref, key, body, source_ref,
       created_by, expires_at, retracted_at, shareable,
       author_pubkey, origin, fed_ts, source_hive)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.scope}, ${row.scope_ref},
       ${row.key}, ${row.body}, ${row.source_ref}, ${row.created_by},
       ${row.expires_at}::timestamptz, ${row.retracted_at}::timestamptz, true,
       ${authorPubkey}, ${origin}, ${fedTs}, ${sourceHive})
    ON CONFLICT (workspace_id, scope, coalesce(scope_ref, ''), key, coalesce(source_hive, ''))
    DO UPDATE SET
      body          = EXCLUDED.body,
      source_ref    = EXCLUDED.source_ref,
      expires_at    = EXCLUDED.expires_at,
      retracted_at  = EXCLUDED.retracted_at,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      updated_at    = now()
    WHERE harness_shared.fed_order_key(NULL, EXCLUDED.fed_ts)
      >= harness_shared.fed_order_key(NULL, harness_shared.agent_facts.fed_ts)
  `;
  void fedHlc; // agent_facts carries no fed_hlc column (wall-clock LWW within a source partition)
}

async function deleteFromPg(
  opts: AgentFactsProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const [scope, scopeRef, factKey] = key.split('/');
  if (!scope || factKey === undefined) return;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  void hlc;
  // A federated delete retracts ONLY remote partitions of this identity — a
  // peer's delete must never remove the LOCAL partition (H6 again). Ordered by
  // the same wall-clock guard as the put path.
  await sql`
    UPDATE harness_shared.agent_facts SET retracted_at = now()
     WHERE workspace_id = ${opts.workspaceId}
       AND scope = ${scope} AND coalesce(scope_ref,'') = ${scopeRef ?? ''}
       AND key = ${factKey} AND source_hive IS NOT NULL
       AND (${ts}::bigint IS NULL
         OR harness_shared.fed_order_key(NULL, ${ts}::bigint) >= harness_shared.fed_order_key(NULL, fed_ts))`;
}

/** The registered projection (register-all wires this per booted hive harness). */
export function buildAgentFactsProjection(
  opts: AgentFactsProjectionOpts,
): TableProjection<AgentFactWireRow> {
  return {
    tableTag: 'agent-facts-by-key',
    // EI-117: CDC-captured table (mig 461/462 triggers) — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isAgentFactWireRow };
