/**
 * The idempotency ledger (D-007) — `harness_shared.event_reactions` (migration
 * 153). The Papercusp PG impl of the generic `@papercusp/event-reaction`
 * `ReactionStore`. The durable fire step CLAIMS a dedup id before dispatching; a
 * re-delivery finds the claim and skips. On dispatch failure the claim is
 * released so a retry can re-fire.
 */

import { getOrgPg } from '@papercusp/db-org';
import type { ReactionClaim } from '@papercusp/event-reaction';

export type { ReactionClaim };

/**
 * Atomically claim a reaction's dedup id. Returns true if THIS call won the claim
 * (the reaction should proceed to dispatch), false if it was already claimed (a
 * re-delivery — skip; "a double-fire is a no-op", D-007).
 */
export async function claimReaction(claim: ReactionClaim): Promise<boolean> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ dedup_id: string }>>`
    INSERT INTO harness_shared.event_reactions
      (dedup_id, workspace_id, rule_id, fire, trigger_tool, cause_root_run_id, depth, status, contributor)
    VALUES (
      ${claim.dedupId}, ${claim.workspaceId}, ${claim.ruleId}, ${claim.fire},
      ${claim.triggerTool ?? null}, ${claim.causeRootRunId ?? null}, ${claim.depth}, 'fired',
      ${claim.contributor ?? null}
    )
    ON CONFLICT (dedup_id) DO NOTHING
    RETURNING dedup_id
  `;
  return rows.length > 0;
}

/** Release a claim (delete the row) so a retry can re-fire after a dispatch failure. */
export async function releaseReaction(dedupId: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`DELETE FROM harness_shared.event_reactions WHERE dedup_id = ${dedupId}`;
}

/** Mark a claimed reaction failed (kept for inspection — only when NOT retrying). */
export async function markReactionFailed(dedupId: string, error: string): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    UPDATE harness_shared.event_reactions
       SET status = 'failed', error_message = ${error}
     WHERE dedup_id = ${dedupId}
  `;
}
