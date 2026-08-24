/**
 * control-core.ts — the shared engine behind fleet:wind-down / fleet:resume /
 * fleet:pause (coord-authority-hardening-2026-07-11 P-009 / H4).
 *
 * A fleet's wind-down is TYPED PLATFORM STATE, not a free-text broadcast:
 *   1. GUARD the invoker — owner (an `su` interactive session, the owner's own
 *      agent — the established owner-authority proxy), THAT fleet's recorded
 *      leader, or the queen (`mug` / `kettle` pane kinds). Everything else —
 *      cups, papercups, planners, peer-fleet automation — is refused: exactly
 *      the EI-9501 class (an unauthorized agent steering a fleet it doesn't
 *      own) this hardening plan exists to kill.
 *   2. PERSIST the control state on the durable registry row (mig 575:
 *      winding-down|active + reason + by + ts) — late joiners read it at
 *      orient, so control never depends on having been live for a message.
 *   3. CUE the live member set with a TYPED control message stamped
 *      fleet-scoped cueAuthority (fleetScopedCueAuthority — authority intrinsic
 *      to the action, like pot:pause's hive-wide stamp): binding for members,
 *      receive-side demoted (H1) for everyone else. Typed cues are binding;
 *      free-text "please pause" remains advisory by definition.
 *
 * The cue leg is best-effort BY CONTRACT: the registry write is the source of
 * truth, and a presence/send hiccup must never wedge the state flip.
 */
import { classifyAgentPane } from '@papercusp/agent-mcp';
import {
  fleetSlugFromName,
  getFleet,
  setFleetControlState,
  type AgentFleetRecord,
  type FleetControlState,
} from '../../agent-fleets-store';
import { sendMessage } from '../coordination/messages';
import { getPresence } from '../coordination/presence';
import {
  CUE_AUTHORITY_FIELD,
  EXPECTED_LIFECYCLE_ACK_FIELD,
  expectedFleetWindDownAck,
  fleetScopedCueAuthority,
} from '../coordination/cue-authority';
import { listFleetControlMembers } from '../coordination/audience-host';
import { resolveFleetCaller } from './_shared';
import { classifyFleetControlInvoker } from './fleet-auth';
import type { ResolveIdentityCtx } from '../coordination/identity';
import type { FleetPauseHoldResult } from './pause-holds';
import {
  clearSessionBriefReleasedForFleet,
  markSessionBriefReleased,
} from '../../session-brief';

export type FleetControlAction = 'wind-down' | 'resume';

const ACTION_TO_STATE: Record<FleetControlAction, FleetControlState> = {
  'wind-down': 'winding-down',
  resume: 'active',
};

export interface FleetControlResult {
  ok: boolean;
  fleet?: string;
  controlState?: FleetControlState;
  reason?: string | null;
  by?: string;
  invokedAs?: 'leader' | 'queen' | 'owner';
  /** True when the fleet was ALREADY in the requested state — the row's
   *  reason/by/at were still refreshed, but no duplicate cue was sent. */
  alreadyInState?: boolean;
  /** Live members the typed cue was delivered to ([] = none live / cue skipped
   *  — the registry state still stands, and late joiners see it at orient). */
  notified?: string[];
  cueMsgId?: string | null;
  /** P-006 (work-item-claimability-clarity-2026-07-20): on a wind-down, the live
   *  scheduler-oracle drain snapshot auto-stamped onto the reason — the per-floor
   *  exclusion breakdown + the exact re-verify command. Absent when it could not be
   *  computed (fails soft) or the action was resume. */
  drainStamp?: import('./drain-stamp').FleetDrainStamp;
  /** EI-20199397615670608: the claim-holds this control flip SET (wind-down) or CLEARED
   *  (resume) on the fleet members' held work-items, so the pause cannot leak its lane
   *  back into the claimable pool the moment members comply with it. Absent when nothing
   *  matched or the leg failed soft. */
  pauseHolds?: FleetPauseHoldResult;
  error?: string;
  message?: string;
}

// classifyFleetControlInvoker (the pure authority predicate) now lives in the dependency-free
// fleet-auth module (P-006), imported above for local use and re-exported here so every existing
// importer keeps its import path.
export { classifyFleetControlInvoker };

