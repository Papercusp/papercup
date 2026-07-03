/**
 * Elite federation SEND seam — the WI-1564-guarded writer that stamps a local QD
 * archive elite `federatable` so it rides the peer-log
 * (federated-scout-gym-learning-2026-07-02 F1-4 / P-012, review H1/H7).
 *
 * The TWIN of {@link import('../../agent-facts/store').assertFact}'s shareable-fact
 * guard, on the elite side: both writers resolve their federation workspace
 * through the SAME {@link resolveFederationWorkspace} helper so they strand-or-
 * federate IDENTICALLY. A `federatable=true` stamp under the non-federating
 * coordination/'*' partition would fire mig 464's capture trigger but route
 * nowhere — the row is captured-then-stranded on every peer (the WI-1564 strand
 * class, the writer-side twin of the harness_slug drop D-007 fixed). So we REFUSE
 * LOUDLY rather than silently strand.
 *
 * Eligibility is the D-002 rule ({@link federatableElite}: outcome=won OR
 * grade>=4). A non-eligible elite is simply not stamped (no-op) — never an error.
 *
 * This is the guarded seam the gym accept / champion path calls to publish an
 * eligible elite (mig 464 comment). It stamps ONLY the LOCAL archive row
 * (`source_hive IS NULL`) — a receiver's foreign-elite rows live in
 * `gym_qd_foreign_elites` and are never re-federated.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { resolveFederationWorkspace, federatableElite } from '../../agent-facts/store';

export interface MarkEliteFederatableArgs {
  /** The operator workspace the local archive row lives in. */
  workspaceId: string;
  /** The Hive HOME slug the elite federates under (the archive row's harness_slug). */
  harnessSlug: string;
  /** The niche key identifying the local archive elite to publish. */
  nicheKey: string;
  /** D-002 eligibility inputs — outcome-verified or strongly graded only. */
  eligibility: { outcome?: string | null; grade?: number | null };
}

export interface MarkEliteFederatableResult {
  /** Whether the elite is now stamped federatable (rode the trigger). */
  federatable: boolean;
  /** 'stamped' | 'not-eligible' | 'no-row' — why the result is what it is. */
  reason: 'stamped' | 'not-eligible' | 'no-row';
}

/**
 * Stamp a local QD-archive elite `federatable` so it federates — guarded so an
 * eligible elite can NEVER strand under a non-federating workspace (WI-1564).
 *
 * - Not eligible (D-002) ⇒ no-op, `{ federatable:false, reason:'not-eligible' }`.
 * - Eligible but the workspace does not federate ⇒ THROWS (loud refuse — the
 *   strand combo), mirroring assertFact.
 * - Eligible + federating workspace ⇒ `UPDATE ... SET federatable = true` on the
 *   LOCAL row; `{ federatable:true, reason:'stamped' }` (or 'no-row' if the niche
 *   has no local elite).
 */
export async function markEliteFederatable(
  args: MarkEliteFederatableArgs,
  inject?: Sql,
): Promise<MarkEliteFederatableResult> {
  if (!federatableElite(args.eligibility)) {
    return { federatable: false, reason: 'not-eligible' };
  }
  // WI-1564: an eligible elite stamped federatable in the coordination/'*'
  // partition captures (mig 464) then strands — refuse LOUDLY, the exact twin of
  // assertFact's shareable-fact guard.
  if (!resolveFederationWorkspace(args.workspaceId)) {
    throw new Error(
      `markEliteFederatable — an eligible elite cannot federate from the '${args.workspaceId}' ` +
        `workspace partition (WI-1564): the coordination/'*' partition never federates, so the ` +
        `elite would be captured then stranded on every peer. Publish from a hive-scoped workspace.`,
    );
  }
  const sql = inject ?? getOrgPg().sql;
  // LOCAL row only (source_hive IS NULL): you federate YOUR OWN elite. Foreign
  // rows are received into gym_qd_foreign_elites and never re-published.
  const rows = (await sql`
    UPDATE harness_shared.gym_qd_archive
       SET federatable = true
     WHERE workspace_id = ${args.workspaceId}
       AND harness_slug = ${args.harnessSlug}
       AND niche_key = ${args.nicheKey}
       AND source_hive IS NULL
    RETURNING niche_key`) as unknown as Array<{ niche_key: string }>;
  const stamped = Array.isArray(rows) && rows.length > 0;
  return { federatable: stamped, reason: stamped ? 'stamped' : 'no-row' };
}
