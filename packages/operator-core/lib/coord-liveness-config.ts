/**
 * Coordination liveness / reclaim config (live-configurability-audit-2026-06-20 P-014, expose).
 *
 * One shared operator-state row (operator_coord_liveness_config) holding OVERRIDES for the three
 * P-014 concerns — each an override over the consumer's existing default, threaded into the PERIODIC
 * routine that calls the (already override-accepting) pure fn:
 *   - reclaimGraceMs / reclaimRequeueCap → reclaimStaleWorkItemClaims (dbos/in-process-periodic)
 *   - handoffTtlMs                        → findStaleHandoffs (reconcile-handoffs)        [tool TBD]
 *   - sessionReaperGraceMs                → planIdleSessionReap (idle-session-reaper)      [tool TBD]
 *
 * The consumers are periodic routines (NOT hot paths), so a plain async read at the call site is fine
 * — no sync-cache. An absent field ⇒ the consumer's baked default ⇒ byte-identical. Registers a
 * runtime-config override concern.
 */
import { readOperatorState, writeOperatorState } from './operator-state-pg';
import { registerOverrideConcern, type OverrideEntry } from './config-overrides/registry';
import { STALE_MS } from './liveness';

export interface CoordLivenessConfig {
  /** Override the stale-handoff auto-expiry TTL (default STALE_HANDOFF_TTL_MS = 12h). */
  handoffTtlMs?: number;
  /** Override the handoff re-ping window — an open, un-acked handoff older than this
   *  (but < handoffTtlMs) re-pings the offerer once (default STALE_HANDOFF_REPING_MS = 30m).
   *  coord-dispatch-reliability P-003. */
  handoffRepingMs?: number;
  /** Override the stale-claim reclaim grace (default STALE_CLAIM_GRACE_MS = STALE_MS = 10m). */
  reclaimGraceMs?: number;
  /** Override the requeue cap before a mid-flight claim is dead-lettered (default staleReclaimRequeueCap() = 3). */
  reclaimRequeueCap?: number;
  /** Override the dead-holder plan-item ASSIGNMENT reclaim grace (default
   *  STALE_PLAN_ASSIGNMENT_GRACE_MS = 60m). Longer than reclaimGraceMs because
   *  assignments are durable across interruption (EI-2535). */
  assignmentReclaimGraceMs?: number;
  /** Override the idle-session reaper grace (default IDLE_SESSION_GRACE_MS = STALE_MS = 10m). */
  sessionReaperGraceMs?: number;
}

/** The consumers' baked defaults — for the diff/display + the tools' "default" reporting only.
 *  The real fallback lives in each consumer (this layer only carries OVERRIDES). */
export const COORD_LIVENESS_DEFAULTS = {
  handoffTtlMs: 12 * 60 * 60 * 1000,
  handoffRepingMs: 30 * 60 * 1000,
  reclaimGraceMs: STALE_MS,
  reclaimRequeueCap: 3,
  assignmentReclaimGraceMs: 60 * 60 * 1000,
  sessionReaperGraceMs: STALE_MS,
} as const;

export async function readCoordLivenessConfig(): Promise<CoordLivenessConfig> {
  return (await readOperatorState<CoordLivenessConfig>('operator_coord_liveness_config')) ?? {};
}

export async function writeCoordLivenessConfig(patch: CoordLivenessConfig): Promise<CoordLivenessConfig> {
  const next = { ...(await readCoordLivenessConfig()), ...patch };
  await writeOperatorState<CoordLivenessConfig>('operator_coord_liveness_config', next);
  return next;
}

export async function setCoordLivenessConfig(cfg: CoordLivenessConfig): Promise<void> {
  await writeOperatorState<CoordLivenessConfig>('operator_coord_liveness_config', cfg);
}

export async function resetCoordLivenessConfig(): Promise<void> {
  await setCoordLivenessConfig({});
}

registerOverrideConcern({
  name: 'coord-liveness-config',
  description: 'coordination liveness/reclaim overrides (handoff TTL, reclaim grace/cap, session-reaper grace)',
  auditAction: 'work_items:reclaim_config',
  diff: async () => {
    const c = await readCoordLivenessConfig();
    const entries: OverrideEntry[] = [];
    for (const k of Object.keys(COORD_LIVENESS_DEFAULTS) as (keyof CoordLivenessConfig)[]) {
      if (c[k] !== undefined) entries.push({ key: k, effective: c[k], default: COORD_LIVENESS_DEFAULTS[k], layer: 'pg-settings' });
    }
    return entries;
  },
  capture: () => readCoordLivenessConfig(),
  reset: () => resetCoordLivenessConfig(),
  restore: (snap) => setCoordLivenessConfig((snap as CoordLivenessConfig) ?? {}),
});
