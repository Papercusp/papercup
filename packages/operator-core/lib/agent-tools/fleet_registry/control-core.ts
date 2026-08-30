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
import { withBoundedTimeout } from '../../bounded-timeout';
import {
  clearSessionBriefReleasedForFleet,
  markSessionBriefReleased,
} from '../../session-brief';

export type FleetControlAction = 'wind-down' | 'resume';

const ACTION_TO_STATE: Record<FleetControlAction, FleetControlState> = {
  'wind-down': 'winding-down',
  resume: 'active',
};

/** Optional control-plane reads/writes must never hold the receipt path indefinitely. */
export const FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS = 2_000;
/** The typed state flip is durable before this bounded best-effort saga starts. */
export const FLEET_CONTROL_RESPONSE_TIMEOUT_MS = 5_000;

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
  /** True when the durable state flip returned before optional release/cue work settled. */
  postControlPending?: boolean;
  /** True when the optional post-flip saga failed before it could return a receipt. */
  postControlDegraded?: boolean;
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
        `(or complete with evidence), release your file locks, and end any armed loop with loop:end. ` +
        'If an autonomy-implying mode remains active without a deliberate independent event await, ' +
        'retry with loop:end { acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true }; alternatively register an events:await ' +
        'wake or exit the mode before ending the loop, then ' +
        `${ackInstruction}. ` +
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

interface FleetControlPostSagaResult {
  effectiveReason: string | null;
  drainStamp?: import('./drain-stamp').FleetDrainStamp;
  pauseHolds?: FleetPauseHoldResult;
  notified: string[];
  cueMsgId: string | null;
  record?: AgentFleetRecord;
  degraded: boolean;
}

/**
 * Start an optional leg and retain its original promise so a dependent leg can
 * wait for settlement after the caller has already received its bounded receipt.
 * `withBoundedTimeout` deliberately does not cancel work; keeping the promise here
 * lets the wind-down saga preserve pause-holds-before-cue even when the hold write
 * outlives the response budget.
 */
async function startBoundedOptional<T>(
  work: Promise<T> | (() => Promise<T>),
  opts: { fallback: T; timeoutMs: number; label: string },
): Promise<{
  result: Awaited<ReturnType<typeof withBoundedTimeout<T>>>;
  settled: Promise<T>;
}> {
  const settled = Promise.resolve().then(() => (typeof work === 'function' ? work() : work));
  return {
    result: await withBoundedTimeout(settled, opts),
    settled,
  };
}

/**
 * Best-effort work after the typed state flip. The response caller is bounded
 * by the outer `withBoundedTimeout` in `applyFleetControl`; this function keeps
 * dependent legs ordered in the background if one of the underlying promises
 * outlives an individual optional-leg budget.
 */
