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

/**
 * Record a reaction that FAILED, whether or not it ever claimed a row (P-030 b).
 *
 * `markReactionFailed` UPDATEs, so it can only annotate a row the DURABLE path
 * already claimed — and the durable path is off by default
 * (`PAPERCUSP_DBOS_REACTIONS`). The live in-process route never touches this
 * table at all, so a failed fire there left NO durable trace: `status='failed'`
 * and `error_message` were written by nobody on the default path and read by
 * nobody anywhere. This is the upsert that makes the ledger true for BOTH routes.
 *
 * `contributor` is what makes the row answerable: it attributes the failure to
 * the identity/plugin/blueprint that contributed the rule, so an owner alert can
 * name a culprit and a per-contributor budget has a key to count.
 *
 * ON CONFLICT updates deliberately: `'fired'` means "claimed, presumed to be
 * dispatching", never "succeeded", so replacing it with observed failure is a
 * correction, not a loss.
 */
export async function recordReactionFailure(opts: {
  dedupId: string;
  workspaceId: string;
  ruleId: string;
  fire: string;
  error: string;
  triggerTool?: string | null;
  causeRootRunId?: string | null;
  depth?: number;
  contributor?: string | null;
}): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.event_reactions
      (dedup_id, workspace_id, rule_id, fire, trigger_tool, cause_root_run_id, depth, status, error_message, contributor)
    VALUES (
      ${opts.dedupId}, ${opts.workspaceId}, ${opts.ruleId}, ${opts.fire},
      ${opts.triggerTool ?? null}, ${opts.causeRootRunId ?? null}, ${opts.depth ?? 0},
      'failed', ${opts.error}, ${opts.contributor ?? null}
    )
    ON CONFLICT (dedup_id) DO UPDATE
      SET status = 'failed',
          error_message = EXCLUDED.error_message,
          contributor = COALESCE(EXCLUDED.contributor, harness_shared.event_reactions.contributor)
  `;
}

/**
 * How many failures this contributor has already recorded for `(ruleId)` inside
 * `windowMinutes` — the debounce input for the owner alert.
 *
 * Deliberately a LEDGER read, not an in-process cache: a rule that fails on every
 * tool call would otherwise alert thousands of times, and an in-memory window
 * resets on every restart (of which this box has many), which is exactly when a
 * broken rule would re-spam. Served by 1169's partial index on
 * `(workspace_id, contributor, fired_at DESC)`.
 */
export async function countRecentReactionFailures(opts: {
  workspaceId: string;
  ruleId: string;
  contributor?: string | null;
  windowMinutes: number;
  /** Exclude the row just written, so a caller counts PRIOR failures only. */
  excludeDedupId?: string;
}): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ n: string }>>`
    SELECT count(*)::text AS n
      FROM harness_shared.event_reactions
     WHERE workspace_id = ${opts.workspaceId}
       AND rule_id = ${opts.ruleId}
       AND status = 'failed'
       AND contributor IS NOT DISTINCT FROM ${opts.contributor ?? null}
       AND fired_at > now() - make_interval(mins => ${opts.windowMinutes})
       AND dedup_id <> ${opts.excludeDedupId ?? ''}
  `;
  return Number(rows[0]?.n ?? '0');
}
