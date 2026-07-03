/**
 * Per-source refused-op counters for FEDERATED CONTENT ops
 * (federated-scout-gym-learning-2026-07-02 F1-4 / P-012, review H1/H7).
 *
 * When a receive-side projection DECLINES a foreign content op — a malformed
 * wire row, a non-federatable elite a buggy/hostile sender's log carried, or
 * (later, P-014) an op over a per-source rate cap — we bump a LOCAL counter
 * keyed by the RECEIVER-STAMPED source (`source_hive` = the immutable
 * sourceLogKeyHex of the admitted remote log). "Which peer is sending garbage"
 * then becomes a one-line COUNT — the anti-poisoning observability D-005 asks
 * for, and the twin of the P2P M15 `p2p_refused_op_counters` (mig 468) on the
 * content-federation plane (mig 474).
 *
 * Fires from `applyOpVia`'s decode-refusal branch via the optional
 * `TableProjection.onRefusedOp` hook, so the counting lives with the projection
 * that owns the (workspace, harness) context — while the central apply dispatch
 * stays the single trigger point. LOCAL-ONLY (never federated): each receiver
 * counts what IT refused.
 *
 * FAIL-SOFT by contract: a counter write must NEVER break op apply, so a PG
 * error here is swallowed (logged once), not propagated. Observability is not
 * load-bearing.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { OrgSql } from '../../work-items';

/** Why a federated content op was refused. Bounded, low-cardinality by design. */
export type RefusedOpReason = 'malformed' | 'not-federatable' | 'rate-capped';

export interface BumpRefusedOpArgs {
  /** The receiving operator's workspace partition. */
  workspaceId: string;
  /** The receiving hive HOME slug (the projection's guard key). */
  harnessSlug: string;
  /** Receiver-stamped source-log identity (provenance.authorPubkey for a remote
   *  op). Empty/absent is normalized to 'unknown-remote' (the table forbids ''). */
  sourceHive: string | null | undefined;
  /** The federated content table's projection tableTag (e.g. 'agent-facts-by-key'). */
  tableTag: string;
  /** Why it was refused. */
  reason: RefusedOpReason;
}

/**
 * Bump the per-source refused-op counter by one. Fail-soft — swallows PG errors
 * so a refusal-counting failure can never abort the op-apply loop that called it.
 * Skips silently on an empty workspace/harness/tableTag (nothing to attribute).
 */
export async function bumpFederationRefusedOp(
  args: BumpRefusedOpArgs,
  sqlOverride?: OrgSql,
): Promise<void> {
  const workspaceId = args.workspaceId?.trim();
  const harnessSlug = args.harnessSlug?.trim();
  const tableTag = args.tableTag?.trim();
  if (!workspaceId || !harnessSlug || !tableTag) return;
  // The table's source_hive is NOT NULL / non-empty: a remote op with no
  // resolvable source still attributes to a stable bucket rather than being lost.
  const sourceHive = args.sourceHive?.trim() || 'unknown-remote';
  try {
    const sql = sqlOverride ?? getOrgPg().sql;
    await sql`
      INSERT INTO harness_shared.federation_refused_op_counters
        (workspace_id, harness_slug, source_hive, table_tag, reason, count, updated_at)
      VALUES (${workspaceId}, ${harnessSlug}, ${sourceHive}, ${tableTag}, ${args.reason}, 1, now())
      ON CONFLICT (workspace_id, harness_slug, source_hive, table_tag, reason)
      DO UPDATE SET
        count = harness_shared.federation_refused_op_counters.count + 1,
        updated_at = now()`;
  } catch (err) {
    // Observability is not load-bearing — never break op apply on a counter miss.
    console.warn(
      `[federation-refused-op] counter bump failed (${tableTag}/${args.reason}): ${String(err)}`,
    );
  }
}

/** One counter row as the read surfaces it. */
export interface FederationRefusedOpCounter {
  sourceHive: string;
  tableTag: string;
  reason: string;
  count: number;
}

/**
 * Snapshot the refused-op counters for a (workspace, harness), newest-hottest
 * first. The read for a health / p2p:trace-style observability surface. Returns
 * [] on an empty workspace/harness.
 */
export async function listFederationRefusedOpCounters(
  args: { workspaceId: string | null | undefined; harnessSlug: string },
  sqlOverride?: OrgSql,
): Promise<FederationRefusedOpCounter[]> {
  const workspaceId = args.workspaceId?.trim();
  const harnessSlug = args.harnessSlug?.trim();
  if (!workspaceId || !harnessSlug) return [];
  const sql = sqlOverride ?? getOrgPg().sql;
  const rows = (await sql`
    SELECT source_hive, table_tag, reason, count
      FROM harness_shared.federation_refused_op_counters
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
     ORDER BY count DESC, source_hive ASC`) as unknown as Array<{
    source_hive: string;
    table_tag: string;
    reason: string;
    count: string | number;
  }>;
  return rows.map((r) => ({
    sourceHive: r.source_hive,
    tableTag: r.table_tag,
    reason: r.reason,
    count: Number(r.count),
  }));
}
