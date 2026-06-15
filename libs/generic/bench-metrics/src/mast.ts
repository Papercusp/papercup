/**
 * MAST coordination-quality instrumentation (P-026 / D-010 L4 — the most
 * differentiated AND most impartial Hive claim). The MAST study (NeurIPS 2025,
 * 1,600+ multi-agent traces) found multi-agent systems FAIL 41–86% of the time
 * in production, with inter-agent token-duplication at 53–86% and
 * inter-agent-misalignment at 36.9%. The Hive's coordination substrate (locks,
 * work_items dedup + redundancy-judge, durable hand-offs, the Queen's placement)
 * exists to drive those failure rates DOWN — so we measure OUR rates against
 * that published baseline, and against the Queen-ablated fleet + competitor
 * orchestrators (P-028).
 *
 * This module is the pure scorer: a classified coordination trace
 * (`CoordEvent[]`) → `MastRates`. The TRACE is emitted by P-010's
 * reproducibility layer (B8 extension — rollout records capture fleet/coord
 * events); the CLASSIFICATION of a raw substrate event into a failure category
 * is done by the emit layer or by `classifyCoordEvent` here. Pure, domain-free.
 */

import type { FleetArmId } from './fleet';

/**
 * The coordination-failure categories we score, each mapped to a MAST failure
 * mode and to the substrate mechanism meant to prevent it:
 *  - duplicate_work        — two agents executed the SAME task (MAST: information
 *    withholding / no dedup). Substrate guard: work_items claim + redundancy-judge.
 *  - coordination_breakdown — a stranded item, orphaned claim, or lost hand-off
 *    (MAST: step repetition / derailment). Guard: durable messages + stale-claim sweep.
 *  - misalignment          — an agent acted on superseded/conflicting state
 *    (MAST: inter-agent misalignment, the 36.9% mode). Guard: locks + CDC convergence.
 *  - redundant_work        — work redone unnecessarily though already done/claimed.
 *  - premature_termination — the arm stopped before the backlog was drained / verified
 *    (MAST FC3: premature termination).
 *  - incomplete_verification — a task claimed resolved that the grader then failed
 *    (MAST FC3: no/incorrect verification).
 */
export type CoordFailureKind =
  | 'duplicate_work'
  | 'coordination_breakdown'
  | 'misalignment'
  | 'redundant_work'
  | 'premature_termination'
  | 'incomplete_verification';

export const COORD_FAILURE_KINDS: readonly CoordFailureKind[] = [
  'duplicate_work',
  'coordination_breakdown',
  'misalignment',
  'redundant_work',
  'premature_termination',
  'incomplete_verification',
] as const;

/**
 * One coordination event in an arm's trace. `kind: 'ok'` is a normal
 * coordination action (a clean hand-off / claim / completion) — it is NOT a
 * failure but counts toward `coordinationActions` so rates can be normalized by
 * total coordination volume as well as by task count.
 */
export interface CoordEvent {
  kind: CoordFailureKind | 'ok';
  taskId?: string | null;
  detail?: string;
}

/** Published MAST baselines (NeurIPS 2025) — context bands, never our own claim. */
export const MAS_FAILURE_BASELINE_BAND: readonly [number, number] = [0.41, 0.86];
export const TOKEN_DUPLICATION_BASELINE_BAND: readonly [number, number] = [0.53, 0.86];
export const INTERAGENT_MISALIGNMENT_BASELINE = 0.369;

export interface MastRates {
  arm: FleetArmId;
  /** Tasks in the backlog (the normalization denominator for the headline rates). */
  tasks: number;
  /** Total coordination actions observed (failures + clean actions) — the volume denominator. */
  coordinationActions: number;
  /** Raw count per failure kind. */
  counts: Record<CoordFailureKind, number>;
  /** Total coordination failures across all kinds. */
  totalFailures: number;
  /** Failures per task — the headline rate compared to the 41–86% MAS baseline. */
  failureRatePerTask: number;
  /** Failures per coordination action — the duplication/misalignment-style normalization. */
  failureRatePerAction: number;
  // The four headline rates the L4 claim leads with (each / tasks):
  duplicationRate: number;
  coordinationBreakdownRate: number;
  misalignmentRate: number;
  redundantWorkRate: number;
  /** Published MAS-failure band carried alongside for the chart's reference line. */
  masBaselineBand: readonly [number, number];
}

function zeroCounts(): Record<CoordFailureKind, number> {
  return {
    duplicate_work: 0,
    coordination_breakdown: 0,
    misalignment: 0,
    redundant_work: 0,
    premature_termination: 0,
    incomplete_verification: 0,
  };
}

/**
 * Score a classified coordination trace into MAST rates for one arm. `tasks` is
 * the backlog size (rates are per-task). Events with `kind: 'ok'` only add to
 * the action volume; failure kinds add to both counts and volume.
 */
export function mastRates(events: readonly CoordEvent[], arm: FleetArmId, tasks: number): MastRates {
  const counts = zeroCounts();
  let coordinationActions = 0;
  for (const e of events) {
    coordinationActions++;
    if (e.kind !== 'ok') counts[e.kind]++;
  }
  const totalFailures = COORD_FAILURE_KINDS.reduce((a, k) => a + counts[k], 0);
  const perTask = (n: number) => (tasks === 0 ? 0 : n / tasks);
  return {
    arm,
    tasks,
    coordinationActions,
    counts,
    totalFailures,
    failureRatePerTask: perTask(totalFailures),
    failureRatePerAction: coordinationActions === 0 ? 0 : totalFailures / coordinationActions,
    duplicationRate: perTask(counts.duplicate_work),
    coordinationBreakdownRate: perTask(counts.coordination_breakdown),
    misalignmentRate: perTask(counts.misalignment),
    redundantWorkRate: perTask(counts.redundant_work),
    masBaselineBand: MAS_FAILURE_BASELINE_BAND,
  };
}

/**
 * Map a raw substrate coordination-event kind (the `coord:*` / work_items /
 * locks vocabulary) to a MAST failure category, or 'ok' for a clean action, or
 * null to ignore it. This is the one place the substrate's own event names are
 * translated to the taxonomy — keep it in sync with P-010's emitted trace.
 */
export function classifyCoordEvent(rawKind: string): CoordFailureKind | 'ok' | null {
  switch (rawKind) {
    case 'duplicate_completion':
    case 'double_completion':
      return 'duplicate_work';
    case 'orphaned_claim':
    case 'stranded_item':
    case 'lost_handoff':
    case 'dead_holder_freed':
      return 'coordination_breakdown';
    case 'claim_conflict':
    case 'superseded_work':
    case 'conflicting_edit':
      return 'misalignment';
    case 'redundant_execution':
    case 'rework':
      return 'redundant_work';
    case 'premature_stop':
    case 'backlog_abandoned':
      return 'premature_termination';
    case 'unverified_pass':
    case 'false_positive_resolve':
      return 'incomplete_verification';
    // Clean coordination actions — count toward volume, not failures.
    case 'handoff':
    case 'handoff_accepted':
    case 'claim':
    case 'completion':
    case 'placement':
    case 'redundancy_judged':
      return 'ok';
    default:
      return null; // not a coordination event we score
  }
}
