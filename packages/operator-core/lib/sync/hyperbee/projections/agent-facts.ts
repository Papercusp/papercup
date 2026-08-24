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
import { bumpFederationRefusedOp } from '../federation-refused-op-counter';

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
  /** Migration 801: deliberate retraction audit metadata. Optional for older ops. */
  retracted_by?: string | null;
  retraction_reason?: string | null;
  created_by: string;
  /** mig 574 (audience-scoped facts): the author's delivery-audience constraint
   *  (v1 grammar 'fleet:<slug>'). Carried so a receiving peer HONORS the
   *  restriction in its own folds (fold-relevance, not secrecy — facts:list
   *  shows it everywhere); an unresolvable audience on the receiver folds to no
   *  one, which is the safe direction. OPTIONAL on the wire — pre-574 history
   *  ops lack it (absent ⇒ NULL). */
  audience_scope?: string | null;
  /** mig 574: the platform-verified provenance stamp for source_ref (opaque
   *  jsonb, passed through like gym's outcome_record). Sender-attested — same
   *  trust level as body. OPTIONAL on the wire — pre-574 history ops lack it. */
  source_provenance?: Record<string, unknown> | null;
  /** mig 795: moving-subject snapshot metadata. Optional so pre-795 ops remain valid. */
  measurement?: Record<string, unknown> | null;
  /** mig 940: repeatable verification + concrete disproof pair. */
  recheck?: { probe: string; falsifier: string } | null;
  /** mig 671 (WI-6052): evidence-strength tier ('verified'|'provisional'|
   *  'suspected'). CONTENT, same as audience_scope/source_provenance — a
   *  receiving peer must see the sender's own stated confidence, never
   *  upgrade it. OPTIONAL on the wire — pre-671 history ops lack it (absent
   *  ⇒ NULL, the legacy/unbadged shape). */
  confidence?: string | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

const FACT_SCOPES = ['workspace', 'role', 'owner', 'harness', 'work_item'];
// mig 671 (WI-6052): mirrors store.ts's FACT_CONFIDENCE_LEVELS, replicated
// locally rather than imported — same style already used for FACT_SCOPES
// above, keeping this wire-validation module dependency-free of the store.
const FACT_CONFIDENCES = ['verified', 'provisional', 'suspected'];
const FACT_RECHECK_FIELD_MAX_CHARS = 500;

function isFactRecheck(v: unknown): v is { probe: string; falsifier: string } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  return (
    keys.length === 2 &&
    keys[0] === 'falsifier' &&
    keys[1] === 'probe' &&
    typeof r.probe === 'string' &&
    r.probe.trim().length > 0 &&
    r.probe.trim().length <= FACT_RECHECK_FIELD_MAX_CHARS &&
    typeof r.falsifier === 'string' &&
    r.falsifier.trim().length > 0 &&
    r.falsifier.trim().length <= FACT_RECHECK_FIELD_MAX_CHARS
  );
}

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
  if (r.retracted_by !== undefined && !isStringOrNull(r.retracted_by)) return false;
  if (r.retraction_reason !== undefined && !isStringOrNull(r.retraction_reason)) return false;
  if (!isString(r.created_by)) return false;
  // mig 574 additions — optional (pre-574 history ops omit them), but when
  // present they must be well-typed or the op is refused as malformed.
  if (r.audience_scope !== undefined && !isStringOrNull(r.audience_scope)) return false;
  if (
    r.source_provenance !== undefined &&
    r.source_provenance !== null &&
    (typeof r.source_provenance !== 'object' || Array.isArray(r.source_provenance))
  )
    return false;
  if (r.measurement !== undefined) {
    if (r.measurement !== null && (typeof r.measurement !== 'object' || Array.isArray(r.measurement))) return false;
    if (r.measurement !== null) {
      const m = r.measurement as Record<string, unknown>;
      if (m.subjectVolatile !== true || typeof m.measuredAt !== 'string' || !m.measuredAt) return false;
    }
  }
  if (r.recheck !== undefined && r.recheck !== null && !isFactRecheck(r.recheck)) return false;
  // mig 671 (WI-6052) — optional (pre-671 history ops omit it), but when
  // present must be a recognized string tier or the op is malformed (never
  // trust an arbitrary sender-supplied value into the confidence dimension).
  if (r.confidence !== undefined) {
    if (!isStringOrNull(r.confidence)) return false;
    if (r.confidence !== null && !FACT_CONFIDENCES.includes(r.confidence)) return false;
  }
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