/** The member-facing body for each action's typed cue. */
export function fleetControlCueText(
  action: FleetControlAction,
  fleet: string,
  reason: string | null,
  byHandle: string,
  cueMsgId?: string,
): { summary: string; body: string } {
  if (action === 'wind-down') {
    const ackInstruction = cueMsgId
      ? `ack this exact cue with coord:ack { msg_id: '${cueMsgId}' }`
      : 'ack this exact cue with coord:ack { msg_id }';
    return {
      summary: `Fleet ${fleet} WIND-DOWN (typed control cue, by ${byHandle})${reason ? `: ${reason}` : ''}`,
      body:
        `Fleet ${fleet} is WINDING DOWN${reason ? ` — reason: ${reason}` : ''}. ` +
        'This is a TYPED, BINDING control cue [system-derived:fleet-control] ' +
        '(registry control_state=winding-down). ' +
        'Finish only the atomic step in hand, then: work_items:checkpoint + release your claims ' +
        `(or complete with evidence), release your file locks, loop:end any armed loop, and ${ackInstruction}. ` +
        'That ack is a LIFECYCLE RECEIPT: it takes only msg_id and carries no free text, so do not ' +
        'attach a summary/note to it. Report your one-line disposition (or a blocker) as a SEPARATE ' +
        "coord:send { expects:'none', summary:'…' } — a plain inject, so like the lifecycle ack it " +
        'reaches the leader without re-invoking them. Do NOT pull new work from this fleet\'s lanes ' +
        'until a fleet:resume cue (control_state=active) lands.',
    };
  }
  return {
    summary: `Fleet ${fleet} RESUMED (typed control cue, by ${byHandle})${reason ? `: ${reason}` : ''}`,
    body:
      `Fleet ${fleet} is ACTIVE again${reason ? ` — ${reason}` : ''}. ` +
      'The wind-down is lifted (registry control_state=active): resume normal pull-work cadence ' +
      '(scheduler:get_next / your plan lane) and re-arm your loop if you ended it.',
  };
}

/** Compact agent handle for cue text — mirrors the [coord+N] short-handle form. */
function shortHandle(ownerId: string): string {
  return (ownerId ?? '').replace(/^su-/, '').slice(0, 5) || ownerId;
}

/**
 * The shared handler: guard → persist → cue. `fleetArg` accepts a slug or a
 * human name (slugified like every other registry surface).
 */
