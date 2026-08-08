/**
 * fleet-transition-sweep-action — the DERIVED half of the leader transition feed
 * (fleet-leadership-continuity-and-actuation-2026-08-01 P-009, D-008).
 *
 * Two of P-009's four new transitions have a real transition site and co-fire from
 * it (`fleet:claim-released:<slug>` from releaseWorkItem, `fleet:item-completed:<slug>`
 * from emitWorkItemSettledEvents). The other two have NONE:
 *
 *   - member-dead      — death is the ABSENCE of a write. Nothing happens at the
 *                        moment a member dies; a verdict merely becomes derivable.
 *   - context-critical — pressure is DERIVED from self-reported token counts, so
 *                        the bucket changes without any event of its own.
 *
 * So they need a sweep, exactly as `fleet-drained-events.ts` documents for its own
 * computed condition. This is the sweep. It is deliberately thin: it gathers
 * observations through the SAME pipeline `fleet:assignments` uses (so a sweep
 * verdict can never disagree with what a leader would read), hands them to the
 * pure detector in `fleet-transition-events.ts`, and emits whatever crossings come
 * back.
 *
 * WHY A SWEEP IS STILL "PUSH, NOT POLL". One sweep for the whole box replaces N
 * leaders each polling their own fleet on their own clock — and, more to the point,
 * each BURNING A TURN to do it. The leader sleeps on an event; the substrate does
 * the looking. That is the whole trade this plan is making.
 *
 * THE PREVIOUS SNAPSHOT IS IN-PROCESS, ON PURPOSE. Edge detection needs the prior
 * observation, and this keeps it in module scope rather than a table. That is not
 * the storage-policy violation it looks like: a lost snapshot costs at most one
 * MISSED edge, once, on the sweep after a restart (the detector's first-sighting
 * rule then re-arms every member), and P-010 explicitly retains `loop:arm` as a
 * long fallback heartbeat precisely so a missed push degrades to a slower notice
 * rather than a lost one. Persisting it would buy a rare edge across restarts at
 * the cost of a table, a migration and a write every sweep. Same shape and
 * justification as the in-process throttle already in `work-items-events.ts`.
 */

import { groupByAgent, listFleetAssignments, type AgentAssignment } from '../../fleet/assignments';
import { reconcileWakeability } from '../../agent-tools/fleet/assignments';
import type { SessionState } from '../../agent-tools/coordination/presence-wakeability';
import { fetchContextPressure } from '../../agent-tools/coordination/context-pressure';
import {
  detectFleetTransitions,
  emitFleetTransitionEdge,
  indexObservations,
  type FleetMemberObservation,
  type FleetTransitionEventsDeps,
} from '../../fleet-transition-events';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

/**
 * The previous sweep's observations, keyed by (fleet, agent). Module-scoped and
 * best-effort by design — see the header note.
 */
let previousObservations = new Map<string, FleetMemberObservation>();

/** Test-only: forget the previous snapshot so cases don't cross-contaminate. */
export function __resetFleetTransitionSnapshotForTests(): void {
  previousObservations = new Map();
}

/**
 * Gather one round of observations through the SAME pipeline `fleet:assignments`
 * uses — grouped assignments, then the shared wakeability oracle for
 * `sessionState`, then the context-pressure buckets. Reusing it (rather than a
 * bespoke query) is what stops a sweep verdict drifting from the verdict a leader
 * would read for itself.
 *
 * Agents in NO fleet are dropped: their transitions are nobody's fleet event.
 */
