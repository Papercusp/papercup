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

/**
 * The canonical feature-family lifecycle states an AGENT may set via the validated
 * agent-facing path (work_items:set_state / :complete → setWorkItemState). GAP 5 /
 * P-011 / D-010. The DBOS pipeline writes phase statuses (scoping/building/…) via
 * RAW SQL and is NOT governed by this — so app-level validation catches agent typos
 * without freezing the pipeline (D-004). A genuinely-new agent-settable state must be
 * ADDED here deliberately (the reviewed extension), not silently drifted.
 */
export const FEATURE_FAMILY_STATES: readonly string[] = [
  'todo', 'in_progress', 'validating', 'passed', 'failing', 'deprecated', 'blocked', 'wip', 'needs-human',
];

/**
 * Cross-dialect + drift-variant aliases → canonical feature state. The canonical
 * lifecycle dialect (done/dropped/…) folds to the native vocabulary, AND known
 * separator/case typos (`in-progress`, `needs_human`) fold to canonical so a typo
 * lands in the RIGHT state instead of a non-dispatchable limbo (the GAP-5 harm).
 * Inputs are lower-cased before lookup, so case typos normalize too.
 */
const FEATURE_STATE_ALIASES: Record<string, string> = {
  // canonical lifecycle dialect → native feature vocabulary
  done: 'passed', resolved: 'passed', dropped: 'deprecated', closed: 'deprecated', open: 'todo',
  // known separator/case drift variants → canonical
  'in-progress': 'in_progress', inprogress: 'in_progress', 'in progress': 'in_progress',
  needs_human: 'needs-human', needshuman: 'needs-human', 'needs human': 'needs-human',
  'need-human': 'needs-human',
};

/**
 * Normalize an agent-supplied feature state onto the canonical vocabulary, or REJECT
 * it (typed, listing the valid set) — the GAP-5 typo guard (P-011 / D-010). Folds
 * case + known separator drift; a truly-unknown state is rejected. Trusted internal
 * restore paths (autonomy revert) bypass this via setWorkItemState's allowNonCanonical.
 */
export function normalizeFeatureStateInput(
  state: string,
): { ok: true; state: string } | { ok: false; valid: readonly string[] } {
  const lower = state.trim().toLowerCase();
  const mapped = FEATURE_STATE_ALIASES[lower] ?? lower;
  if (FEATURE_FAMILY_STATES.includes(mapped)) return { ok: true, state: mapped };
  return { ok: false, valid: FEATURE_FAMILY_STATES };
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