/**
 * F1-4 / P-012: record a per-source refused-op counter when a FOREIGN shareable
 * fact op was declined at decode (a malformed wire row from a buggy/hostile
 * sender's log). Only REMOTE ops carry an attributable source — a local decode
 * failure is a local bug, not a peer's spam, so it is not counted. Fail-soft via
 * the counter fn.
 */
function onRefusedOp(
  opts: AgentFactsProjectionOpts,
  _raw: unknown,
  provenance: ProvenanceContext | undefined,
): Promise<void> | void {
  if (provenance?.origin !== 'remote') return;
  return bumpFederationRefusedOp(
    {
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      sourceHive: provenance.authorPubkey,
      tableTag: 'agent-facts-by-key',
      reason: 'malformed',
    },
    opts.sql,
  );
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
  // mig 574 columns — absent on pre-574 wire ops ⇒ NULL. source_provenance is
  // jsonb: bind via the canonical `${json-string}::text::jsonb` form (see the
  // postgres-js-jsonb-binding agent-insight); NULL passes through the casts.
  const audienceScope = row.audience_scope ?? null;
  const sourceProvenance = row.source_provenance != null ? JSON.stringify(row.source_provenance) : null;
  const measurement = row.measurement != null ? JSON.stringify(row.measurement) : null;
  const recheck = row.recheck != null ? JSON.stringify(row.recheck) : null;
  const confidence = row.confidence ?? null;
  const retractedBy = row.retracted_by ?? null;
  const retractionReason = row.retraction_reason ?? null;
  await sql`
    INSERT INTO harness_shared.agent_facts
      (workspace_id, harness_slug, scope, scope_ref, key, body, source_ref,
       created_by, expires_at, retracted_at, retracted_by, retraction_reason, shareable,
       author_pubkey, origin, fed_ts, source_hive, audience_scope, source_provenance, measurement, recheck, confidence)
    VALUES
      (${opts.workspaceId}, ${row.harness_slug}, ${row.scope}, ${row.scope_ref},
       ${row.key}, ${row.body}, ${row.source_ref}, ${row.created_by},
       ${row.expires_at}::timestamptz, ${row.retracted_at}::timestamptz,
       ${retractedBy}, ${retractionReason}, true,
       ${authorPubkey}, ${origin}, ${fedTs}, ${sourceHive},
       ${audienceScope}, ${sourceProvenance}::text::jsonb, ${measurement}::text::jsonb, ${recheck}::text::jsonb, ${confidence})
    -- ⚠ P-008 (a) / migration 689: the identity index is now PARTIAL
    -- (agent_facts_identity_current ... WHERE superseded_at IS NULL), and an
    -- ON CONFLICT inference spec that omits the predicate matches NO index —
    -- failing at PLAN time, on every write, not only on conflicts. This table
    -- was broken exactly that way once before (mig 461 widened the identity and
    -- the stale 4-column spec zeroed out fact writes until it was caught).
    --
    -- A federated row is deliberately NOT append-versioned: it is a remote
    -- peer's CURRENT observation, already last-write-wins by fed_ts and never
    -- the target of a local D-003 pointer, so versioning it would multiply rows
    -- by peer × revision for no reader. It stays an in-place upsert of the live
    -- row; it only has to name the new predicate.
    ON CONFLICT (workspace_id, scope, coalesce(scope_ref, ''), key, coalesce(source_hive, ''))
      WHERE superseded_at IS NULL
    DO UPDATE SET
      body          = EXCLUDED.body,
      source_ref    = EXCLUDED.source_ref,
      expires_at    = EXCLUDED.expires_at,
      retracted_at  = EXCLUDED.retracted_at,
      retracted_by  = EXCLUDED.retracted_by,
      retraction_reason = EXCLUDED.retraction_reason,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      audience_scope    = EXCLUDED.audience_scope,
      source_provenance = EXCLUDED.source_provenance,
      measurement       = EXCLUDED.measurement,
      recheck           = EXCLUDED.recheck,
      confidence        = EXCLUDED.confidence,
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
       -- P-008 (a): the live remote version only; a superseded row is history.
       AND superseded_at IS NULL
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
    onRefusedOp: (raw, provenance) => onRefusedOp(opts, raw, provenance),
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isAgentFactWireRow, onRefusedOp };
