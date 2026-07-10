/**
 * context-pressure.ts — the coarse per-member context-pressure BUCKET
 * (fleet-deltas-leader-primitives-2026-07-10 P-007).
 *
 * A leader watching a fleet needs "who is about to compact / already over"
 * WITHOUT reading raw tokens off every member — the same three-way judgment
 * the ambient context gauge (agent-managed-compaction D-009 / P-013) already
 * makes per-caller. Reuse-first: this is a THIN reduction of the SAME
 * `contextGaugeBand` thresholds (inbox-context-usage.ts, the one definition
 * the client hook + statusline gauge already band on) to a coarser 3-state
 * shape a fleet roster / monitor delta can carry as one short string:
 *
 *   ok       — below the LOUD band (untracked, or comfortably under limit).
 *   high     — at/above LOUD (≥80% of the soft limit): should wrap up soon.
 *   critical — at/above CRITICAL (≥90% of the soft limit): should compact now.
 *
 * `null` (not one of the three buckets) means UNKNOWN — no compactionLimit /
 * contextTokens tracked for this owner yet (an untracked owner, a federated
 * peer, or a CLI this system doesn't estimate for — mirrors the nullable
 * `sessionState`/`wakeable` liveness fields, never coerced to 'ok').
 *
 * `deriveContextPressure` is PURE (unit-testable with no PG); `fetchContextPressure`
 * is the IO seam — ONE batch query keyed by the roster's ownerIds, the same
 * per-owner enrichment shape as `fetchPresenceFleet` / `fetchWakeability`, so
 * enriching N agents is a constant read, not N.
 */
import { getOrgPg } from '@papercusp/db-org';
import { contextGaugeBand, contextUsagePct } from './tools/inbox-context-usage';

export type ContextPressureBucket = 'ok' | 'high' | 'critical';

/**
 * PURE: reduce (contextTokens, compactionLimit) to the coarse 3-state bucket.
 * null when usage can't be computed (no limit set / no estimate yet) — an
 * honest "unknown", never defaulted to 'ok'.
 */
export function deriveContextPressure(
  contextTokens: number | null | undefined,
  compactionLimit: number | null | undefined,
): ContextPressureBucket | null {
  const pct = contextUsagePct(contextTokens, compactionLimit);
  if (pct == null) return null;
  const band = contextGaugeBand(pct);
  if (band == null || band === 'quiet') return 'ok'; // below LOUD — not yet actionable pressure
  if (band === 'loud') return 'high';
  return 'critical';
}

/**
 * IO seam: batch-read context pressure for a set of ownerIds. ownerIds should be
 * the LOCAL roster (a federated `fed:…` id never matches a local coord_presence
 * row, so passing them just wastes a comparison). Only owners with a resolvable
 * bucket (a non-null derivation) come back — an untracked owner is simply absent
 * from the map, mirroring `fetchPresenceFleet`'s "absent ⇒ default" contract.
 */
export async function fetchContextPressure(
  ownerIds: string[],
): Promise<Map<string, ContextPressureBucket>> {
  const out = new Map<string, ContextPressureBucket>();
  if (ownerIds.length === 0) return out;
  const { sql } = getOrgPg();
  const rows = await sql<{ owner_id: string; context_tokens: number | null; compaction_limit: number | null }[]>`
    SELECT owner_id, context_tokens, compaction_limit
      FROM harness_shared.coord_presence
     WHERE owner_id = ANY(${ownerIds}::text[])
  `;
  for (const r of rows) {
    const bucket = deriveContextPressure(r.context_tokens, r.compaction_limit);
    if (bucket != null) out.set(r.owner_id, bucket);
  }
  return out;
}
