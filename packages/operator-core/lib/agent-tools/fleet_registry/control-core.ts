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
import { CUE_AUTHORITY_FIELD, fleetScopedCueAuthority } from '../coordination/cue-authority';
import { hostAudienceResolvers } from '../coordination/audience-host';
import { resolveFleetCaller } from './_shared';
import type { ResolveIdentityCtx } from '../coordination/identity';

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
  error?: string;
  message?: string;
}

/**
 * PURE: classify the invoker's authority over this fleet, or null when they
 * have none. Order: leader beats the pane-kind grants (most specific claim).
 *   - leader — the registry row's recorded leader_owner_id
 *   - queen  — a mug/kettle pane (hive-level control authority)
 *   - owner  — an su pane (the owner's own interactive session; su-as-owner is
 *              the established convention, cf. blender:grade-idea)
 */
export function classifyFleetControlInvoker(input: {
  callerOwnerId: string;
  leaderOwnerId: string | null;
  paneKind: string;
}): 'leader' | 'queen' | 'owner' | null {
  if (input.leaderOwnerId && input.leaderOwnerId === input.callerOwnerId) return 'leader';
  if (input.paneKind === 'mug' || input.paneKind === 'kettle') return 'queen';
  if (input.paneKind === 'su') return 'owner';
  return null;
}

/** The member-facing body for each action's typed cue. */
export function fleetControlCueText(
  action: FleetControlAction,
  fleet: string,
  reason: string | null,
  byHandle: string,
): { summary: string; body: string } {
  if (action === 'wind-down') {
    return {
      summary: `Fleet ${fleet} WIND-DOWN (typed control cue, by ${byHandle})${reason ? `: ${reason}` : ''}`,
      body:
        `Fleet ${fleet} is WINDING DOWN${reason ? ` — reason: ${reason}` : ''}. ` +
        'This is a TYPED, BINDING control cue (registry control_state=winding-down). ' +
        'Finish only the atomic step in hand, then: work_items:checkpoint + release your claims ' +
        '(or complete with evidence), release your file locks, loop:end any armed loop, and ack ' +
        'your leader with a one-line disposition. Do NOT pull new work from this fleet\'s lanes ' +
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
  const invokedAs = classifyFleetControlInvoker({
    callerOwnerId: ownerId,
    leaderOwnerId: fleet.leaderOwnerId,
    paneKind,
  });
  if (!invokedAs) {
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

  // 2. PERSIST the typed state (idempotent — a re-invoke refreshes reason/by/at).
  const targetState = ACTION_TO_STATE[action];
  const alreadyInState = fleet.controlState === targetState;
  const updated = await setFleetControlState(
    workspaceId,
    slug,
    { state: targetState, reason: reason ?? null, by: ownerId },
  );
  const record: AgentFleetRecord = updated ?? fleet;

  // 3. CUE the live member set — typed, fleet-scope-stamped, best-effort. A
  // repeat invoke that changed nothing sends no duplicate cue (spam guard);
  // the refreshed row still carries the newest reason/by/at.
  let notified: string[] = [];
  let cueMsgId: string | null = null;
  if (!alreadyInState) {
    try {
      const members = (await hostAudienceResolvers.listFleetMembers(slug)).filter(
        (id) => id !== ownerId,
      );
      if (members.length > 0) {
        const { summary, body } = fleetControlCueText(
          action,
          slug,
          reason ?? null,
          shortHandle(ownerId),
        );
        const env = await sendMessage(identity, {
          to: members,
          summary,
          body,
          extra: { [CUE_AUTHORITY_FIELD]: fleetScopedCueAuthority(slug) },
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
  };
}
