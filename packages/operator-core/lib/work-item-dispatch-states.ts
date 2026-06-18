/**
 * work-item-dispatch-states — the canonical feature-family lifecycle-state sets
 * shared by the stuck-item recovery layer, so the reaper, the voluntary-release
 * path, the dead-letter dispatcher, and the stuck-items health metric can never
 * disagree about which states mean what (work-queue-stuck-item-recovery-2026-06-17).
 *
 * Pure constants only — NO PG, NO imports — so any layer (incl. the standalone
 * `work-items-stale-claims` reaper) can depend on it without a cycle.
 *
 * These describe the LIVE `harness_features_consolidated.status` vocabulary
 * (todo / in_progress / validating / passed / failing / deprecated / blocked /
 * needs-human / wip), NOT the aspirational dogfood-v5 `feature-state-types.ts`
 * model (backlog/in_queue/working/pending_done/shipped), which is a separate,
 * not-yet-wired lifecycle.
 */

/** The single state in which a feature-family work-item is offered to the
 *  claimable pool (`claimNextWorkItem` / the dispatch frontier filter on it). */
export const FEATURE_DISPATCHABLE_STATE = 'todo';

/** Settled feature states — a terminal outcome, never re-dispatched and never
 *  requeued by the reaper. (Mirrors the settled set in setWorkItemState that
 *  fires `work-item:done`.) */
export const FEATURE_TERMINAL_STATES: readonly string[] = ['passed', 'deprecated'];

/**
 * Feature states the reaper / release path must NOT requeue to `todo`:
 *   - `todo`        — already claimable, nothing to do;
 *   - terminal      — settled, leave alone;
 *   - `blocked`     — a deliberate park with its own delegator-notify signal path.
 * Any OTHER non-null status on a freed row (in_progress, validating, failing,
 * wip, needs-human, …) is a mid-flight item stranded by a dead/releasing holder
 * and IS requeued. This same predicate defines "freed-but-non-dispatchable" for
 * the stuck-items health metric (P-008a).
 */
export const FEATURE_NON_REQUEUE_STATES: readonly string[] = [
  FEATURE_DISPATCHABLE_STATE,
  ...FEATURE_TERMINAL_STATES,
  'blocked',
];

/** Pure predicate: is this freed feature row stranded mid-flight (should the
 *  reaper / voluntary-release reset it back to `todo`)? */
export function isRequeueableFeatureState(status: string | null | undefined): boolean {
  return status != null && status !== '' && !FEATURE_NON_REQUEUE_STATES.includes(status);
}

/** Default cap on how many times the stale-claim reaper will requeue one row
 *  before dead-lettering it to `blocked` (D-007). Env-overridable. */
export const DEFAULT_STALE_RECLAIM_REQUEUE_CAP = 3;

/** Resolve the requeue cap from the environment (PAPERCUSP_STALE_RECLAIM_REQUEUE_CAP),
 *  falling back to the default. Mirrors the STALE_CLAIM_GRACE_MS tunable pattern. */
export function staleReclaimRequeueCap(): number {
  const v = Number(process.env.PAPERCUSP_STALE_RECLAIM_REQUEUE_CAP ?? DEFAULT_STALE_RECLAIM_REQUEUE_CAP);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_STALE_RECLAIM_REQUEUE_CAP;
}