export async function applyFleetControl(
  ctx: ResolveIdentityCtx,
  fleetArg: string,
  action: FleetControlAction,
  reason?: string,
  opts?: {
    /** P-006: explicit harness for the wind-down drain stamp (else the invoker's
     *  session harness, else the fleet sentinel spec's own scope). */
    harness?: string | null;
    /** P-006: pass true only with a live ≥2-machine rig — mirrors scheduler:get_next. */
    rigAvailable?: boolean;
    /** Internal goal-stop seam: the goal transition already owns this fleet. */
    skipAuthorization?: boolean;
    /** Internal callers do not have a session harness fallback. */
    sessionHarness?: string | null;
  },
): Promise<FleetControlResult> {
  const { ownerId, workspaceId, identity } = resolveFleetCaller(ctx);
  const slug = fleetSlugFromName(fleetArg);
  const fleet = await getFleet(workspaceId, slug);
  if (!fleet) {
    return {
      ok: false,
      error: 'fleet_not_found',
      message: `No fleet '${slug}' in this workspace — fleet:list shows the registry.`,
    };
  }

  // 1. GUARD — owner (su) / this fleet's leader / queen (mug|kettle). The pane
  // kind derives from live presence exactly like resolveSenderCueAuthority
  // (never self-asserted). A presence-read failure classifies by ownerId alone
  // (an `su-…` id still resolves to the su pane kind).
  let paneKind = 'unknown';
  try {
    const pres = await getPresence(ownerId).catch(() => null);
    paneKind = classifyAgentPane({ role: pres?.agentRole ?? null, ownerId }).kind;
  } catch {
    paneKind = classifyAgentPane({ role: null, ownerId }).kind;
  }
  const invokedAs = (opts?.skipAuthorization
    ? 'owner'
    : classifyFleetControlInvoker({
        callerOwnerId: ownerId,
        leaderOwnerId: fleet.leaderOwnerId,
        paneKind,
      })) ?? undefined;
  if (!opts?.skipAuthorization && !invokedAs) {
    return {
      ok: false,
      error: 'not_authorized',
      message:
        `fleet:${action} on '${slug}' is restricted to the owner (an su session), that fleet's ` +
        `recorded leader (${fleet.leaderOwnerId ?? 'none'}), or the queen — you are ${paneKind} `
        + `(${ownerId}). Ask the leader (coord:send @fleet-leader:${slug}) instead of steering a ` +
        'fleet you do not own (EI-9501).',
    };
  }

  // The typed cue below is deliberately fleet-leader-scoped. An owner/queen may
  // authorize a fleet control action, but must not emit a leader-shaped cue when
  // the registry points at an absent leader: members would obey the cue and route
  // their follow-up to a dead `@fleet-leader` while the real controller is this
  // session (EI-21094636043854606). Keep the recovery explicit — take leadership
  // first — rather than silently changing the fleet's owner as a side effect of a
  // control read. A liveness read failure also fails closed; an unverified leader
  // cannot safely back a leader-authority cue.
  if (!opts?.skipAuthorization && invokedAs !== 'leader') {
    let leaderIsLive = false;
    let leaderReadFailed = false;
    if (fleet.leaderOwnerId) {
      try {
        leaderIsLive = (await getPresence(fleet.leaderOwnerId)) !== null;
      } catch {
        leaderReadFailed = true;
      }
    }
    if (!leaderIsLive) {
      const leaderState = leaderReadFailed ? 'could not be confirmed live' : 'has no live presence';
      return {
        ok: false,
        fleet: slug,
        invokedAs,
        error: 'fleet_leader_mismatch',
        message:
          `fleet:${action} cannot emit a fleet-leader cue as ${invokedAs}: the registry leader ` +
          `(${fleet.leaderOwnerId ?? 'none'}) ${leaderState}. ` +
          `Call fleet:take-leadership { fleet: "${slug}" } first, then retry the control action.`,
      };
    }
  }

  // P-006 (work-item-claimability-clarity-2026-07-20): on a WIND-DOWN, snapshot the
  // live scheduler-oracle drain breakdown and AUTO-STAMP it onto the reason, so the
  // durable control_reason records WHY the lane is (or is not) drained in the ONE
  // vocabulary the whole plan makes trustworthy — the authoritative floors, not a
  // hand-rolled `status='open'` count — plus the exact re-verify command. Fails soft:
  // a null stamp leaves the caller's bare reason untouched, never blocking the flip.
  let drainStamp: import('./drain-stamp').FleetDrainStamp | undefined;
  let effectiveReason = reason ?? null;
  if (action === 'wind-down') {
    const { buildFleetDrainStamp } = await import('./drain-stamp');
    const stamp = await buildFleetDrainStamp({
      fleetSlug: slug,
      ownerId,
      workspaceId,
      harnessCandidates: [
        opts?.harness,
        opts?.sessionHarness ?? (ctx as { harnessSlug?: string | null }).harnessSlug,
      ],
      rigAvailable: opts?.rigAvailable,
    }).catch(() => null);
    if (stamp) {
      drainStamp = stamp;
      effectiveReason = reason ? `${reason} | ${stamp.summary}` : stamp.summary;
    }
  }

  // EI-20199397615670608: PROTECT THE LANE BEFORE CUEING IT TO STAND DOWN.
  // The wind-down cue below tells every member to "release your claims" — and until this
  // leg existed, that release dropped the item straight back into the claimable pool,
  // where the next scheduler:get_next silently resumed the paused work. Complying with
  // the pause was what created the exposure, so the fix belongs HERE and not in member
  // discipline. See pause-holds.ts for why this is a durable park (claim_hold_*) rather
  // than a liveness-bound hold-open lease, and why resume clears only its own marker.
  //
  // ORDER IS LOAD-BEARING: the holds are set BEFORE the cue is sent (step 3), so the
  // fastest-complying member cannot release into an unprotected window. Fails soft on
  // both legs, exactly like the drain stamp above — a hold-write failure must never
  // wedge the control flip, and must never make a fleet impossible to RESUME.
  let pauseHolds: FleetPauseHoldResult | undefined;
  {
    const { applyFleetPauseHolds, clearFleetPauseHolds } = await import('./pause-holds');
    const held =
      action === 'wind-down'
        ? await applyFleetPauseHolds({
            fleetSlug: slug,
            workspaceId,
            byOwnerId: ownerId,
            leaderOwnerId: fleet.leaderOwnerId,
            reason: effectiveReason,
          }).catch(() => null)
        : await clearFleetPauseHolds({ fleetSlug: slug, workspaceId }).catch(() => null);
    if (held && (held.items.length > 0 || held.failed.length > 0)) pauseHolds = held;
  }

  // 2. PERSIST the typed state (idempotent — a re-invoke refreshes reason/by/at).
  const targetState = ACTION_TO_STATE[action];
  const alreadyInState = fleet.controlState === targetState;
  const updated = await setFleetControlState(
    workspaceId,
    slug,
    { state: targetState, reason: effectiveReason, by: ownerId },
    undefined,
    fleet.leaderOwnerId,
  );
  if (!updated) {
    return {
      ok: false,
      error: 'fleet_leadership_superseded',
      message: `Fleet '${slug}' changed leaders after this control action was authorized; re-orient before retrying.`,
    };
  }
  const record: AgentFleetRecord = updated ?? fleet;

  // A wound-down fleet has no live leader-monitoring job to service. Retire the
  // durable transition watches at the same typed state boundary; otherwise every
  // later fleet event keeps waking the former leader after shutdown.
  if (fleet.leaderOwnerId) {
    const { ensureFleetLeaderControl, retireFleetLeaderWatches } = await import('./leader-control');
    if (action === 'wind-down') {
      await retireFleetLeaderWatches(fleet.leaderOwnerId, slug).catch(() => 0);
    } else {
      // Resume is the inverse boundary: restore the leader's monitor loop and exact
      // transition watches so a later fleet failure remains push-driven.
      await ensureFleetLeaderControl({
        workspaceId,
        ownerId: fleet.leaderOwnerId,
        fleetSlug: slug,
        harnessSlug: opts?.harness ?? (ctx as { harnessSlug?: string | null }).harnessSlug,
      }).catch(() => null);
    }
  }

  // EI-203843: make the release durable BEFORE sending the cue. Queued event
  // wakes and cold carry-respawns can arrive after this function returns, so a
  // message alone cannot stop them from re-animating a released member.
  let liveMembers: string[] | undefined;
  if (action === 'wind-down') {
    try {
      liveMembers = (await listFleetControlMembers(slug)).filter((id) => id !== ownerId);
      const releasedAt = new Date().toISOString();
      await Promise.allSettled(
        liveMembers.map((memberOwnerId) =>
          markSessionBriefReleased(memberOwnerId, workspaceId, {
            fleet: slug,
            at: releasedAt,
            by: ownerId,
          }),
        ),
      );
    } catch {
      /* best-effort: registry state remains authoritative for orient admission */
    }
  } else {
    // Clear every matching row, including members that already left presence;
    // clearing only today's live audience would strand their next resume.
    await clearSessionBriefReleasedForFleet(workspaceId, slug).catch(() => 0);
  }

  // 3. CUE the live member set — typed, fleet-scope-stamped, best-effort. A
  // repeat invoke that changed nothing sends no duplicate cue (spam guard);
  // the refreshed row still carries the newest reason/by/at.
  let notified: string[] = [];
  let cueMsgId: string | null = null;
  if (!alreadyInState) {
    try {
      const members =
        liveMembers ??
        (await listFleetControlMembers(slug)).filter((id) => id !== ownerId);
      if (members.length > 0) {
        const { summary } = fleetControlCueText(action, slug, effectiveReason, shortHandle(ownerId));
        const env = await sendMessage(identity, {
          to: members,
          summary,
          bodyWithMsgId: (cueMsgId) =>
            fleetControlCueText(action, slug, effectiveReason, shortHandle(ownerId), cueMsgId).body,
          extra: {
            [CUE_AUTHORITY_FIELD]: fleetScopedCueAuthority(slug),
            ...(action === 'wind-down'
              ? {
                  [EXPECTED_LIFECYCLE_ACK_FIELD]: expectedFleetWindDownAck(slug),
                  wakeOnReply: true,
                }
              : {}),
          },
        });
        notified = members;
        cueMsgId = (env as { msg_id?: string })?.msg_id ?? null;
      }
    } catch {
      /* best-effort: the registry state is the source of truth; orient folds it */
    }
  }

  return {
    ok: true,
    fleet: slug,
    controlState: record.controlState,
    reason: record.controlReason,
    by: ownerId,
    invokedAs,
    ...(alreadyInState ? { alreadyInState: true } : {}),
    notified,
    cueMsgId,
    ...(drainStamp ? { drainStamp } : {}),
    ...(pauseHolds ? { pauseHolds } : {}),
  };
}

/**
 * Wind down the standing fleet minted for a goal.
 *
 * This is deliberately not routed through the public invoker guard: a terminal
 * goal transition is the authority that owns the declaration, while the fleet's
 * recorded leader may already be gone. The actual state/cue/release work stays in
 * applyFleetControl so goal stops and fleet:wind-down cannot drift apart.
 */
export async function windDownGoalFleet(args: {
  workspaceId: string;
  fleetSlug: string;
  goalId: string;
  status: string;
  actor?: string | null;
}): Promise<FleetControlResult> {
  const controller = args.actor?.trim() || 'goal-stop-fanout';
  const ctx: ResolveIdentityCtx = {
    uiClientId: controller,
    workspaceId: args.workspaceId,
    isSuperuser: true,
  };
  return applyFleetControl(
    ctx,
    args.fleetSlug,
    'wind-down',
    `goal ${args.goalId} reached ${args.status} — standing drain fleet wind-down`,
    { skipAuthorization: true, sessionHarness: null },
  );
}
