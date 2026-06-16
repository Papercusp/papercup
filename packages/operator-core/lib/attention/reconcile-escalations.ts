/**
 * reconcile-escalations — the attention-queue reconciliation sweep
 * (queue-pending-accuracy-and-drift P-003/P-005, D-002/D-003).
 *
 * The drift it kills: OPERATIONAL escalations (placement-watchdog cursed
 * placements, aging sweeps — `from: system[:…]`, no options) are emitted en
 * masse and almost never resolved (live: ~7000 opened, ~135 resolved), so they
 * accumulate forever. The reader already DEMOTES them out of "waiting on you"
 * (isOperationalEscalation → alert tier), but they still pile up in the alert
 * list. This sweep auto-resolves the stale ones so the queue stays a projection
 * of live reality WITHOUT relying on any agent remembering to resolve them.
 *
 * Why a TTL and not a per-unit liveness check: an operational escalation is a
 * redundant duplicate of a DERIVED health metric (`placements.cursed`) — that
 * metric, not the escalation, is the source of truth for current state (D-003).
 * So an operational escalation idle past the TTL is, by construction, stale: the
 * live state is still shown by the metric; the escalation is just un-GC'd noise.
 *
 * GENUINE human decisions (non-system sender, or carrying options) are NEVER
 * selected — a human must clear those (that is what `coord:resolve` is for).
 */

import { isOperationalEscalation } from './adapters';
import { listEscalations, resolveEscalation } from '../agent-tools/coordination/escalations';

/** Resolver identity stamped on auto-reconciled escalations (audit trail). */
export const RECONCILE_OWNER = 'system:attention-reconcile';

/** Default TTL for OPERATIONAL escalations: 3 days. Override via env. */
export const OPERATIONAL_ESCALATION_TTL_MS = (() => {
  const env = Number(process.env.PAPERCUSP_OPERATIONAL_ESCALATION_TTL_MS);
  return Number.isFinite(env) && env > 0 ? env : 3 * 24 * 60 * 60 * 1000;
})();

/** Max escalations resolved per sweep tick — drains a large backlog over several
 *  ticks instead of one giant coord-log write burst. */
export const RECONCILE_BATCH_LIMIT = 500;

export interface StaleEscalationInput {
  msg_id: string;
  from?: string | null;
  options?: readonly unknown[];
  /** ISO timestamp the escalation was opened. */
  ts: string;
}

export interface StaleEscalation {
  msg_id: string;
  ageDays: number;
}

/**
 * PURE: which OPEN escalations are stale (auto-resolvable) — operational
 * (system sender, no options) AND opened older than `ttlMs`. Sorted oldest
 * first so a batch-limited sweep drains the longest-stale first.
 */
export function selectStaleEscalations(
  opens: readonly StaleEscalationInput[],
  ctx: { nowMs: number; ttlMs?: number },
): StaleEscalation[] {
  const ttl = ctx.ttlMs ?? OPERATIONAL_ESCALATION_TTL_MS;
  const out: StaleEscalation[] = [];
  for (const e of opens) {
    if (!isOperationalEscalation(e.from, (e.options?.length ?? 0) > 0)) continue;
    const openedMs = Date.parse(e.ts);
    if (!Number.isFinite(openedMs)) continue;
    const ageMs = ctx.nowMs - openedMs;
    if (ageMs >= ttl) out.push({ msg_id: e.msg_id, ageDays: ageMs / 86_400_000 });
  }
  out.sort((a, b) => b.ageDays - a.ageDays);
  return out;
}

export interface ReconcileResult {
  scanned: number;
  stale: number;
  resolved: number;
  /** True when the backlog exceeded the batch limit (more remain for next tick). */
  truncated: boolean;
}

/**
 * One reconciliation pass: load open escalations, resolve the stale operational
 * ones (up to the batch limit). Idempotent — an already-resolved escalation is a
 * no-op, so re-running is safe.
 */
export async function reconcileStaleEscalationsOnce(
  opts: { nowMs?: number; ttlMs?: number; limit?: number } = {},
): Promise<ReconcileResult> {
  const opens = (await listEscalations({ status: 'open' })) as unknown as StaleEscalationInput[];
  const nowMs = opts.nowMs ?? Date.now();
  const stale = selectStaleEscalations(opens, { nowMs, ttlMs: opts.ttlMs });
  const limit = opts.limit ?? RECONCILE_BATCH_LIMIT;
  const batch = stale.slice(0, limit);

  let resolved = 0;
  for (const s of batch) {
    const r = await resolveEscalation({
      msg_id: s.msg_id,
      choice: 'auto-reconciled',
      resolver: RECONCILE_OWNER,
      note: `auto-resolved: operational escalation idle ${Math.round(s.ageDays)}d — live state is the derived health metric (queue-pending-accuracy P-003/P-005)`,
    });
    if (r !== 'not_found' && r !== 'already_resolved' && r !== 'requires_spawn_approve') resolved += 1;
  }

  return { scanned: opens.length, stale: stale.length, resolved, truncated: stale.length > batch.length };
}
