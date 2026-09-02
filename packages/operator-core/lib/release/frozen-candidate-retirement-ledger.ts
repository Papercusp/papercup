/**
 * WI-2141736 Layer 3: durable, bounded record of a frozen candidate RETIRED for measured
 * dispatch-infeasibility (the `decideFrozenRepairDispatchInfeasible` recut-at-tip outcome —
 * `frozen-candidate-repair-queue.ts`) — the branch that falls through to actually run the
 * checkpoint against a fresh candidate, so the retirement itself never becomes THIS tick's
 * verdict/summary and previously left no trace once the run's own log line scrolled away.
 *
 * Root of the item: freeze-and-converge (RELEASE_FREEZE_AND_CONVERGE_DEFAULT, P-013 / D-007)
 * was silently off fleet-wide for a full day, and the only evidence was grepping raw run logs
 * (WI-2141736's own filing). This mirrors `frozen-candidate-escape-ledger.ts`'s established
 * idiom exactly — `gate_health.candidateEscapes` on the same green-checkpoint routine row — so
 * "was the freeze just dissolved, and why" becomes a queryable field
 * (`gate_health.frozenCandidateRetirements`) instead of log-archaeology, without adding a new
 * write path or read surface for `gate_health` itself.
 *
 * WHY ITS OWN MODULE (not release-actions.ts, not frozen-candidate-escape-ledger.ts): same
 * reason the escape ledger split out — release-actions registers system actions at module
 * scope, and this surface is also needed by the gate engine's deps wiring, which should not
 * import that side effect. Kept separate from the escape ledger because a RETIREMENT
 * (dispatch-infeasible; no fixer can be dispatched at all, unrelated to the escape budget) and
 * an ESCAPE (an exhausted-pin recut spending the owner-ratified daily budget) are distinct
 * exhaustion classes with independent bookkeeping — conflating them into one array would make
 * `readRecentFrozenCandidateEscapes`'s budget window silently start counting a different kind
 * of event than the one P-008 ratified.
 */
import type { GateVerdictTarget } from './gate-verdict-target';

/** One retirement: a frozen candidate abandoned because no fixer could be dispatched at all. */
export interface FrozenCandidateRetirementRecord {
  /** When the retirement happened (epoch ms). */
  atMs: number;
  /** The frozen candidate sha that was abandoned. */
  abandonedCandidate: string;
  /** The repair head the abandoned queue had reached. */
  repairHead: string;
  /** The infeasibility class that triggered the retirement (e.g. 'dispatch-infeasible'). */
  reason: string;
  /** How many fixer attempts the abandoned queue had made (0 for this outcome, by construction). */
  attempts: number;
  /** How long the queue had been open, in ms, at the moment it was retired. */
  ageMs: number;
}

/** Bounded history: enough to audit several recent retirements without unbounded growth. */
export const FROZEN_REPAIR_RETIREMENT_HISTORY_CAP = 10;

/**
 * Durably record a retired frozen candidate, newest-first, trimmed to the history cap — ONE
 * statement. Best-effort by design (see the caller): a failed record must never block the
 * retirement itself or turn an observability gap into a functional one.
 */
export async function recordFrozenCandidateRetirement(
  target: GateVerdictTarget,
  entry: FrozenCandidateRetirementRecord,
): Promise<void> {
  const { getOrgPg } = await import('@papercusp/db-org');
  const { sql } = getOrgPg();
  await sql.unsafe(
    `UPDATE harness_shared.routines
        SET metadata = jsonb_set(
              jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{gate_health}',
                COALESCE(metadata->'gate_health', '{}'::jsonb),
                true
              ),
              '{gate_health,frozenCandidateRetirements}',
              (SELECT COALESCE(jsonb_agg(t.val ORDER BY t.ord), '[]'::jsonb)
                 FROM (SELECT val, ord
                         FROM jsonb_array_elements(
                                $3::jsonb || COALESCE(metadata->'gate_health'->'frozenCandidateRetirements', '[]'::jsonb)
                              ) WITH ORDINALITY AS x(val, ord)
                        ORDER BY ord
                        LIMIT ${FROZEN_REPAIR_RETIREMENT_HISTORY_CAP}) t),
              true
            ),
            updated_at = now()
      WHERE workspace_id = $1
        AND install_slug = $2
        AND target_role = 'system:green-checkpoint'`,
    [target.workspaceId, target.installSlug, JSON.stringify([entry])],
  );
}