async function runFleetControlPostSaga(args: {
  action: FleetControlAction;
  alreadyInState: boolean;
  ctx: ResolveIdentityCtx;
  effectiveReason: string | null;
  fleet: AgentFleetRecord;
  identity: Parameters<typeof sendMessage>[0];
  ownerId: string;
  slug: string;
  workspaceId: string;
  opts?: {
    harness?: string | null;
    rigAvailable?: boolean;
    sessionHarness?: string | null;
  };
}): Promise<FleetControlPostSagaResult> {
  let effectiveReason = args.effectiveReason;
  let drainStamp: import('./drain-stamp').FleetDrainStamp | undefined;
  let pauseHolds: FleetPauseHoldResult | undefined;
  let record: AgentFleetRecord | undefined;
  let degraded = false;

  if (args.action === 'wind-down') {
    const { buildFleetDrainStamp } = await import('./drain-stamp');
    const stampWork = await startBoundedOptional(
      () =>
        buildFleetDrainStamp({
          fleetSlug: args.slug,
          ownerId: args.ownerId,
          workspaceId: args.workspaceId,
          harnessCandidates: [
            args.opts?.harness,
            args.opts?.sessionHarness ?? (args.ctx as { harnessSlug?: string | null }).harnessSlug,
          ],
          rigAvailable: args.opts?.rigAvailable,
        }),
      { fallback: null, timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:wind-down:drainStamp' },
    );
    if (stampWork.result.degraded) {
      degraded = true;
      // A late stamp must not race the hold/cue legs with a reason that may
      // otherwise be persisted below.
      await stampWork.settled.catch(() => null);
    }
    const stamp = stampWork.result.value;
    if (stamp) {
      drainStamp = stamp;
      effectiveReason = args.effectiveReason ? `${args.effectiveReason} | ${stamp.summary}` : stamp.summary;

      // The state boundary already landed. Refresh only the optional reason
      // metadata so the durable row retains the auto-drain stamp when it is
      // available, without putting the stamp read on the receipt's critical
      // path.
      const reasonWork = await startBoundedOptional(
        () =>
          setFleetControlState(
            args.workspaceId,
            args.slug,
            { state: ACTION_TO_STATE[args.action], reason: effectiveReason, by: args.ownerId },
            undefined,
            args.fleet.leaderOwnerId,
          ),
        {
          fallback: null,
          timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS,
          label: 'fleet:wind-down:reasonStamp',
        },
      );
      if (reasonWork.result.degraded) {
        degraded = true;
        await reasonWork.settled.catch(() => null);
      }
      if (reasonWork.result.value) record = reasonWork.result.value;
    }
  }

  const { applyFleetPauseHolds, clearFleetPauseHolds } = await import('./pause-holds');
  const pauseWork = await startBoundedOptional(
    () =>
      args.action === 'wind-down'
        ? applyFleetPauseHolds({
            fleetSlug: args.slug,
            workspaceId: args.workspaceId,
            byOwnerId: args.ownerId,
            leaderOwnerId: args.fleet.leaderOwnerId,
            reason: effectiveReason,
          })
        : clearFleetPauseHolds({ fleetSlug: args.slug, workspaceId: args.workspaceId }),
    {
      fallback: null,
      timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS,
      label: `fleet:${args.action}:pauseHolds`,
    },
  );
  if (pauseWork.result.degraded) degraded = true;
  const held = pauseWork.result.value;
  if (held && (held.items.length > 0 || held.failed.length > 0)) pauseHolds = held;
  // The cue MUST remain after the hold promise settles. This wait happens in
  // the post-flip saga, so a slow hold cannot take the durable receipt down.
  if (pauseWork.result.degraded) await pauseWork.settled.catch(() => null);

  if (args.fleet.leaderOwnerId) {
    const { ensureFleetLeaderControl, retireFleetLeaderWatches } = await import('./leader-control');
    // The two branches return DIFFERENT types (a retired-watch count vs a control
    // outcome), so inference collapses `T` to whichever branch it sees first and then
    // rejects the other. Only `degraded` is read from this leg, so name the union
    // explicitly instead of forcing the branches to agree on a shape nobody consumes.
    const leaderWork = await startBoundedOptional<number | import('./leader-control').LeaderControlOutcome | null>(
      () =>
        args.action === 'wind-down'
          ? retireFleetLeaderWatches(args.fleet.leaderOwnerId!, args.slug)
          : ensureFleetLeaderControl({
              workspaceId: args.workspaceId,
              ownerId: args.fleet.leaderOwnerId!,
              fleetSlug: args.slug,
              harnessSlug: args.opts?.harness ?? (args.ctx as { harnessSlug?: string | null }).harnessSlug,
            }),
      {
        fallback: null,
        timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS,
        label: `fleet:${args.action}:leaderControl`,
      },
    );
    if (leaderWork.result.degraded) degraded = true;
  }

  let liveMembers: string[] | undefined;
  if (args.action === 'wind-down') {
    const membersWork = await startBoundedOptional(
      () => listFleetControlMembers(args.slug),
      { fallback: [] as string[], timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:wind-down:members' },
    );
    if (membersWork.result.degraded) degraded = true;
    liveMembers = membersWork.result.value.filter((id) => id !== args.ownerId);
    const releasedAt = new Date().toISOString();
    const releaseWork = await startBoundedOptional(
      () =>
        Promise.allSettled(
          liveMembers!.map((memberOwnerId) =>
            markSessionBriefReleased(memberOwnerId, args.workspaceId, {
              fleet: args.slug,
              at: releasedAt,
              by: args.ownerId,
            }),
          ),
        ),
      { fallback: [] as PromiseSettledResult<unknown>[], timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:wind-down:release' },
    );
    if (releaseWork.result.degraded) degraded = true;
  } else {
    const releaseWork = await startBoundedOptional(
      () => clearSessionBriefReleasedForFleet(args.workspaceId, args.slug),
      { fallback: 0, timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS, label: 'fleet:resume:release' },
    );
    if (releaseWork.result.degraded) degraded = true;
  }

  let notified: string[] = [];
  let cueMsgId: string | null = null;
  if (!args.alreadyInState) {
    const cueWork = await startBoundedOptional(
      async () => {
        const members =
          liveMembers ??
          (await listFleetControlMembers(args.slug)).filter((id) => id !== args.ownerId);
        if (members.length === 0) return { notified: [], cueMsgId: null as string | null };

        const { summary } = fleetControlCueText(
          args.action,
          args.slug,
          effectiveReason,
          shortHandle(args.ownerId),
        );
        const env = await sendMessage(args.identity, {
          to: members,
          summary,
          bodyWithMsgId: (cueMsgId) =>
            fleetControlCueText(args.action, args.slug, effectiveReason, shortHandle(args.ownerId), cueMsgId).body,
          extra: {
            [CUE_AUTHORITY_FIELD]: fleetScopedCueAuthority(args.slug),
            ...(args.action === 'wind-down'
              ? {
                  [EXPECTED_LIFECYCLE_ACK_FIELD]: expectedFleetWindDownAck(args.slug),
                  wakeOnReply: true,
                }
              : {}),
          },
        });
        return { notified: members, cueMsgId: (env as { msg_id?: string })?.msg_id ?? null };
      },
      {
        fallback: { notified: [], cueMsgId: null as string | null },
        timeoutMs: FLEET_CONTROL_OPTIONAL_LEG_TIMEOUT_MS,
        label: `fleet:${args.action}:cue`,
      },
    );
    if (cueWork.result.degraded) degraded = true;
    notified = cueWork.result.value.notified;
    cueMsgId = cueWork.result.value.cueMsgId;
  }

  return {
    effectiveReason,
    ...(drainStamp ? { drainStamp } : {}),
    ...(pauseHolds ? { pauseHolds } : {}),
    notified,
    cueMsgId,
    ...(record ? { record } : {}),
    degraded,
  };
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
          `Recover authority first: either call fleet:take-leadership { fleet: "${slug}" } and retry, ` +
          `or keep this caller outside the fleet by using fleet:launch-on-plan { name: "${slug}", ` +
          `leader: "spawn", ... } to install a freshly launched delegated leader; that new leader ` +
          `then calls fleet:${action}.`,
      };
    }
  }

  // 2. PERSIST the typed state FIRST. Every drain stamp, hold, release, leader
  // watch, roster, and cue operation below is optional and runs only after this
  // durable boundary has landed.
  const targetState = ACTION_TO_STATE[action];
  const alreadyInState = fleet.controlState === targetState;
  const updated = await setFleetControlState(
    workspaceId,
    slug,
    { state: targetState, reason: reason ?? null, by: ownerId },
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
  const record: AgentFleetRecord = updated;
  const post = await withBoundedTimeout(
    () =>
      runFleetControlPostSaga({
        action,
        alreadyInState,
        ctx,
        effectiveReason: reason ?? null,
        fleet,
        identity,
        ownerId,
        slug,
        workspaceId,
        opts,
      }),
    {
      fallback: null,
      timeoutMs: FLEET_CONTROL_RESPONSE_TIMEOUT_MS,
      label: `fleet:${action}:post-control`,
    },
  );
  const postResult = post.value;
  const responseRecord = postResult?.record ?? record;

  return {
    ok: true,
    fleet: slug,
    controlState: responseRecord.controlState,
    reason: responseRecord.controlReason,
    by: ownerId,
    invokedAs,
    ...(alreadyInState ? { alreadyInState: true } : {}),
    notified: postResult?.notified ?? [],
    cueMsgId: postResult?.cueMsgId ?? null,
    ...(postResult?.drainStamp ? { drainStamp: postResult.drainStamp } : {}),
    ...(postResult?.pauseHolds ? { pauseHolds: postResult.pauseHolds } : {}),
    ...(post.degraded ? { postControlPending: true } : {}),
    ...(post.degraded || postResult?.degraded ? { postControlDegraded: true } : {}),
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