export async function gatherFleetObservations(): Promise<FleetMemberObservation[]> {
  // `reconcileWakeability` WRITES `sessionState` onto the rows it is handed, but
  // `AgentAssignment` does not declare the field — so the widened row type has to
  // be named here, or the reconciled result narrows straight back to
  // `AgentAssignment` and reading `.sessionState` off it is a type error.
  type ObservableAgent = AgentAssignment & {
    sessionState?: SessionState | null;
    confirmLiveness?: boolean | null;
  };
  const agents: ObservableAgent[] = groupByAgent(await listFleetAssignments({}));
  const fleeted = agents.filter((a) => Boolean(a.fleetSlug));
  if (fleeted.length === 0) return [];

  // Best-effort on both legs: a degraded liveness or pressure read must produce a
  // sweep with UNKNOWN fields, never a thrown sweep. An unknown never fires (the
  // detector only fires on a crossing INTO a known-bad state), so a degraded read
  // is silent rather than a false alarm.
  const withLiveness = await reconcileWakeability(fleeted).catch(() => fleeted);
  const pressure = await fetchContextPressure(fleeted.map((a) => a.agentId)).catch(
    () => new Map<string, string>(),
  );

  return withLiveness
    .filter((a): a is typeof a & { fleetSlug: string } => Boolean(a.fleetSlug))
    .map((a) => ({
      agentId: a.agentId,
      fleetSlug: a.fleetSlug,
      sessionState: a.sessionState ?? null,
      contextPressure: pressure.get(a.agentId) ?? null,
    }));
}

/** Injectable seams so the sweep unit-tests without PG. */
export interface FleetTransitionSweepDeps extends FleetTransitionEventsDeps {
  gather?: () => Promise<FleetMemberObservation[]>;
}

/**
 * Run one sweep: observe, detect the crossings against the previous snapshot, emit
 * them, and keep the snapshot for next time. Returns the edges it fired, so the
 * routine can log a count and tests can assert without reading the emitter.
 *
 * The snapshot is advanced even when nothing fired — that is what makes the NEXT
 * sweep able to see a crossing.
 */
export async function runFleetTransitionSweep(deps: FleetTransitionSweepDeps = {}): Promise<number> {
  const gather = deps.gather ?? gatherFleetObservations;
  const observations = await gather();
  const edges = detectFleetTransitions(previousObservations, observations);
  previousObservations = indexObservations(observations);
  for (const edge of edges) emitFleetTransitionEdge(edge, deps);
  return edges.length;
}

/**
 * How often the control-state reconcile runs, independent of this sweep's own cadence.
 * The sweep ticks every minute because a transition edge is time-sensitive; a fleet that
 * has been dead for three days is not, and re-reading the whole registry every minute
 * would be pure waste. Module-scoped for the same reason the snapshot above is — losing
 * it to a restart costs one delayed pass, nothing more.
 */
const CONTROL_RECONCILE_INTERVAL_MS = 15 * 60 * 1000;
let lastControlReconcileMs = 0;

/** Test-only: let a case drive the reconcile without waiting out the interval. */
export function __resetFleetControlReconcileThrottleForTests(): void {
  lastControlReconcileMs = 0;
}

registerSystemAction('fleet-transition-sweep', async (ctx: SystemActionCtx) => {
  const fired = await runFleetTransitionSweep();
  // Only speak when something actually crossed — this runs every minute, and a
  // per-tick "swept, nothing to report" line is the log noise that trains readers
  // to filter the channel out.
  if (fired > 0) console.log(`[fleet-transition-sweep] fired ${fired} transition event(s)`);

  // WI-35718: reconcile DECLARED fleet control state against observed reality, on its own
  // slower clock. Rides this sweep rather than adding a routine — it needs the same fleet
  // view, and the repo's scheduling rule is to reuse an existing mechanism rather than
  // introduce a third one.
  const nowMs = Date.now();
  if (nowMs - lastControlReconcileMs < CONTROL_RECONCILE_INTERVAL_MS) return;
  lastControlReconcileMs = nowMs;
  try {
    const { reconcileFleetControlStates, defaultFleetControlReconcileDeps } = await import(
      './fleet-control-reconcile'
    );
    const res = await reconcileFleetControlStates(await defaultFleetControlReconcileDeps(ctx.workspaceId));
    // Speak only on a real mutation. A wind-down is a registry write other components read,
    // so it must be attributable in the log; a quiet pass must not be.
    if (res.woundDown.length > 0) {
      console.log(
        `[fleet-control-reconcile] wound down ${res.woundDown.length} stale fleet(s): ` +
          `${res.woundDown.join(', ')} (considered ${res.considered})`,
      );
    }
  } catch (e) {
    // Never let the reconcile cost the transition sweep — that is the time-sensitive half.
    console.warn(`[fleet-control-reconcile] pass failed: ${e instanceof Error ? e.message : e}`);
  }
});
