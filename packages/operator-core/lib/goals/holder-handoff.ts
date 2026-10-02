/**
 * The delivery half of a GOAL holder election.
 *
 * The lease/CAS in modes/store is the authority source. This module makes the
 * losing holder aware immediately: disarm its recurring loop, persist a direct
 * stand-down message, invalidate its Orders projection, and wake it to finish
 * only the bounded handoff. All callers use this one seam so a system recovery
 * and an interactive current-holder handoff cannot drift.
 */
import type { Sql } from 'postgres';
import type { GoalModeElectionReceipt } from '../modes/store';
import { clearImpliedModes, setMode } from '../modes/store';
import { GOAL_MODE } from '../modes/goal-session';
import { deactivateLoop } from '../harness/routines/loop';
import { notifyAgentOrdersChanged } from '../agent-orders-notify';
import { sendMessage } from '../agent-tools/coordination/messages';
import { wakeRecipients } from '../agent-tools/coordination/inbox-wake';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import {
  vacateDrainFleetLeadership,
  type DrainFleetVacancyOutcome,
} from './vacate-drain-fleet-leadership';

const HANDOFF_IDENTITY: AgentIdentity = {
  ownerId: 'goal-holder-election',
  ownerLabel: 'system · goal holder election',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

export interface GoalHolderHandoffDeps {
  deactivate: (ownerId: string, reason: string) => Promise<boolean>;
  notifyOrders: (ownerId: string) => Promise<void>;
  message: (ownerId: string, summary: string, body: string) => Promise<void>;
  wake: (
    ownerId: string,
    summary: string,
    payload: Record<string, unknown>,
    workspaceId: string,
  ) => Promise<{ woken: number; staged: number }>;
  /**
   * EI-22402152554463916: clear the outgoing holder from the goal's drain-fleet leader seat.
   * The election disarms the loop here, so this is the one moment the system already knows
   * the agent is standing down — and the seat must be VACATED, never re-seated on the
   * incoming holder (see vacate-drain-fleet-leadership for why).
   */
  vacateDrainFleet: (
    workspaceId: string,
    goalId: string,
    outgoingOwnerId: string,
  ) => Promise<DrainFleetVacancyOutcome>;
}

const DEFAULT_DEPS: GoalHolderHandoffDeps = {
  deactivate: async (ownerId, reason) =>
    await deactivateLoop(ownerId, { actor: HANDOFF_IDENTITY.ownerId, reason }),
  notifyOrders: notifyAgentOrdersChanged,
  message: async (ownerId, summary, body) => {
    await sendMessage(HANDOFF_IDENTITY, { to: [ownerId], summary, body });
  },
  wake: async (ownerId, summary, payload, workspaceId) => {
    const result = await wakeRecipients([ownerId], {
      summary,
      payload,
      source: HANDOFF_IDENTITY.ownerId,
      workspaceId,
    });
    return { woken: result.woken, staged: result.staged };
  },
  vacateDrainFleet: vacateDrainFleetLeadership,
};

export interface GoalHolderHandoffNotice {
  predecessorOwnerId: string;
  successorOwnerId: string;
  goalId: string;
  epoch: number;
  handoffExpiresAt: string | null;
  loopDeactivated: boolean;
  woken: number;
  staged: number;
  /** What became of the goal's drain-fleet leader seat (EI-22402152554463916). */
  drainFleet: DrainFleetVacancyOutcome;
}

export async function notifyGoalHolderHandoff(
  workspaceId: string,
  election: GoalModeElectionReceipt,
  deps: GoalHolderHandoffDeps = DEFAULT_DEPS,
): Promise<GoalHolderHandoffNotice | null> {
  const predecessorOwnerId = election.predecessorOwnerId;
  if (!predecessorOwnerId) return null;
  const expiry = election.handoffExpiresAt ?? 'immediately';
  const summary =
    `GOAL holder handoff: '${election.goalId}' elected ${election.ownerId} ` +
    `(epoch ${election.epoch}); ${predecessorOwnerId} must stand down`;
  const loopDeactivated = await deps.deactivate(
    predecessorOwnerId,
    `GOAL lease '${election.goalId}' transferred to ${election.ownerId} at epoch ${election.epoch}`,
  );
  // EI-22402152554463916: standing down the holder while leaving it registered as the drain
  // fleet's leader is worse than leaving that fleet leaderless — a filled slot that never acts
  // reads as healthy on every liveness surface. Clear it in the same transaction that disarms
  // the loop, which is the one moment the system already knows this agent is standing down.
  const drainFleet = await deps.vacateDrainFleet(
    workspaceId,
    election.goalId,
    predecessorOwnerId,
  );
  const body =
    `Your GOAL holder lease for '${election.goalId}' was superseded by ${election.ownerId} ` +
    `(epoch ${election.epoch}). Your recurring loop has been disarmed. Finish only the atomic ` +
    `handoff already in flight before ${expiry}; after that boundary, goal-scoped context, ` +
    `mutations, and launches refuse with the elected-holder diagnosis. Checkpoint and release ` +
    `your lane; do not re-enter GOAL mode or retry acquisition.` +
    (drainFleet.vacated
      ? ` You were also the registered leader of drain fleet '${drainFleet.fleetSlug}'; that ` +
        `seat has been VACATED so a launched member can take it via fleet:take-leadership. ` +
        `Do not reclaim it — you have stood down.`
      : '');
  await deps.notifyOrders(predecessorOwnerId);
  await deps.message(predecessorOwnerId, summary, body);
  const wake = await deps.wake(
    predecessorOwnerId,
    summary,
    {
      goalId: election.goalId,
      electedOwnerId: election.ownerId,
      electedEpoch: election.epoch,
      handoffExpiresAt: election.handoffExpiresAt,
      action: 'stand-down',
    },
    workspaceId,
  );
  return {
    predecessorOwnerId,
    successorOwnerId: election.ownerId,
    goalId: election.goalId,
    epoch: election.epoch,
    handoffExpiresAt: election.handoffExpiresAt,
    loopDeactivated,
    woken: wake.woken,
    staged: wake.staged,
    drainFleet,
  };
}

/** Upper bound on superseded rows retired per goal per sweep tick. */
export const SUPERSEDED_GOAL_HOLDER_RETIRE_LIMIT = 50;

export interface SupersededGoalHolderRetirement {
  /** Predecessors whose GOAL row was removed (or was already gone). */
  retired: string[];
  /** Predecessors whose GOAL row setMode refused (e.g. an owner-directed row). Reported, never forced. */
  leftArmed: string[];
}

/**
 * WI-10005573: retire the GOAL-mode rows of holders a newer election superseded.
 *
 * `notifyGoalHolderHandoff` disarms the predecessor's loop and orders it to stand
 * down, but nothing ever removed its `agent_modes` GOAL row or the AUTO/IDEATE
 * rows that GOAL entry implied. A replaced holder therefore stayed a live,
 * autonomous goal agent indefinitely (measured 2026-10-02: one churn burst on
 * goal 60d3a8 left five superseded holders with GOAL rows; one kept relaunching
 * its CLI with AUTO intact). The lease epoch already fences their goal-scoped
 * authority, so the rows are pure residue — but residue that keeps the agent
 * autonomous and reads as a goal agent on every surface.
 *
 * Retires every row on this goal's subject whose lease epoch is BELOW the
 * elected row's, once the elected row's bounded handoff window has expired —
 * the same boundary after which the predecessor's goal-scoped context already
 * refuses, so nothing it could still legitimately do is cut short. Goes through
 * `setMode` (owner-sticky guard, audit row, Orders push) and `clearImpliedModes`
 * scoped to this exact goal source, mirroring the terminal stop fan-out; a
 * refusal is reported, never bypassed. Rows without a lease epoch are left
 * alone: there is no fencing token to prove they were superseded.
 */
export async function retireSupersededGoalHolderModes(
  sql: Sql,
  workspaceId: string,
  goalId: string,
  setBy: string = HANDOFF_IDENTITY.ownerId,
): Promise<SupersededGoalHolderRetirement> {
  const rows = await sql<Array<{ owner_id: string; goal_lease_epoch: string; elected_owner_id: string; elected_epoch: string }>>`
    WITH elected AS (
      SELECT owner_id, goal_lease_epoch, goal_handoff_expires_at
        FROM harness_shared.agent_modes
       WHERE workspace_id = ${workspaceId}
         AND mode = ${GOAL_MODE}
         AND subject = ${goalId}
       ORDER BY goal_lease_epoch DESC NULLS LAST, set_at DESC, owner_id ASC
       LIMIT 1
    )
    SELECT am.owner_id, am.goal_lease_epoch::text AS goal_lease_epoch,
           e.owner_id AS elected_owner_id, e.goal_lease_epoch::text AS elected_epoch
      FROM harness_shared.agent_modes am
      CROSS JOIN elected e
     WHERE am.workspace_id = ${workspaceId}
       AND am.mode = ${GOAL_MODE}
       AND am.subject = ${goalId}
       AND am.owner_id <> e.owner_id
       AND am.goal_lease_epoch IS NOT NULL
       AND e.goal_lease_epoch IS NOT NULL
       AND am.goal_lease_epoch < e.goal_lease_epoch
       AND (e.goal_handoff_expires_at IS NULL OR e.goal_handoff_expires_at <= now())
     ORDER BY am.goal_lease_epoch ASC, am.owner_id ASC
     LIMIT ${SUPERSEDED_GOAL_HOLDER_RETIRE_LIMIT}`;
  const retired: string[] = [];
  const leftArmed: string[] = [];
  for (const row of rows) {
    const reason =
      `GOAL lease '${goalId}' superseded: epoch ${row.goal_lease_epoch} < elected ` +
      `${row.elected_owner_id} epoch ${row.elected_epoch}; handoff window expired`;
    const res = await setMode({
      sql,
      workspaceId,
      ownerId: row.owner_id,
      modeId: GOAL_MODE,
      enabled: false,
      reason,
      setBy,
    });
    if (!res.ok) {
      leftArmed.push(row.owner_id);
      continue;
    }
    retired.push(row.owner_id);
    await clearImpliedModes({
      sql,
      workspaceId,
      ownerId: row.owner_id,
      source: { mode: GOAL_MODE, subject: goalId },
      reason: `${reason} — retire implied posture rows`,
      setBy,
    });
  }
  return { retired, leftArmed };
}
