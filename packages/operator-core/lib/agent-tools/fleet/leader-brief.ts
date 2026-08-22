/**
 * fleet:leader-brief — ONE-call fleet-health brief for a leader's own fleet
 * (fleet-reliability-verification-2026-07-10 P-007).
 *
 * Night-shift lesson (2026-07-09/10, ~45 leader wakes): the leader had to
 * hand-assemble "who's actually working / who's stuck / who hasn't answered
 * me / who's about to compact" EVERY monitor tick from separate presence +
 * assignments + inbox + item reads. This is that assembly, done once,
 * server-side: per-member { sessionState, verdict, lastToolCallAtAgeMs,
 * claims (doing/queued/load), stalled, unanswered directed messages (with
 * age), contextPressure, bench state (parkedOn) }.
 *
 * EI-9943 (session retrospective, fleet p2p-ship 2026-07-11/12): the SAME
 * night-shift pattern recurred one level up — 3 of 5 members ran a live
 * monitor loop for 58/37/19 turns each, structurally blocked on one member's
 * critical-path diagnosis, instead of parking on an event (fleet:bench
 * already existed but nobody staged it). `benchSuggestion` closes that gap:
 * a per-member flag, computed from signals this tool already decorates
 * (`stalled` + `verdict` + `parkedOn` — no new tracking), naming a member
 * that is alive/speaking-or-first-turn-done, not advancing, and not already
 * benched — the leader's one-glance cue to fleet:bench it onto the right gate.
 *
 * Deliberately THIN: it is fleet:assignments' existing decoration pipeline
 * (reconcileWakeability → decorateParkedOn → decorateLoopMonitorStates →
 * decorateMemberVerdicts → decorateProductiveToolCalls →
 * decorateContextPressure → decorateUnansweredDirected — all reused verbatim,
 * reuse-first, no forked logic) filtered to ONE fleet's members and reshaped
 * into a leader-lean per-member row (ages in ms, not raw timestamps; claims
 * collapsed to counts — the fields a leader's relaunch/re-steer/nudge
 * decision actually reads, not the full claim-ledger fleet:assignments
 * carries for the Queen's placement decision).
 *
 * Resolves the target fleet from the caller's authoritative presence membership
 * (launch environment is failure-only fallback) unless `fleet` is passed
 * explicitly (an su monitoring a fleet it didn't launch into). coord:orient's monitor mode folds this in for
 * a fleet leader automatically (see orient.ts) — a leader's monitor wake is
 * then ONE round-trip instead of orient + a separate fleet:assignments scan.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { readFleetLaneHealth } from '../../fleet/lane-health';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import type { AgentIdentity } from '../coordination/identity';
import { getFleet } from '../../agent-fleets-store';
import { takeFleetLeadership } from '../fleet_registry/take-leadership-core';
import {
  ensureFleetLeaderControl,
  resolveFleetLeaderTransitionEventKeys,
  type LeaderControlOutcome,
} from '../fleet_registry/leader-control';
import {
  decideLeadershipDisposition,
  buildNotLeaderNotice,
  type NotLeaderNotice,
  type AutoClaimedNotice,
} from './leadership-disposition';
import { resolvePresenceFleet } from '../coordination/presence-fleet';
import { resolveSelfRef, markSelfRows, type SelfRef } from '../coordination/self-marker';
import { selectFleetPopulation, type FleetPopulationCensus } from './fleet-population';
import { COORD_ROLES } from '../coordination/roles';
import { listFleetRosterDiagnosed } from '../../fleet/fleet-roster';
import type { AgentAssignment } from '../../fleet/assignments';
import { listPresence } from '../coordination/presence';
import { findLiveHost } from '../../events/await/psu-pty-discovery';
import { applyPsuHostAuthority } from '../coordination/liveness-oracle';
import {
  reconcileWakeability,
  decorateParkedOn,
  decorateLoopMonitorStates,
  decorateMemberVerdicts,
  decorateProductiveToolCalls,
  decorateContextPressure,
  decorateUnansweredDirected,
  decorateDirectiveActuation,
  decorateCoordDeafness,
  VERDICT_SPEAKING_FRESH_MS,
  type MemberVerdict,
  type MonitorState,
} from './assignments';
import type { LifecycleBackoffInfo } from '../../harness/routines/loop';
import type { CoordDeafState } from '../coordination/inbox-read-freshness';
import type { SessionState } from '../coordination/presence-wakeability';
import type { WakeMode } from '../coordination/wake-mode';
import type { ContextPressureBucket } from '../coordination/context-pressure';
import type { UnansweredDirectedSummary } from '../coordination/unanswered-directed';
import type { DirectiveActuationSummary } from '../coordination/directive-effect';
import {
  readUnownedCriticalsForFleet,
  readOrphanedInFlightForFleet,
  partitionUnownedCriticalsByOrigin,
  type UnownedCriticalCandidate,
  type OrphanedInFlightCandidate,
} from '../../harness/improvements/unowned-critical-escalation';
import {
  fetchFleetAdmissionBlocks,
  type FleetAdmissionBlock,
} from '../coordination/fleet-scope-admission-blocks';
import type { InvariantEvaluation } from './invariants';
import { listActiveComposedRoots, loadTreeLeaves } from '../../events/await/compose-store';
import {
  listActiveAwaitsForKey,
  listVerifiedWaitTakeoversForSubscribers,
  type VerifiedWaitTakeoverAlert,
} from '../../events/await/store';
import type { TimeoutBehavior } from '../../events/await/types';
import { withBoundedTimeout } from '../../bounded-timeout';
import { fetchGatewayHeadroom } from '../../inference-gateway/observability';
import { buildCapacityReport } from '../../fleet/capacity-dispatch';
import type { AccountProvider } from '../../deployment/account-pool';
import { providerForModel, readProviderAvailability } from './capacity';
import type { FleetBriefDelta } from '../../fleet-brief-delta';
import type { FleetCampaign } from './fleet-campaign';
import { computeMemberIdleVerdict, summariseIdleCauses } from '../../fleet-member-idle-verdict';
import type { MemberIdleCause } from '../../fleet-member-idle-verdict';
import { computePoolReservation } from '../../fleet-pool-reservation';
import { trimToByteBudget } from '../_bound-output';
import { LEADER_BRIEF_SHAPER_BUDGET_CHARS, shapeLeaderBrief } from './leader-brief-shape';

// EI-20226510994156306: a 50-member leader brief previously serialized ~66KB
// before the transport's own result cap. Keep the detailed, verbose rows small;
// the compact memberVerdicts index below preserves every member id + verdict so
// a leader can still identify who needs a targeted follow-up after transport
// trimming.
const LEADER_BRIEF_MEMBER_DETAIL_BUDGET = 8_000;
const LEADER_BRIEF_RESERVATION_DETAIL_BUDGET = 3_500;

export interface LeaderMonitoringBlindAdvisory {
  line: string;
  missingEventKeys: string[];
  arm: {
    tool: 'events:await';
    args: { event: string; note: string };
  };
}

/** Pure verdict over the same live-awaiter meaning written by events:catalog. */
export function computeLeaderMonitoringBlindAdvisory(input: {
  fleetSlug: string;
  eventKeys: readonly string[];
  liveAwaiters: ReadonlyMap<string, number>;
}): LeaderMonitoringBlindAdvisory | undefined {
  const missingEventKeys = input.eventKeys.filter((eventKey) => (input.liveAwaiters.get(eventKey) ?? 0) === 0);
  if (missingEventKeys.length === 0) return undefined;
  return {
    line:
      `You are monitoring blind: ${missingEventKeys.length}/${input.eventKeys.length} required fleet transition ` +
      `event key(s) have live_awaiters:0.`,
    missingEventKeys,
    arm: {
      tool: 'events:await',
      args: {
        event: `@fleet:${input.fleetSlug}`,
        note: `Restore a pushed transition wake for fleet ${input.fleetSlug}; leader control reconciles the durable profile watches.`,
      },
    },
  };
}

/**
 * Read the fleet's exact profile-derived transition keys from the existing
 * event-await store. Discovery is advisory, so any read/resolution failure omits
 * the block instead of degrading the rest of the leader brief.
 */
export async function readLeaderMonitoringBlindAdvisory(
  fleetSlug: string,
  readActiveAwaits: (eventKey: string) => Promise<readonly unknown[]> = listActiveAwaitsForKey,
): Promise<LeaderMonitoringBlindAdvisory | undefined> {
  try {
    const eventKeys = resolveFleetLeaderTransitionEventKeys({ fleetSlug });
    const counts = await Promise.all(
      eventKeys.map(async (eventKey) => [eventKey, (await readActiveAwaits(eventKey)).length] as const),
    );
    return computeLeaderMonitoringBlindAdvisory({
      fleetSlug,
      eventKeys,
      liveAwaiters: new Map(counts),
    });
  } catch {
    return undefined;
  }
}

export interface LeaderBriefMember {
  agentId: string;
  label: string | null;
  fleetRole: string | null;
  /** EI-19931924184335892: `'recorded'` is a LIVE verdict (session ended_at IS NULL) —
   *  it means "not coord-wakeable" (no live inbox-wake await registered), NEVER
   *  "not-live"/dead. Do not read it as evidence to reclaim a claim; cross-check
   *  `lastToolCallAgeMs`/`verdict` before treating any non-`'live'`-looking
   *  sessionState as a reason to act — a session can be `recorded` and actively
   *  making tool calls at the same time. Only `'ended'`/`'suspect'`/`'draining'`
   *  are genuine not-live-or-going-away verdicts. */
  sessionState: SessionState | null;
  /** EI-21125380796386851: whether a directed wake can still reach this row.
   *  `suspect` + true is recoverable; null means the oracle did not resolve. */
  wakeable: boolean | null;
  verdict: MemberVerdict | null;
  wakeMode: WakeMode | null;
  /** Healthy engine-loop lifecycle; null when this is ordinary work. */
  monitorState: MonitorState | null;
  /** Scheduled next engine fire for monitoring/waiting owners. */
  nextFireAt: string | null;
  /** WI-5345: the member's engine loop's armed MODE ('work'|'monitor'), surfaced inline so a
   *  leader can tell a genuinely wedged pure-monitor loop from a healthy work loop that is
   *  simply between items (verdict:monitoring + doing:null looks identical for both without
   *  this) — orthogonal to `monitorState`, which is the lifecycle verdict, not the armed mode.
   *  Null when no active loop. */
  loopMode: 'work' | 'monitor' | null;
  /** EI-19381528967421062: present ONLY while this member's loop is backed off from a
   *  provider wall (rate-limit/usage-cap) — `nextFireAt` above reflects that wait, NOT a
   *  normal cadence tick, and `active:true` alone cannot say so. A leader reading this row
   *  can tell "healthy, next tick in 60s" from "silenced until `until`" without a separate
   *  per-owner `loop:status` call. Absent (not null) when the loop is healthy — matches
   *  `unanswered`/`parkedOn`'s "present only when it matters" convention. See
   *  computeLifecycleBackoff (harness/routines/loop.ts). */
  throttled?: LifecycleBackoffInfo;
  /** ms since the member's last recorded tool call; null = never (still booting). */
  lastToolCallAgeMs: number | null;
  doing: unknown;
  /** Every currently-held work-item id (bounded by the member's actual claim list). */
  workItemIds: string[];
  queuedCount: number;
  load: number;
  /** A held claim has no last_progress_at/taken_at progress in >10min (claim-progress
   *  signal, not liveness). EI-19931924184335892: forced to `false` whenever
   *  `lastToolCallAgeMs` proves the member is speaking right now (within
   *  VERDICT_SPEAKING_FRESH_MS) — a fresh real tool call outranks the checkpoint
   *  heuristic, so this can never read `true` beside a lastToolCallAgeMs that itself
   *  disproves it. */
  stalled: boolean;
  contextPressure: ContextPressureBucket | null;
  /** coord-delivery-residual-gaps P-001: this LIVE member has not read its
   *  coord mail for a whole budget window despite fresh activity — a
   *  coord:send to it will NOT be seen until it wakes/settles. Absent when
   *  reading normally. ('missing' needs a session start time, which the
   *  assignments path doesn't carry — expect 'stale' here; coord:presence
   *  carries the full classification.) */
  coordHook?: CoordDeafState;
  /** Directed messages to this member with no reply/ack yet — absent when none. */
  unanswered?: UnansweredDirectedSummary;
  /** P-013: of YOUR directives to this member that named a required side effect
   *  (`coord:send { expectEffect }`), how many the LEDGER shows were carried out.
   *  Absent when you sent none — never a zeroed block (see decorateDirectiveActuation).
   *  Distinct from `unanswered`: that is what they SAID, this is what happened. */
  directives?: DirectiveActuationSummary;
  /** Active non-inbox-wake events:await keys — a deliberately-benched member.
   *  EI-18732218464905145: a composed (`spec`) registration renders as ONE
   *  `ComposedParkEntry` (its any/all/k-of-n mode + its OWN deadline), never as
   *  flat sibling strings alongside its own leaves — see resolveComposedParkedOn. */
  parkedOn?: Array<string | ComposedParkEntry>;
  /** Authoritative verified-wait failures that require owner wake/takeover. */
  verifiedWaitTakeovers?: VerifiedWaitTakeoverAlert[];
  /** EI-9943: this member is alive/speaking (burning real turns) but its work
   *  is NOT advancing and it is not already benched — the "live-loop-polling
   *  on a peer's critical path" pattern (fleet p2p-ship, 2026-07-11/12: 3 of 5
   *  members ran a live monitor loop for 58/37/19 turns each, structurally
   *  blocked on one member's diagnosis, instead of parking on an event).
   *  A one-glance nudge toward `fleet:bench { member, wakeEvent }` — never
   *  auto-applied, since only the leader knows the right gate to park on. */
  benchSuggestion?: {
    /** EI-18681259560385029: which branch fired. `idle-with-claimable` is the one a
     *  leader must NOT act on by benching — see computeBenchSuggestion. */
    kind: 'stalled-no-mcp' | 'laneless-idle' | 'idle-with-claimable';
    reason: string;
    item: string | null;
    itemTitle: string | null;
  };
  /** EI-18730414627683753: this member has NO self-wake mechanism at all — no active
   *  engine loop, not parked on any event, holding no claim. Nothing will bring it back;
   *  the leader must coord:send { wake: 'required' } it NOW. Independent of
   *  `benchSuggestion` (a laneless-idle member with a healthy armed loop is NOT dormant —
   *  it will re-cycle on its own next tick). See computeDormantAlert. */
  dormant?: true;
  /** ms since the member's last PRODUCTIVE (non-housekeeping) tool call; null = no
   *  productive call on record at all (still booting, or genuinely never done any work).
   *  See HOUSEKEEPING_TOOL_NAMES + computeSpinningAlert. */
  productiveToolCallAgeMs: number | null;
  /** EI-19307414464301772: this member is alive and visibly taking turns
   *  (`lastToolCallAgeMs` fresh — every OTHER liveness surface reads this as healthy)
   *  but its last PRODUCTIVE tool call is stale well past budget — it is burning turns
   *  on nothing but the per-turn housekeeping set. Distinct from `stalled` (housekeeping
   *  calls keep that clock reset) and from `benchSuggestion`'s laneless-idle branch (a
   *  healthy drain member cycling scheduler:get_next is laneless-idle but not spinning —
   *  get_next is productive). See computeSpinningAlert. */
  spinning?: true;
  isSelf?: true;
}

export interface LeaderBriefMemberVerdict {
  agentId: string;
  verdict: MemberVerdict | null;
  idleCause: MemberIdleCause;
}

/**
 * EI-20226510994156306: retain the complete member identity/verdict index even
 * when the verbose `members` rows must be bounded for the MCP/ptool transport.
 * This is deliberately pure and compact: the leader can use the ids to issue a
 * narrow follow-up instead of treating a truncated full-tier fetch as a failure.
 */
export function compactLeaderBriefMemberVerdicts(
  members: ReadonlyArray<{
    agentId: string;
    verdict: MemberVerdict | null;
    idleVerdict: { cause: MemberIdleCause };
  }>,
): LeaderBriefMemberVerdict[] {
  return members.map(({ agentId, verdict, idleVerdict }) => ({
    agentId,
    verdict,
    idleCause: idleVerdict.cause,
  }));
}

/**
 * WI-37161: the SAME shared-inference-pool verdict `fleet:capacity` reports, trimmed to the
 * fields the idle-member alerts below need to tell "queued for inference" apart from "declining
 * work" / "floor-gated". Deliberately a DIFFERENT signal from a member's own `throttled`
 * (LifecycleBackoffInfo) — that fires only once THIS member has personally hit a provider wall
 * and its engine loop backed off; the account POOL can be degraded/exhausted for every member at
 * once while none of them has individually backed off yet (the observed incident: `throttled: 0`
 * fleet-wide while `fleet:capacity` reported `degraded:true, factor:0`).
 */
export interface PoolDegradedState {
  poolExhausted: boolean;
  degraded: boolean;
  /** Pool spare-capacity factor in [0,1] — 0 means no fresh capacity at all. */
  factor: number;
  queueDepth: number | null;
  usableAccounts: number | null;
  availableAccounts: number | null;
}

/**
 * WI-37161: best-effort, fail-soft read of the live inference-pool capacity oracle — reuses
 * `buildCapacityReport` + `readBeeProviderAvailability` VERBATIM (the exact read `fleet:capacity`
 * performs; not forked) so this can never disagree with what a leader sees calling that tool by
 * hand. Fails soft to `null` (UNKNOWN), never to "healthy" — an unread pool state must not
 * silence a real starvation signal, matching this file's `laneGating`/`fleetPaused` convention.
 */
export function fleetCapacityProviderForMembers(
  members: ReadonlyArray<{
    agentId?: string;
    model?: string | null;
    alive?: boolean;
    verdict?: MemberVerdict | null;
  }>,
  agentByOwner: ReadonlyMap<string, 'claude' | 'omp' | 'codex' | null | undefined> = new Map(),
): AccountProvider | null {
  const providers = new Set(
    members
      // Historical identities can remain on the roster after a fleet is respawned onto a
      // different backend. They are not consuming inference now and must not turn a uniform
      // live fleet into an apparent mixed-provider fleet.
      .filter((member) => member.alive !== false && member.verdict !== 'dead')
      .map((member) => {
        const modelProvider = providerForModel(member.model ?? undefined);
        if (modelProvider) return modelProvider;

        // Visible PSU sessions do not have a spawned_agents row, so their roster model_tier
        // is legitimately null. adv_sessions.agent is the authoritative backend for those
        // members. OMP remains unknown here because its provider comes from its model, not
        // from the OMP client itself.
        const agent = member.agentId ? agentByOwner.get(member.agentId) : null;
        if (agent === 'codex') return 'codex';
        if (agent === 'claude') return 'claude';
        return null;
      })
      .filter((provider): provider is AccountProvider => provider != null),
  );
  return providers.size === 1 ? [...providers][0] : null;
}

export async function readPoolDegradedState(
  provider: AccountProvider,
): Promise<PoolDegradedState | null> {
  try {
    const hr = await fetchGatewayHeadroom({ timeoutMs: 1500, provider });
    const accountAvailability = await readProviderAvailability(provider);
    const report = buildCapacityReport(hr, { clampArmed: false, accountAvailability });
    return {
      poolExhausted: report.poolExhausted,
      degraded: report.degraded,
      factor: report.factor,
      queueDepth: report.queueDepth,
      usableAccounts: report.usableAccounts,
      availableAccounts: report.availableAccounts,
    };
  } catch {
    return null;
  }
}

/**
 * WI-37161: true exactly when the shared inference pool is congested ENOUGH that an idle member
 * is more likely queued-for-inference than declining/floor-blocked work. A `poolExhausted` read
 * is sufficient on its own: the capacity writer sets it when the cross-checked provider has no
 * usable accounts, even when the gateway queue is empty because requests cannot be admitted to a
 * real account. A merely `degraded` pool still needs a nonzero gateway queue — an imperfect pool
 * with no queued requests is not currently starving anyone.
 */
function isPoolCongested(p: PoolDegradedState | null | undefined): p is PoolDegradedState {
  return p != null && (p.poolExhausted || (p.degraded && (p.queueDepth ?? 0) > 0));
}

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed).
 *  Two independent branches, both gated on NOT already benched (`parkedOn` empty —
 *  benching an already-benched member is a no-op the leader doesn't need surfaced again):
 *
 *  EI-9943 — a member `speaking`/`first-turn-done` (burning real turns) holding a claim
 *  `stalled` already marks as not-advancing. Reuses `stalled`/`verdict`/`parkedOn` verbatim
 *  (the SAME signals fleet:assignments' stalled_claims / fleet:bench's parkedOn already
 *  compute) — no new tracking, no wake-count state.
 *
 *  EI-13846 — LANELESS-IDLE: a member alive and cycling (any verdict but dead/booted/joined —
 *  NOT restricted to speaking/first-turn-done, since `deriveMemberVerdict` returns a healthy
 *  loop's `monitorState` in preference to those, so a loop-armed member essentially never
 *  reports them) holding ZERO claims and nothing queued. `stalled` can't see this case at all
 *  (it requires load>0). This is the branch closing the incident that motivated EI-9943 in the
 *  first place but that the original, narrower check could never catch: a drained-lane member
 *  cycling get_next-miss -> re-park -> wake with no claim, benchSuggestion staying 0 all
 *  night. */
export function computeBenchSuggestion(
  a: Pick<DecoratedAgent, 'stalled' | 'parkedOn' | 'doing'> & {
    verdict?: MemberVerdict | null;
    // EI-13846: optional (not Pick'd from DecoratedAgent, whose `load`/`queued` are
    // required) so existing call sites that predate the laneless-idle branch keep
    // compiling unchanged — `undefined` reads as "not laneless" (see below), never
    // a false trigger.
    load?: number;
    queued?: readonly unknown[];
    // WI-5973: the fleet LEADER running its monitor loop, correctly (per the
    // documented leader contract) held NO work-item claim — optional so
    // pre-existing call sites keep compiling unchanged; absent reads as "not
    // the leader's own monitor row", never a false suppression.
    fleetRole?: string | null;
    loopMode?: 'work' | 'monitor' | null;
    // EI-19412077774087262: a member at CRITICAL context that claims work ORPHANS the
    // claim — it runs out of context mid-item and dies holding it. So "wake it to claim"
    // is the wrong remedy for exactly that member, and the idle-with-claimable branch
    // below used to prescribe it unconditionally. Optional (same convention as the fields
    // above) so pre-existing call sites keep compiling; absent reads as "no pressure
    // signal", never a false suppression.
    contextPressure?: ContextPressureBucket | null;
    // EI-18833129079136289: a recent real tool call proves the member is actively
    // working between claims, so do not wake it just because the presence snapshot
    // has not reflected its next claim yet. Absent/null remains unknown and keeps the
    // existing fail-open idle diagnosis for callers that have not read liveness.
    lastToolCallAgeMs?: number | null;
  },
  /**
   * EI-18681259560385029: the fleet's LIVE authoritative claimable count (the same
   * `claimableCount` work_items:claimable reports — spec_match AND all ~12 floors),
   * or `null` when it could not be read.
   *
   * THE THREE VALUES ARE THREE DIFFERENT FACTS AND MUST NOT COLLAPSE:
   *   > 0   → the queue is NOT empty; an idle member is a starvation symptom, and
   *           benching it is the WRONG remedy.
   *   === 0 → the queue is empty. EI-18689489507862177: this alone does NOT establish
   *           that the lane is DRAINED — a lane whose every matching row sits behind a
   *           claim floor reads 0 here too, and benching is the wrong remedy for that
   *           one as well. `laneGating` below is what separates the two.
   *   null  → UNKNOWN (read failed / no harness to scope by). Deliberately NOT
   *           folded into 0: doing so would silently restore the exact bug this
   *           parameter fixes — an unchecked "drained or scoped-out" assertion —
   *           and it would do so invisibly, forever. Unknown says so out loud.
   */
  claimableCount?: number | null,
  /**
   * EI-18689489507862177: the PRE-floor half of the same lane read — `matchedByFilter`
   * plus the per-floor `excluded` buckets that `readFleetLaneHealth` already fetches.
   * Absent = the gating was not read on this call; it is never inferred, because
   * inferring it is precisely the bug (see the `=== 0` note above).
   *
   *   matchedByFilter > 0 with claimableCount === 0 → GATED: the backlog exists and is
   *     being withheld by a floor. Bench is actively harmful — it parks the member on a
   *     completion event nothing can fire.
   *   matchedByFilter === 0 with claimableCount === 0 → genuinely drained.
   */
  laneGating?: { matchedByFilter: number; excluded?: Record<string, number> } | null,
  /**
   * EI-18703234178947959: the fleet's OWN durable control state — true when it is
   * `winding-down` (fleet:pause / fleet:wind-down, mig 575). Every idle-member branch
   * below diagnoses idleness as a FAULT and prescribes a remedy (wake it / bench it /
   * widen the spec), which is exactly backwards for a paused fleet: an idle member IS
   * the compliant response to the stand-down its owner ordered, and the claim path
   * (`fleetControlWindDownRefusal` → get_next's `windDown:true`) will refuse it work no
   * matter how many times it is woken.
   *
   * Live 2026-07-26, fleet bug-drain-200k: this brief reported `claimable_now: 2` +
   * `idleWithClaimableAlert` and told the leader to wake all 19 members to "re-run
   * scheduler:get_next", while that very oracle returned `windDown:true` (owner pause
   * standing since 2026-07-21). The 2 rows were real backlog — just real backlog
   * OUTSIDE this fleet's paused scope. Following the advice burns 19 wake-cycles
   * re-discovering the pause, once per polling tick, indefinitely.
   *
   * Deliberately does NOT suppress the `stalled-no-mcp` branch above: a member that
   * still HOLDS a claim and looks wedged during a pause is a genuine fault — indeed it
   * is precisely what blocks the stand-down from completing.
   *
   * `undefined`/absent reads as "not paused" (today's behavior), never a false
   * suppression — an unread control state must not silence a real starvation signal.
   */
  fleetPaused?: boolean | null,
  /**
   * EI-19313376980892266: this member's AUTHORITATIVE concurrency verdict — the same
   * `evaluateClaimConcurrency` result `scheduler:get_next` refuses on, read from
   * `work_items.taken_by` rather than from the presence layer.
   *
   * Why it must be passed in rather than derived from `a.load`: `load`/`workItemIds`
   * come from presence, and a PARKED item retains `taken_by` while dropping out of them.
   * `load === 0 && activeClaims >= 1` is therefore reachable, and in exactly that state
   * this function used to report `idle-with-claimable` for a member the scheduler was
   * structurally refusing. Live 2026-08-02: five members reported idle-with-claimable
   * were all AT CAPACITY; the leader broadcast twice and woke all five (woken:1 verified)
   * demanding work they were forbidden to take.
   *
   * `undefined`/absent reads as "not read on this call" and never suppresses — an
   * unread verdict must not silence a real starvation signal (same fail-open discipline
   * as `fleetPaused` above).
   */
  concurrency?: { blocked: boolean; activeClaims: number; heldIds: string[] } | null,
  /**
   * WI-37161: the live shared-inference-pool verdict (see `isPoolCongested`). Consulted ONLY by
   * the `idle-with-claimable` branch below, and ONLY to change its diagnosis/remedy — a congested
   * pool does NOT suppress the alert (the lane genuinely is not drained), it changes "wake it,
   * check the claim floor" into "it's queued for inference, do not wake, do not bench".
   * `undefined`/`null` reads as "not read on this call" and never suppresses.
   */
  poolCapacity?: PoolDegradedState | null,
): LeaderBriefMember['benchSuggestion'] {
  if ((a.parkedOn?.length ?? 0) > 0) return undefined;
  if (a.verdict === 'speaking' || a.verdict === 'first-turn-done') {
    if (a.stalled) {
      // EI-18679536216711688: `stalled` is derived purely from MCP tool-call
      // recency (tool_invocations), which goes silent by design during a long
      // foreground exec (a test run, a build) — no MCP round-trip happens until
      // the command returns. The prior text ("likely live-loop-polling a peer's
      // critical path") asserted a SPECIFIC, CONFIDENT cause the signal cannot
      // actually distinguish from "mid a long foreground exec" — a live incident
      // saw exactly that: a member mid test-run flagged stalled=true with this
      // fabricated diagnosis, and following the paired remedy (coord:send
      // { endTurn: true }) would have ESC'd a productive turn and destroyed
      // in-flight work. Report the OBSERVATION (no recent MCP call) and the
      // AMBIGUITY honestly instead of naming a wrong cause, and point at the one
      // cheap way to disambiguate before acting.
      return {
        kind: 'stalled-no-mcp',
        reason:
          'no recent MCP tool call while alive and holding a claim — may be genuinely wedged, ' +
          'OR mid a long foreground exec (a test run, a build) that emits no MCP calls until it ' +
          'returns; this signal cannot tell the two apart. Check sessions:timeline for recent ' +
          'local (Edit/Write/Bash) activity BEFORE concluding it is wedged or ending its turn — ' +
          'fleet:bench only once genuinely stuck is confirmed.',
        item: a.doing?.id ?? null,
        itemTitle: a.doing?.title ?? null,
      };
    }
  }
  // WI-5973: a fleet LEADER running its monitor loop (fleetRole:'leader',
  // loopMode:'monitor') is SUPPOSED to hold zero work-item claims — that IS
  // the documented leader contract (monitor each wake: burn-down delta,
  // member liveness, completion-integrity audit, reclaim orphans; the leader
  // itself never pulls from the claim spec). The EI-13846 laneless-idle
  // heuristic below was written for MEMBERS pulling from a claim spec whose
  // lane may have drained — it does not apply to the leader's own row, whose
  // correct steady state IS "no claim, nothing queued". Observed live
  // 2026-07-26: the leader's own row carried this suggestion twice, and
  // FOLLOWING it (benching the leader onto a scoped event) is precisely the
  // failure the leader contract exists to prevent — the one agent responsible
  // for detecting member death would go to sleep. This does NOT suppress the
  // stalled-no-mcp branch above: a leader that DID take on work (load>0) and
  // looks wedged is still a genuine, reportable fault regardless of role.
  if (a.fleetRole === 'leader' && a.loopMode === 'monitor') return undefined;
  // EI-13846: LANELESS-IDLE. `stalled` requires load>0 (a held claim not advancing), so
  // it is structurally blind to a member holding NO claim at all — and `deriveMemberVerdict`
  // returns the loop's `monitorState` (monitoring|waiting|parked-awaiting-capability) BEFORE
  // it ever considers speaking/first-turn-done/stalled, so any loop-armed member (the norm
  // for a drain fleet — every member here runs `loop:arm`) never reports 'speaking' or
  // 'first-turn-done' while its loop is healthy. Together this made benchSuggestion
  // structurally unable to fire for the exact incident it was built to catch: a member
  // whose lane drained kept cycling get_next-miss -> re-park -> wake with ZERO claims,
  // 'monitoring'/'waiting' verdict throughout (54 wakes / 272 tool calls overnight,
  // benchSuggestion stayed 0 the whole time). This branch is independent of `verdict`
  // beyond excluding the dead/booting states below, and independent of `stalled` (there is
  // no claim to be stalled on) — it fires whenever a member is alive, cycling (not merely
  // freshly booted), holds NO claim, has NOTHING queued, and is not already parked on an
  // event (excluded above).
  if (a.verdict == null) return undefined;
  if (a.verdict === 'dead' || a.verdict === 'booted' || a.verdict === 'joined') return undefined;
  // EI-18703234178947959: a PAUSED fleet's idle member is compliant, not starving —
  // see the `fleetPaused` parameter doc. Every branch below would misdiagnose it and
  // prescribe a remedy the claim path itself refuses to honor.
  if (fleetPaused) return undefined;
  if (a.load === 0 && (a.queued?.length ?? 0) === 0 && !a.doing) {
    // EI-19313376980892266: `a.load === 0` is a PRESENCE-layer reading and does NOT mean
    // the scheduler considers this member free — a parked/held item keeps `taken_by`, so
    // it counts against maxConcurrentClaims while contributing nothing to `load`. Every
    // branch below diagnoses idleness and prescribes waking or benching; for a member at
    // capacity both remedies are wrong, and "wake it" is the expensive one (the member
    // burns a turn re-discovering a refusal it cannot act on). Defer to the one oracle
    // instead of re-deriving capacity from a field that cannot see it.
    if (concurrency?.blocked) return undefined;
    // EI-18681259560385029: the ORIGINAL text asserted "likely idle-cycling a drained or
    // scoped-out lane" UNCONDITIONALLY — a confident diagnosis of a fact it never checked.
    // When the queue is actually nonempty that sentence points a leader AWAY from the truth
    // ("lane drained, parking is correct") and its paired remedy (fleet:bench onto an event)
    // is precisely backwards: it puts the member to SLEEP next to work it should be taking.
    // Live 2026-07-26T04:32Z: five members carried this line while claimableCount was 2, and
    // the leader read it and stood the fleet down. Branch on the real number instead.
    if (claimableCount != null && claimableCount > 0) {
      // EI-18833129079136289: `load === 0`/`doing === null` is a presence snapshot,
      // not proof that this member is idle. A fresh tool call is the direct liveness
      // signal for the between-claims window; waking it would interrupt active work
      // and add another request before the member's current claim is visible here.
      if (a.lastToolCallAgeMs != null && a.lastToolCallAgeMs <= VERDICT_SPEAKING_FRESH_MS) {
        return undefined;
      }
      // WI-37161: the shared inference ACCOUNT POOL can be degraded/exhausted while claim
      // floors and the claim spec are perfectly healthy — an idle member here is most likely
      // QUEUED FOR INFERENCE (an in-flight scheduler:get_next or claim call sitting behind a
      // congested gateway), not declining work. `throttled` (LifecycleBackoffInfo, this file's
      // OTHER pool-shaped field) cannot see this: it only lights up once THIS member has
      // personally hit a provider wall and its OWN engine loop backed off, and a member merely
      // queued for inference has done neither. Checked BEFORE contextPressure below because it
      // is the more likely explanation fleet-wide (one congested pool vs. one member's context),
      // though the two are not mutually exclusive.
      //
      // Observed live 2026-08-09, fleet nonp2p-bug-drain: `throttled: 0` fleet-wide while
      // fleet:capacity reported `degraded:true, factor:0, sustainedlyLimitedAccounts:2/2 usable,
      // tier2 queueDepth 28` — the idle members' lastToolCallAgeMs (84s/207s/297s) were
      // consistent with an inference-queue wait, not with declining work. The OLD reason text
      // below ("wake it… if it still takes nothing, that is a claim-floor problem") sent the
      // leader toward work_items:claimable's excludedBreakdown, which in that incident was
      // healthy (claimableCount 293) — every diagnostic road it offered led away from the real
      // cause, and its own prescribed remedy (wake 6 more members) would have pushed 6 more
      // requests into the exact queue that was already starving the fleet.
      if (isPoolCongested(poolCapacity)) {
        return {
          kind: 'idle-with-claimable',
          reason:
            `alive with NO claim and nothing queued while ${claimableCount} item(s) ARE claimable, ` +
            `BUT the shared inference ACCOUNT POOL is ${poolCapacity.poolExhausted ? 'EXHAUSTED' : 'DEGRADED'} ` +
            `right now (factor ${poolCapacity.factor.toFixed(2)}` +
            (poolCapacity.usableAccounts != null ? `, ${poolCapacity.usableAccounts} usable account(s)` : '') +
            (poolCapacity.queueDepth != null ? `, ~${poolCapacity.queueDepth} request(s) already queued at the gateway` : '') +
            ') — this member is most likely QUEUED FOR INFERENCE, not declining work. DO NOT wake it: ' +
            'coord:send wake:required just adds another request behind the same congestion, worsening it. ' +
            'DO NOT fleet:bench it either — the lane is not drained. Re-check fleet:capacity before acting ' +
            'on this member; once it reports degraded:false/poolExhausted:false, THEN wake it if it is still ' +
            'idle a few wakes later.',
          item: null,
          itemTitle: null,
        };
      }
      // EI-19412077774087262: CRITICAL context inverts the remedy. The reason text below
      // prescribes "wake it to claim", which for a member at critical context is precisely
      // the wrong move — it claims, runs out of context mid-item, and dies HOLDING the
      // claim, converting an idle member into an orphaned work-item the leader then has to
      // reclaim. Observed live 2026-08-03T06:2xZ on nonp2p-bug-drain-0801: su-70390c8c sat
      // at contextPressure 'critical' with NO claim while this line told the leader it
      // "should be taking work". The member was in fact correct to hold off. Report the
      // SAME idle-with-claimable fact (the lane genuinely is not drained) but prescribe the
      // ordering that makes claiming safe, rather than a remedy the member must ignore.
      if (a.contextPressure === 'critical') {
        return {
          kind: 'idle-with-claimable',
          reason:
            `alive with NO claim and nothing queued while ${claimableCount} item(s) ARE claimable, ` +
            'BUT this member is at CRITICAL context pressure — it is idle CORRECTLY, not starving. ' +
            'DO NOT wake it to claim: claiming at critical context orphans the claim (it dies mid-item ' +
            'still holding it, which costs you a reclaim on top of the lost turn). DO NOT fleet:bench ' +
            'it either — the lane is not drained. The remedy is ORDERING, not dispatch: it must flush ' +
            '(work_items:checkpoint / loop:checkpoint) then self-compact (session:request-compaction ' +
            '{ autoContinue: true }), and it will pull on the next wake with a clean context. If it is ' +
            'still critical and unclaimed several wakes from now, THAT is the fault worth chasing.',
          item: null,
          itemTitle: null,
        };
      }
      return {
        kind: 'idle-with-claimable',
        reason:
          `alive with NO claim and nothing queued while ${claimableCount} item(s) ARE claimable ` +
          "right now under this fleet's own spec (EI-18681259560385029) — the lane is NOT drained. " +
          'DO NOT fleet:bench this member: benching sleeps it next to work it should be taking. ' +
          'Wake it to re-run scheduler:get_next (coord:send wake:required), and if it wakes and ' +
          'still takes nothing, that is a claim-floor problem — read work_items:claimable\'s ' +
          'excludedBreakdown rather than assuming the member is at fault.',
        item: null,
        itemTitle: null,
      };
    }
    // EI-18689489507862177: `claimableCount === 0` is NOT proof the lane is drained — it is
    // equally the signature of a lane whose rows ALL sit behind claim floors. Live on
    // nonp2p-bug-drain-0725 2026-07-26T07:00Z: 108 rows matched the fleet's own filter while
    // claimable was 0 (federationDetector=50, claimHold=38, needsHuman=11, taken=8) and 5 of
    // 10 members idled. Asserting "VERIFIED drained" there is false, and its paired remedy is
    // actively harmful: fleet:bench sleeps those members on a completion event that cannot
    // fire, because nothing is in flight to complete. Same defect class as the branch above —
    // a confident diagnosis of a fact never checked — so it gets the same treatment: branch on
    // the pre-floor match count, which readFleetLaneHealth already has in hand.
    const gatedFloors = topExcludedFloors(laneGating?.excluded);
    const gated = claimableCount === 0 && (laneGating?.matchedByFilter ?? 0) > 0;
    if (gated) {
      return {
        kind: 'laneless-idle',
        reason:
          `alive with NO claim and nothing queued, but this lane is GATED, not drained: ` +
          `${laneGating?.matchedByFilter} row(s) match this fleet's own filter and 0 survive the ` +
          `claim floors` +
          (gatedFloors.length > 0
            ? ` (${gatedFloors.map(([k, n]) => `${k}=${n}`).join(', ')}; buckets overlap)`
            : '') +
          '. DO NOT fleet:bench this member — benching parks it on a completion event that ' +
          'cannot fire, since nothing is in flight to complete. Act on the floor instead: ' +
          'clear/redirect the dominant exclusion above (work_items:claimable\'s excludedBreakdown ' +
          'names it), or widen the spec via scheduler:set_claim_spec. If the gating is correct ' +
          'and permanent, the honest move is fleet:wind-down, not an idle member.',
        item: null,
        itemTitle: null,
      };
    }
    // Three distinct states remain, and they must not collapse into each other:
    //   drained  — claimable 0 AND the gating read confirmed 0 rows even MATCH the spec.
    //              Only here is the historical bench advice correct.
    //   unknown-gating — claimable 0 but no gating read on this call (a direct unit-test
    //              caller, or a partial read). We know the queue is empty; we do NOT know
    //              whether that is drainage or gating, so we must not claim either.
    //   unknown  — claimable itself unreadable.
    const drainedVerified = claimableCount === 0 && laneGating != null;
    return {
      kind: 'laneless-idle',
      reason:
        'alive with NO claim, nothing queued, and not parked on an event — idle-cycling ' +
        (drainedVerified
          ? "a lane VERIFIED drained right now (0 claimable AND 0 rows even match this fleet's spec) "
          : claimableCount === 0
            ? 'a lane with 0 claimable, though whether that is drainage or claim-floor gating was NOT read on this brief '
            : 'a lane whose claimable queue could NOT be read on this brief (unknown, not verified drained) ') +
        'every wake instead of resting on a scoped completion event (EI-13846). ' +
        (drainedVerified
          ? 'fleet:bench it onto a scoped event, or confirm its claim spec still admits work.'
          : claimableCount === 0
            ? "Read work_items:claimable's excludedBreakdown before benching — a fully-GATED lane looks identical to a drained one from the claimable count alone."
            : 'Check work_items:claimable BEFORE benching — an unread queue is not an empty one.'),
      item: null,
      itemTitle: null,
    };
  }
  return undefined;
}

/**
 * EI-18730414627683753: the DORMANT alert — a member that has gone permanently silent
 * with NO self-wake mechanism whatsoever: no active engine loop (`loopMode` null), not
 * parked on any event (`parkedOn` empty), and holding no claim. Distinct from — and
 * independent of — computeBenchSuggestion's existing `laneless-idle` kind, which fires
 * for the SAME "alive, no claim, nothing queued" shape but does not distinguish a
 * loop-armed member that will re-cycle on its own next tick from one that has genuinely
 * gone silent forever. Both read identically in every existing summary counter
 * (`bench_suggested`/`laneless_idle`), which is exactly how the incident below went
 * undetected: every counter read healthy.
 *
 * Live 2026-07-26 (fleet push-not-poll, plan stop-discarded-dedup-and-audit-server-polling
 * -2026-07-26): 2 of 6 members completed their lane, reported completion correctly with
 * evidence, then went permanently dormant — verdict `first-turn-done`, `loopMode: null`,
 * `nextFireAt: null` — while `members/dead/stalled/orphaned` all read 0 problems. The
 * leader only caught it by manually reading `loopMode`+`nextFireAt` per member row.
 * (The always-armed coord:inbox-wake keepalive is NOT a counterexample: it only fires on
 * a peer/human message, never on a schedule, so it does not put a dormant member back to
 * work on its own.)
 *
 * Deliberately does NOT require the queue to be nonempty (unlike idle-with-claimable) or
 * empty (unlike laneless-idle/floor-starved) — a member with zero self-wake mechanism is
 * equally a problem regardless of what work exists, because NOTHING will bring it back to
 * check. Suppressed for a paused (winding-down) fleet, matching every sibling alert in
 * this file: an idle, loopless member IS the compliant response to an owner-ordered
 * stand-down, not a fault to surface.
 *
 * PURE: exported for direct unit-testing.
 */
export function computeDormantAlert(
  a: Pick<DecoratedAgent, 'load' | 'doing' | 'parkedOn'> & {
    verdict?: MemberVerdict | null;
    loopMode?: 'work' | 'monitor' | null;
    queued?: readonly unknown[];
  },
  fleetPaused?: boolean | null,
): boolean {
  if (fleetPaused) return false;
  if ((a.parkedOn?.length ?? 0) > 0) return false;
  if (a.loopMode != null) return false;
  if (a.load !== 0 || (a.queued?.length ?? 0) !== 0 || a.doing) return false;
  return a.verdict === 'speaking' || a.verdict === 'first-turn-done';
}

/**
 * How long a member's last PRODUCTIVE (non-housekeeping) tool call may lag behind its
 * last call OF ANY KIND before it counts as SPINNING. Generous by design — a healthy
 * loop's cadence is ~60s and legitimate thinking gaps between edits are common; 30 min
 * catches the failure mode this targets (the reported incident ran unnoticed for ~8h)
 * without tripping on normal pacing.
 */
export const SPINNING_BUDGET_MS = 30 * 60_000;

/**
 * EI-19307414464301772: the SPINNING alert. Observed live 2026-08-02 on fleet
 * nonp2p-bug-drain-0801: a member read `sessionState=live, verdict=monitoring,
 * lastToolCallAgeMs≈20s, stalled=false` — HEALTHY on every existing surface — while
 * its last 14 tool calls were entirely `coord:glance`/`activity:report`/
 * `journal:record-turn`/`flags:get`/`sessions:ingest-gate-event`, holding zero claims,
 * for ~8h, with 3 directed messages unanswered that whole time.
 *
 * `lastToolCallAtByOwner` (any tool call) is guaranteed fresh for an agent whose turns
 * are firing at all, so it structurally cannot see this. This alert instead compares it
 * against `lastProductiveToolCallAtByOwner` (see HOUSEKEEPING_TOOL_NAMES): a member alive
 * and visibly ticking (`lastToolCallAgeMs` within budget) whose last PRODUCTIVE call is
 * stale well past the same budget is spinning.
 *
 * Distinct from `stalled` — that requires NO tool call at all for 15 min
 * (VERDICT_STALL_MS), and housekeeping calls keep that clock reset even while nothing
 * productive happens, which is exactly why `stalled` missed the incident above. Also
 * distinct from `benchSuggestion`'s laneless-idle branch, which fires on zero claims
 * ALONE regardless of whether the member's calls are productive — a healthy drain
 * member cycling `scheduler:get_next` between claims is laneless-idle but NOT spinning
 * (`get_next` is a productive, agent-chosen call). Deliberately independent of
 * `load`/claims in the other direction too: a member holding a claim while spinning on
 * housekeeping is the MORE dangerous case (the claim looks alive to every other
 * surface while nothing advances it), not a lesser one, so this does not gate on
 * `load === 0` the way `computeDormantAlert` does.
 *
 * `productiveToolCallAgeMs: null` (no productive call on record at all) NEVER fires
 * this — a freshly-booted or newly-claiming member legitimately has no productive
 * history yet, and asserting "spinning" from an absence would be exactly the kind of
 * false-positive-from-missing-data this file's other alerts (`claimableCount: null`,
 * `laneGating: null`) are built to avoid. PURE: exported for direct unit-testing.
 */
export function computeSpinningAlert(
  a: Pick<DecoratedAgent, 'parkedOn'> & {
    verdict?: MemberVerdict | null;
    lastToolCallAgeMs?: number | null;
    productiveToolCallAgeMs?: number | null;
  },
  fleetPaused?: boolean | null,
  budgetMs: number = SPINNING_BUDGET_MS,
): boolean {
  if (fleetPaused) return false;
  if ((a.parkedOn?.length ?? 0) > 0) return false;
  if (a.verdict == null) return false;
  if (a.verdict === 'dead' || a.verdict === 'booted' || a.verdict === 'joined') return false;
  const lastAge = a.lastToolCallAgeMs;
  if (lastAge == null || lastAge > budgetMs) return false;
  const prodAge = a.productiveToolCallAgeMs;
  if (prodAge == null) return false;
  return prodAge > budgetMs;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * EI-19313376980892266 item C — EVERY ALERT CARRIES ITS FALSIFIER.
 *
 * THE INCIDENT (2026-08-02, this file's own alerts): `idle_with_claimable` reported
 * 5 members idle beside a nonempty queue. All 5 were AT CAPACITY — the scheduler was
 * refusing them on maxConcurrentClaims. The leader broadcast twice and woke all five,
 * demanding work they were structurally forbidden to take.
 *
 * The alert's prose ALREADY said the right thing ("read work_items:claimable's
 * excludedBreakdown rather than assuming the member is at fault"). It was correct and
 * it was ignored, because prose advice gets BELIEVED while a query gets RUN. The fix
 * is therefore not better wording — it is shipping the alert with the command that
 * would DISPROVE it.
 *
 * TWO CONSTRAINTS, both learned the hard way:
 *
 * 1. INDEPENDENCE. Adopted from the ratified `CellFalsifier` contract
 *    (`cell-registry.ts`, D-038 axis 1), whose `measurement` field carries the same
 *    load: "a derived verdict over a raw leg adds interpretation but NO NEW
 *    INFORMATION — it is recomputable from the leg." A falsifier recomputed from the
 *    alert's own inputs can never contradict it, so it launders the alert's confidence
 *    instead of testing it. Each `measurement` below therefore names a reading the
 *    alert did NOT consult.
 *
 * 2. READ-ONLY. A check that mutates is not a check. This is not hypothetical: the
 *    obvious way to ask "would the scheduler admit this member" is
 *    `scheduler:get_next` — which has NO dry-run and ATOMICALLY CLAIMS. A leader
 *    "verifying" an idle-member alert that way claims the item themselves, which is
 *    precisely how this item's own author accumulated 5 claims against a cap of 1
 *    while diagnosing the fleet as idle. `work_items:claimable` is the READ-ONLY
 *    wrapper of that same oracle and is what every falsifier below uses instead.
 *    `alert-falsifier-reality.test.ts` fails the build on a mutating tool.
 *
 * Deliberately NOT auto-executed. Folding the falsifier's result back into the brief
 * would make it one more aggregate on the surface whose over-confidence caused the
 * incident — "a surface that is confidently wrong suppresses the check that would
 * catch it". The leader running it and reading raw output is the point.
 * ────────────────────────────────────────────────────────────────────────────── */
export interface AlertFalsifier {
  /** The tool the check calls. MUST be read-only — enforced by the reality test. */
  tool: string;
  /** The literal runnable one-liner. Its OUTPUT confirms or kills the alert. */
  check: string;
  /** The INDEPENDENT measurement it reads. Must NOT be an input the alert fired on. */
  measurement: string;
  /** The concrete output that KILLS this alert — and what to do instead. */
  kills: string;
}

/**
 * Tools a falsifier may never call, because reading them CHANGES the thing being
 * measured. `scheduler:get_next` and the claim verbs take the item; `fleet:bench`
 * parks the member; `coord:send` wakes it. Enforced by the reality test rather than
 * left to review — the whole family is one plausible-looking edit away from a check
 * that silently claims work on the leader's behalf.
 */
export const FALSIFIER_FORBIDDEN_TOOLS: readonly string[] = [
  'scheduler:get_next',
  'work_items:claim',
  'work_items:claim_next',
  'fleet:bench',
  'coord:send',
];

/**
 * Render a tool call as the literal one-liner a leader can paste. Values are emitted
 * as they must be typed (strings quoted, scalars bare); null/undefined args are
 * dropped so an unresolved fleet/harness degrades to a still-runnable call rather
 * than one carrying `harness: null`. PURE — exported for direct unit-testing.
 */
export function renderFalsifierCall(tool: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : JSON.stringify(v)}`);
  return parts.length > 0 ? `${tool} { ${parts.join(', ')} }` : `${tool} {}`;
}

/**
 * EI-15055 (fleet-members-parked-stall-2026-07-17): the ZERO-WIP-WITH-SUPPLY alert.
 * `parked` was a plain count with no severity — a leader reading `parked:7` next to
 * `unowned_criticals:8` had to notice the juxtaposition itself, and the live incident
 * (2026-07-17 ~14:58: the WHOLE fleet held 0 wip while 8 unowned critical bugs sat
 * unclaimed under a healthy claim-spec) went unnoticed for a while as a result. True
 * exactly when the WHOLE fleet holds no live work (fleet-wide load is 0), at least one
 * member is parked (sleeping on an event — e.g. `work-item:claimable`, which only
 * fires on a NEW create/release/unblock transition and so never wakes a member for
 * supply that already existed before it registered the await), AND known unowned
 * critical supply exists that this fleet's claim spec would admit. A parked member's
 * ~30-min await timeout eventually self-heals, but this lets a leader act NOW instead
 * of waiting out the timeout fleet-wide. PURE: exported for direct unit-testing.
 */
export function computeStrandedFleetAlert(input: {
  totalLoad: number;
  parkedCount: number;
  unownedCriticalCount: number;
  /** Falsifier context — a null harness/fleet still renders a runnable call. */
  harness?: string | null;
  fleet?: string | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  if (input.totalLoad > 0 || input.parkedCount === 0 || input.unownedCriticalCount === 0) return undefined;
  return {
    falsifier: {
      tool: 'work_items:claimable',
      check: renderFalsifierCall('work_items:claimable', {
        harness: input.harness,
        spec: input.fleet,
        breakdownOnly: true,
      }),
      // The alert fires on an unowned-CRITICAL scan, which never consults this
      // fleet's claim spec or the ~12 claim floors. This asks the claim oracle
      // itself whether those rows are actually admissible HERE.
      measurement:
        "post-floor claimable count under this fleet's OWN claim spec — the alert " +
        'counted unowned criticals harness-wide and never consulted the spec or the floors',
      kills:
        'claimableCount 0 → those criticals are NOT admissible to this fleet, so waking the ' +
        'parked members cannot let them claim. Fix the spec/floor (scheduler:set_claim_spec), ' +
        'not the members.',
    },
    reason:
      `fleet-wide wip is 0, ${input.parkedCount} member(s) are parked (sleeping on an event), and ` +
      `${input.unownedCriticalCount} unowned critical(s) this fleet's spec would admit are sitting ` +
      'unclaimed (EI-15055) — the parked event only fires on a NEW create/release/unblock, so it will ' +
      'never wake them for supply that already existed. Do not wait out the park timeout: wake the ' +
      'parked members (coord:send wake:required) so they re-run scheduler:get_next now, or re-verify the ' +
      'claim spec is actually admitting this supply.',
  };
}

/**
 * EI-18655873409999215: the SPEC-STARVED fleet alert — closes a blind spot in
 * computeStrandedFleetAlert (EI-15055) above. That check only fires when unowned
 * criticals THIS FLEET'S SPEC WOULD ADMIT are nonzero — but if the spec itself
 * matches ZERO rows, it admits nothing BY DEFINITION, so unownedCriticalCount is
 * always 0 too and the existing alert can never fire for exactly this shape.
 * Confirmed live 2026-07-25: p2p-release-lane rev7 (an `any:[oldFilter, newClause]`
 * widening revision, statically a superset of the incumbent filter) matched 0 of
 * ~1200 claimable rows for 4.5h — every member reported a clean "nothing
 * claimable, parking" (indistinguishable from a genuinely drained lane), and no
 * surface ever emitted a line about it. The write-time pool-collapse guard
 * (spec-pool-preview.ts) legitimately let this through: a provable-superset
 * revision skips the narrowing/collapse refusal by design (EI-18653814284166347),
 * and the fleet's OWN previous spec had already independently degraded to 0
 * (the noDelta exemption), so no refusal ever fired — only a warning on a single
 * tool-call response nobody was tailing live. This is the STANDING, always-checked
 * half the ticket asked for: "if a fleet's spec had never matched a single row,
 * would any surface emit one line? Today: no."
 *
 * Fires when the fleet holds no live work (mirrors the stranded-fleet shape above)
 * AND its OWN effective claim spec (bee row → fleet row → default) matches 0 rows
 * of a currently-nonempty claimable pool. PURE: exported for direct unit-testing.
 */
export function computeSpecStarvedFleetAlert(input: {
  totalLoad: number;
  specMatched: number;
  poolSize: number;
  harness?: string | null;
  fleet?: string | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  if (input.totalLoad > 0 || input.poolSize === 0 || input.specMatched > 0) return undefined;
  return {
    falsifier: {
      tool: 'work_items:claimable',
      check: renderFalsifierCall('work_items:claimable', {
        harness: input.harness,
        spec: input.fleet,
        breakdownOnly: true,
        sampleExcluded: 3,
      }),
      // This alert fires on previewSpecPoolEffect's PRE-floor compiled-filter count.
      // work_items:claimable is the POST-floor live oracle — a genuinely different
      // measurement (this file already notes the two read ~113 vs 4 on one fleet),
      // so it can contradict the alert rather than restate it.
      measurement:
        "the live claim oracle's POST-floor verdict + per-floor breakdown — the alert fired on " +
        "previewSpecPoolEffect's PRE-floor compiled-filter count, a different measurement",
      kills:
        'matchedByFilter > 0 → the filter IS matching rows and the lane is FLOOR-gated, not ' +
        'spec-starved. Act on the excludedBreakdown; editing view.filter would be the wrong fix.',
    },
    reason:
      `fleet-wide wip is 0 and this fleet's effective claim spec matches 0 of ${input.poolSize} claimable ` +
      'row(s) right now (EI-18655873409999215) — every member\'s scheduler:get_next will report a clean ' +
      'scoped miss, indistinguishable from a genuinely drained lane. Check the spec\'s view.filter (a ' +
      'not:/!= fence over a NULLABLE field, an "=" comparison against an array-typed field like `tags` ' +
      '— use `contains` instead, or a scope that no longer matches any open row) via ' +
      'scheduler:set_claim_spec — do not assume the lane is genuinely drained.',
  };
}

/**
 * fleet-lead-instrumentation-audit-2026-08-09 P-005: the SPEC-AUTHORSHIP alert — a fleet's
 * claim spec can be rewritten by another automated actor with nothing failing loudly.
 *
 * Observed live on this fleet: cup `s-1786236383559` took the spec to rev4, widening `kind`
 * from `[bug]` to `[bug,change]` against an owner-directed BUG scope and pulling ~907 mostly
 * nit/minor items into the lane. It was caught only because the leader happened to re-read
 * the spec by hand that wake — and nothing else COULD have caught it. Every write-time guard
 * in scheduler:set_claim_spec measures the spec's SHAPE (validity, fixed-cohort
 * admissibility, pool COLLAPSE), and a widening passes all of them by construction: the
 * collapse guard exists to catch a lane shrinking to nothing, so a lane growing past its
 * mandate is precisely the direction it is blind to.
 *
 * The signal costs nothing to emit. The brief ALREADY reads this record for the spec-starved
 * preview below and was discarding `updatedBy`/`revision` — so this is not a new probe, it is
 * metadata the existing read already had in hand.
 *
 * Fires when a fleet-level spec exists and its last write is NOT attributable to the agent
 * reading the brief — including an UNATTRIBUTED write (`updatedBy` unset), which is no more
 * verifiable than a foreign one. Stays silent when the reader itself is unresolvable: an
 * unattributable READER cannot be a wronged author, and firing on every unscoped read is how
 * an alert gets trained away. Self-clearing by design — the remedy (re-set the spec, which
 * ratifies the scope under your own authorship) is the same act that silences it.
 * PURE: exported for direct unit-testing.
 */
export function computeSpecAuthorshipAlert(input: {
  readerId: string | null;
  updatedBy: string | null;
  revision: number | null;
  updatedAt: string | null;
  harness?: string | null;
  fleet?: string | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  if (!input.readerId) return undefined;
  if (input.updatedBy && input.updatedBy === input.readerId) return undefined;
  const who = input.updatedBy
    ? `\`${input.updatedBy}\``
    : 'an UNATTRIBUTED writer (the row carries no updated_by)';
  const when = input.updatedAt ? ` on ${input.updatedAt}` : '';
  return {
    falsifier: {
      tool: 'work_items:claimable',
      check: renderFalsifierCall('work_items:claimable', {
        harness: input.harness,
        spec: input.fleet,
        breakdownOnly: true,
        sampleExcluded: 3,
      }),
      // This alert fires on the cup_claim_specs row's AUTHORSHIP columns. The claim oracle
      // reports what the lane now ADMITS — a different question against a different table,
      // so it can contradict the alert instead of restating it.
      measurement:
        'what the lane ACTUALLY admits under the current spec, from the live claim oracle — ' +
        'the alert fired on the spec row\'s updated_by/revision, which say who wrote it and ' +
        'never what it now selects',
      kills:
        'the admitted set matches the scope you intended → the rewrite was an honest merge, ' +
        'not a breach. Ratify it with scheduler:set_claim_spec so the lane carries your ' +
        'authorship again, which also clears this line — do not re-narrow a lane that is correct.',
    },
    reason:
      `this fleet's claim spec was last written by ${who}${when}, at revision ` +
      `${input.revision ?? 'unknown'} — not by you. A third-party rewrite is invisible by ` +
      'construction: set_claim_spec validates the spec\'s SHAPE and refuses a lane that ' +
      'COLLAPSES, so a WIDENING passes every write-time guard (the observed breach took ' +
      '`kind` from [bug] to [bug,change], ~907 extra items against a bug-only mandate). Read ' +
      'the live filter with scheduler:get_claim_spec { fleet } and confirm the scope is the ' +
      'one you intended before trusting what your members are pulling.',
  };
}

/**
 * EI-18681259560385029: the IDLE-WITH-CLAIMABLE alert — the summary-level half of the
 * benchSuggestion wording fix above, and the third distinct hole in this family.
 *
 * The two existing fleet alerts are each structurally unable to fire for this shape:
 *  - computeStrandedFleetAlert (EI-15055) requires `parkedCount > 0` AND
 *    `unownedCriticalCount > 0`. The incident's members were NOT parked (the laneless-idle
 *    branch excludes parked members by construction) and the queued work was `major`, not
 *    `critical` — so it was excluded twice over.
 *  - computeSpecStarvedFleetAlert (EI-18655873409999215) requires `specMatched === 0`, i.e.
 *    a spec matching NOTHING. Here the spec was healthy and matching fine; the work was
 *    claimable and simply unclaimed. Correct by its own definition, blind to this.
 * So "idle members next to a nonempty queue" — the one state a drain fleet must never sit
 * in — had no alert at all, while `bench_suggested: 5` sat in the summary looking benign.
 *
 * Fires when work IS claimable under the fleet's own spec AND at least one member is
 * alive-but-idle (no claim, nothing queued, not parked). Deliberately does NOT require
 * fleet-wide zero wip (unlike both alerts above): a fleet where SOME members work and
 * others idle beside a filling queue is still starving, just more quietly.
 *
 * `claimableCount: null` (unreadable) NEVER fires it — an unknown queue is not evidence of
 * a full one, exactly as it is not evidence of an empty one. PURE: exported for unit-testing.
 */
export function computeIdleWithClaimableAlert(input: {
  claimableCount: number | null;
  idleMemberCount: number;
  /** EI-18703234178947959: the fleet's own control state is winding-down (owner-paused).
   *  Suppresses the alert entirely — see the defence-in-depth note below. */
  fleetPaused?: boolean | null;
  harness?: string | null;
  /** The members this alert is accusing — so its falsifier names a REAL one. */
  idleMemberIds?: readonly string[];
  /** WI-37161: the live shared-inference-pool verdict — see `isPoolCongested`. When the pool is
   *  degraded/exhausted with a nonzero gateway queue, the remedy below flips from "wake them" to
   *  "they're queued for inference, don't wake, re-check fleet:capacity" (same reasoning as the
   *  per-member idle-with-claimable branch in computeBenchSuggestion). `undefined`/`null` reads
   *  as "not read on this call" and never suppresses the alert itself. */
  poolCapacity?: PoolDegradedState | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  // EI-18703234178947959: never tell a leader to wake members of an owner-PAUSED fleet.
  // The rows counted here are real backlog, but backlog OUTSIDE this fleet's paused
  // scope: the claim path refuses it (`windDown:true`), so every wake this alert
  // prescribes is spent re-discovering the pause. Defence-in-depth — `idleMemberCount`
  // is already 0 for a paused fleet because computeBenchSuggestion suppresses the idle
  // branches at source, so this is the second, independent guard that keeps the alert
  // false-positive-proof if a future caller ever feeds it a differently-derived count.
  if (input.fleetPaused) return undefined;
  if (input.claimableCount == null || input.claimableCount <= 0) return undefined;
  if (input.idleMemberCount <= 0) return undefined;
  const accused = input.idleMemberIds?.[0];
  // WI-37161: see computeBenchSuggestion's identical check for the full incident writeup. The
  // summary-level alert must not repeat the same "wake them" advice the per-member branch just
  // stopped giving — a leader reading ONLY the summary (the common case: this is the ONE-glance
  // surface) would otherwise still be told to wake a fleet that is actually inference-queued.
  if (isPoolCongested(input.poolCapacity)) {
    const p = input.poolCapacity;
    return {
      falsifier: {
        tool: 'fleet:capacity',
        check: renderFalsifierCall('fleet:capacity', {}),
        // The live gateway/account-pool oracle — the SAME read this alert now consults, but
        // re-run fresh: capacity moves between the brief's read and the leader acting on it.
        measurement:
          'a FRESH read of the live gateway/account-pool capacity oracle (fleet:capacity) — ' +
          'this alert already consulted it once; re-running confirms the pool is STILL degraded ' +
          'before the leader waits instead of acting',
        kills:
          'degraded:false AND poolExhausted:false → the pool has recovered. If members are still ' +
          'idle beside a nonempty queue at that point, THEN wake them — the old remedy applies again.',
      },
      reason:
        `${input.idleMemberCount} member(s) are alive with NO claim while ${input.claimableCount} ` +
        `item(s) are claimable, BUT the shared inference account pool is ` +
        `${p.poolExhausted ? 'EXHAUSTED' : 'DEGRADED'} right now (factor ${p.factor.toFixed(2)}` +
        (p.usableAccounts != null ? `, ${p.usableAccounts} usable account(s)` : '') +
        (p.queueDepth != null ? `, ~${p.queueDepth} request(s) already queued at the gateway` : '') +
        ') — these members are most likely QUEUED FOR INFERENCE, not declining work. DO NOT wake ' +
        'them: coord:send { wake: "required" } just adds MORE requests behind the same congestion, ' +
        'amplifying the fault (WI-37161). DO NOT fleet:bench them either — the lane is not drained. ' +
        'Re-check fleet:capacity and act only once it reports degraded:false/poolExhausted:false.',
    };
  }
  return {
    falsifier: {
      tool: 'work_items:list',
      check: renderFalsifierCall('work_items:list', {
        harness: input.harness,
        assignee: accused ?? 'self',
        state: 'open',
      }),
      // THE incident this whole falsifier family exists for. The alert's idle count
      // comes from the brief's own per-member load projection; this reads the member's
      // holdings straight from the work-item ledger, which is what that projection is a
      // projection OF — so a member at its concurrency cap shows up here as a held row
      // even when the brief rendered it idle.
      measurement:
        "the named member's ACTUAL open holdings in the work-item ledger — independent of the " +
        "brief's own per-member load projection, which is the reading that mis-rendered " +
        'at-capacity members as idle',
      kills:
        'the member already holds an open item → it is AT its concurrency cap, not idle. The ' +
        'scheduler will refuse it and the wake demands work it is structurally forbidden to ' +
        'take. Repeat per accused member before waking any of them.',
    },
    reason:
      `${input.idleMemberCount} member(s) are alive with NO claim and nothing queued while ` +
      `${input.claimableCount} item(s) are claimable under this fleet's own spec right now ` +
      '(EI-18681259560385029) — idle members beside a nonempty queue is the one state a drain ' +
      'fleet must never sit in. This is NOT a drained lane and benching is the wrong remedy: ' +
      'coord:send { wake: "required" } those members so they re-run scheduler:get_next now. ' +
      'If they wake and still claim nothing, read work_items:claimable\'s excludedBreakdown — ' +
      'a claim floor is holding the rows, not the members.',
  };
}

/**
 * EI-18689489507862177: the FLOOR-STARVED alert — the fourth distinct hole in this family,
 * and the one every preceding alert is structurally unable to see.
 *
 * THE SHAPE: the fleet's spec matches PLENTY of rows, but every one of them is withheld by
 * a claim floor, so `claimable` is 0 while members idle. The backlog is neither missing nor
 * mis-scoped — it is being held.
 *
 * Why each sibling is blind, by its own definition:
 *  - computeStrandedFleetAlert (EI-15055) requires `parkedCount > 0 && unownedCritical > 0`.
 *  - computeSpecStarvedFleetAlert (EI-18655873409999215) requires `specMatched === 0`.
 *    Here specMatched is large — that alert reads the lane as healthy.
 *  - computeIdleWithClaimableAlert (EI-18681259560385029) requires `claimableCount > 0`.
 *    Here it is exactly 0 — that alert reads the lane as drained.
 * So a fleet in this state trips nothing, and `claimable_now: 0` in the summary reads as a
 * clean drain. Confirmed live on nonp2p-bug-drain-0725, 2026-07-26T07:00Z: matchedByFilter
 * 108, claimable 0, 5 of 10 members at load 0 (federationDetector=50, claimHold=38,
 * needsHuman=11, taken=8) — and the per-member line advised benching all five.
 *
 * This is ALSO why the ticket's proposed `laneMatchCount` leader signal would not have
 * worked: on that fleet it reads 108 and looks healthy. The diagnostic pair is
 * (matchedByFilter > 0) AND (claimable === 0) — a match count alone means nothing.
 *
 * `claimable: null` (unreadable) NEVER fires it, mirroring the sibling above: an unknown
 * queue is not evidence of a held one. PURE: exported for direct unit-testing.
 */
export function computeFloorStarvedFleetAlert(input: {
  claimable: number | null;
  matchedByFilter: number | null;
  idleMemberCount: number;
  excluded?: Record<string, number> | null;
  /** EI-18703234178947959: same suppression as the sibling above — a paused fleet's
   *  idle members are complying, and this alert's remedies (clear the floor / widen the
   *  spec / wind the fleet down) are all moot or already done. */
  fleetPaused?: boolean | null;
  harness?: string | null;
  fleet?: string | null;
}): { reason: string; falsifier: AlertFalsifier } | undefined {
  if (input.fleetPaused) return undefined;
  if (input.claimable == null || input.claimable !== 0) return undefined;
  if (input.matchedByFilter == null || input.matchedByFilter <= 0) return undefined;
  if (input.idleMemberCount <= 0) return undefined;
  const floors = topExcludedFloors(input.excluded);
  return {
    falsifier: {
      tool: 'work_items:claimable',
      check: renderFalsifierCall('work_items:claimable', {
        harness: input.harness,
        spec: input.fleet,
        breakdownOnly: true,
        sampleExcluded: 5,
      }),
      // `sampleExcluded` is the row-level companion to the counts. The alert fires on
      // bucket COUNTS alone, and the holders are not recoverable from a count — so the
      // ids are new information, not a re-projection. The distinction matters most for
      // the `taken` bucket, which reads as "gated" but means "being worked".
      measurement:
        'the ROW IDENTITIES behind each floor bucket (excludedSample) — the alert fired on ' +
        'bucket COUNTS alone, from which the held rows and their holders cannot be recovered',
      kills:
        'the dominant bucket is `taken` and its sampled rows are held by live, progressing ' +
        'members → the lane is being WORKED, not gated. Clearing a floor or widening the spec ' +
        'would be the wrong act; there is nothing to fix.',
    },
    reason:
      `${input.idleMemberCount} member(s) are alive with NO claim while this fleet's spec matches ` +
      `${input.matchedByFilter} row(s) of which ZERO survive the claim floors ` +
      (floors.length > 0
        ? `(${floors.map(([k, n]) => `${k}=${n}`).join(', ')}; buckets overlap) `
        : '') +
      '(EI-18689489507862177) — the lane is GATED, not drained, and no other fleet alert can ' +
      'see this state. Do NOT fleet:bench these members: benching parks them on a completion ' +
      'event that cannot fire, because nothing is in flight to complete. Act on the dominant ' +
      'floor above — clear/redirect it, or widen the spec via scheduler:set_claim_spec. If the ' +
      'gating is correct and permanent, this fleet is done: fleet:wind-down is the honest call.',
  };
}

/**
 * The five layers a fleet can be blocked AT, in the order they physically dominate one
 * another. Named as a closed union rather than left implicit in prose because the whole
 * point of the verdict below is that exactly ONE of them is the leader's next action.
 */
export type FleetBlockLayer =
  | 'fleet-paused'
  | 'inference-pool'
  | 'spec-scope'
  | 'claim-floors'
  | 'members';

/** The arbitrated answer to "is my fleet blocked, and AT WHICH LAYER". */
export interface FleetBlockVerdict {
  layer: FleetBlockLayer;
  /** Why THIS layer, stated so the reader can check it against the summary counts. */
  reason: string;
  /** The one action that addresses this layer. Deliberately singular. */
  remedy: string;
  /**
   * Sibling alerts that are TRUE but SUBORDINATE at this layer — named so a leader does
   * not act on them first. Empty is meaningful: nothing else was firing.
   */
  subordinate: string[];
  falsifier: AlertFalsifier;
}

/**
 * fleet-lead-instrumentation-audit-2026-08-09 P-019 (+P-012): the ARBITER over the alert
 * family above.
 *
 * THE GAP THIS CLOSES. Every alert above is individually correct and independently
 * computed, and the brief renders them FLAT. So a starved fleet trips several at once and
 * the leader — who has no precedence rule — picks one. Measured live on `nonp2p-bug-drain`
 * 2026-08-09T02:31Z: `fleet:leader-brief` said "DO NOT bench... wake it to re-run
 * scheduler:get_next" while `fleet:capacity` simultaneously said "place conservatively,
 * prefer a warm-inject over a fresh spawn". Both readings were TRUE. They pointed opposite
 * ways, and the brief offered nothing to choose between them (P-012). The leader-facing
 * question — "is my fleet blocked, and at which layer: pool, floors, spec, or the members
 * themselves?" — had no single answer anywhere (P-019).
 *
 * WHY PRECEDENCE, NOT SEVERITY. The order below is the physical dependency chain, not a
 * ranking of badness. A member cannot claim work without inference capacity; a claim floor
 * cannot be observed to withhold anything from a member that never got a turn. So every
 * lower layer's evidence is MEASURED THROUGH the layers above it, and reading a lower layer
 * while an upper one is blocked yields a confident wrong answer:
 *
 *   1. `fleet-paused`    — the leader paused this fleet. Every idle member is COMPLYING;
 *                          the other layers are not failing, they are switched off.
 *   2. `inference-pool`  — no capacity. Members physically cannot take turns, so they read
 *                          as idle at every other layer. This is the one that inverts the
 *                          remedy: the flat brief's advice here is "wake them", and a wake
 *                          adds another request behind the same congestion (WI-37161).
 *   3. `spec-scope`      — the spec admits nothing. Floors are not the constraint; there
 *                          is nothing for them to withhold.
 *   4. `claim-floors`    — the spec matches plenty and floors withhold all of it.
 *   5. `members`         — capacity fine, queue non-empty, work claimable, members still
 *                          idle. ONLY HERE is "wake them" the right act.
 *
 * The verdict fires only when the fleet is NOT progressing (some member idle, or paused) —
 * a fleet with every member working is not blocked at any layer and returns `undefined`
 * rather than a reassuring "layer: none" row that would just be one more thing to read.
 *
 * FAIL-SOFT DIRECTION. An UNREAD pool (`poolCapacity == null`) never satisfies layer 2, so
 * an unreadable substrate cannot manufacture a pool verdict — but it also must not silently
 * promote layer 5, whose remedy is the harmful one. When the pool is unread and the
 * remaining evidence would name `members`, the verdict says so in `reason` and the
 * falsifier sends the leader to probe the pool FIRST. Same discipline as
 * `readPoolDegradedState`: unknown is stated, never rounded to healthy.
 *
 * PURE: exported for direct unit-testing.
 */
export function computeFleetBlockVerdict(input: {
  fleetPaused?: boolean | null;
  poolCapacity?: PoolDegradedState | null;
  /** Post-floor claimable; null = unread (never folded into 0). */
  claimable: number | null;
  /** Pre-floor spec match count; null = unread. */
  matchedByFilter: number | null;
  /** Members idle beside a NONEMPTY queue (summary.idle_with_claimable). */
  idleMemberCount: number;
  /** Members idle beside an empty/unread queue (summary.laneless_idle). */
  lanelessIdleCount: number;
  harness?: string | null;
  fleet?: string | null;
}): FleetBlockVerdict | undefined {
  const idleTotal = input.idleMemberCount + input.lanelessIdleCount;
  if (!input.fleetPaused && idleTotal <= 0) return undefined;

  // Which siblings are TRUE right now, so a dominant layer can name what it is overruling.
  const firing: string[] = [];
  if (isPoolCongested(input.poolCapacity)) firing.push('pool congested');
  if (input.matchedByFilter === 0) firing.push('specStarvedAlert');
  if (input.claimable === 0 && (input.matchedByFilter ?? 0) > 0) firing.push('floorStarvedAlert');
  if ((input.claimable ?? 0) > 0 && input.idleMemberCount > 0) {
    firing.push('idleWithClaimableAlert');
  }
  const subordinateTo = (mine: string) => firing.filter((f) => f !== mine);

  if (input.fleetPaused) {
    return {
      layer: 'fleet-paused',
      reason:
        `This fleet's own control_state is paused/winding-down, and ${idleTotal} member(s) are ` +
        'idle BECAUSE OF THAT. No other layer is failing — they are switched off. Any alert ' +
        'below is describing a consequence of the pause, not an independent fault.',
      remedy: 'fleet:resume (or finish the wind-down) — nothing else here is actionable first.',
      subordinate: subordinateTo('fleet-paused'),
      falsifier: {
        tool: 'fleet:status',
        check: renderFalsifierCall('fleet:status', { fleet: input.fleet }),
        measurement: "the fleet's live control_state, read independently of this brief's snapshot",
        kills:
          'control_state is NOT paused/winding-down → the pause was lifted between reads; ' +
          're-run the brief and act on the layer it names instead.',
      },
    };
  }

  if (isPoolCongested(input.poolCapacity)) {
    const p = input.poolCapacity;
    return {
      layer: 'inference-pool',
      reason:
        `${idleTotal} member(s) idle while the shared inference pool is congested ` +
        `(factor ${p.factor}, queueDepth ${p.queueDepth ?? 'unknown'}, usableAccounts ` +
        `${p.usableAccounts ?? 'unknown'}). Those members are QUEUED FOR INFERENCE, not ` +
        'declining work — a member that cannot get a turn reads as idle at every other layer, ' +
        'which is why the alerts below fire simultaneously and mean nothing on their own.',
      remedy:
        'Wait for the pool, or add capacity (accounts:scale_out / accounts:link-start). Do NOT ' +
        'coord:send wake:required these members — a wake adds another request behind the same ' +
        'congestion and makes it worse (WI-37161). Do NOT fleet:bench them either: they are ' +
        'ready to work the moment capacity returns.',
      subordinate: subordinateTo('pool congested'),
      falsifier: {
        tool: 'accounts:probe-capacity',
        check: renderFalsifierCall('accounts:probe-capacity', { apply: true }),
        // The pool verdict is derived from a PROJECTION that can go stale while reporting
        // full confidence; the probe is a live upstream read. They are different sources,
        // which is the whole point — see `kills`.
        measurement:
          'the LIVE per-account upstream status (200 vs 429), independent of the cached ' +
          'headroom projection this verdict was computed from',
        kills:
          'accounts answer 200 → the projection is STALE and this verdict is a false positive; ' +
          'the pool is usable and you should re-read the brief for the real layer. Measured ' +
          'twice on 2026-08-09: fleet:capacity reported poolExhausted with usableAccounts 0 ' +
          'while 3 of 4 accounts answered 200. NEVER escalate a pool/egress fault to the owner ' +
          'on the projection alone — probe first.',
      },
    };
  }

  if (input.matchedByFilter === 0) {
    return {
      layer: 'spec-scope',
      reason:
        `${idleTotal} member(s) idle and this fleet's claim spec matches ZERO rows. The floors ` +
        'are not the constraint — there is nothing for them to withhold. The scope itself is ' +
        'the block.',
      remedy:
        'Widen the scope via scheduler:set_claim_spec, or fleet:wind-down if the lane is ' +
        'genuinely finished.',
      subordinate: subordinateTo('specStarvedAlert'),
      falsifier: {
        tool: 'work_items:claimable',
        check: renderFalsifierCall('work_items:claimable', { harness: input.harness }),
        measurement:
          'the HARNESS-WIDE claimable pool, pre-spec-narrowing — a different question from ' +
          "this fleet's spec-scoped match count",
        kills:
          'the harness-wide pool is ALSO 0 → the queue is drained, not mis-scoped; widening ' +
          'the spec finds nothing and fleet:wind-down is the honest call.',
      },
    };
  }

  if (input.claimable === 0 && (input.matchedByFilter ?? 0) > 0) {
    return {
      layer: 'claim-floors',
      reason:
        `${idleTotal} member(s) idle while the spec matches ${input.matchedByFilter} row(s) of ` +
        'which ZERO survive the claim floors. The lane is GATED, not drained, and the pool is ' +
        'healthy — so this is the layer that is actually holding the work.',
      remedy:
        "Act on the dominant floor (work_items:claimable's excludedBreakdown), or widen the " +
        'spec. Do NOT bench these members — benching parks them on a completion event that ' +
        'cannot fire.',
      subordinate: subordinateTo('floorStarvedAlert'),
      falsifier: {
        tool: 'work_items:claimable',
        check: renderFalsifierCall('work_items:claimable', {
          harness: input.harness,
          spec: input.fleet,
          breakdownOnly: true,
          sampleExcluded: 5,
        }),
        measurement:
          'the ROW IDENTITIES behind each floor bucket — this verdict fired on bucket COUNTS, ' +
          'from which the holders cannot be recovered',
        kills:
          'the dominant bucket is `taken` and its rows are held by live, progressing members ' +
          '→ the lane is being WORKED, not gated; there is nothing to clear.',
      },
    };
  }

  if ((input.claimable ?? 0) > 0 && input.idleMemberCount > 0) {
    // The ONLY layer whose remedy is a wake — so it is also the one that must state, out
    // loud, when it was reached without being able to rule the pool out.
    const poolUnread = input.poolCapacity == null;
    return {
      layer: 'members',
      reason:
        `${input.idleMemberCount} member(s) are idle beside ${input.claimable} claimable row(s) ` +
        'with no upstream layer blocking them' +
        (poolUnread
          ? ' — EXCEPT that the inference pool could NOT be read on this brief, so layer 2 was ' +
            'not ruled out. Probe it before acting: this layer is the only one whose remedy ' +
            '(waking members) makes a congested pool WORSE.'
          : ' (pool read and healthy, spec matching, floors clear). The members themselves are ' +
            'the block.'),
      remedy: poolUnread
        ? 'Run the falsifier FIRST. If the pool is genuinely usable, coord:send { wake: "required" } ' +
          'those members so they re-run scheduler:get_next.'
        : 'coord:send { wake: "required" } those members so they re-run scheduler:get_next now.',
      subordinate: subordinateTo('idleWithClaimableAlert'),
      falsifier: poolUnread
        ? {
            tool: 'fleet:capacity',
            check: renderFalsifierCall('fleet:capacity', {}),
            measurement:
              'the inference-pool state this brief could not read — the layer that dominates ' +
              'this one',
            kills:
              'the pool is degraded/exhausted with a nonzero queue → this verdict is WRONG, the ' +
              'real layer is inference-pool, and waking these members worsens it.',
          }
        : {
            tool: 'work_items:claimable',
            check: renderFalsifierCall('work_items:claimable', {
              harness: input.harness,
              spec: input.fleet,
              breakdownOnly: true,
              sampleExcluded: 5,
            }),
            measurement:
              'the row identities behind the claimable count — whether those rows are genuinely ' +
              'available to THESE members',
            kills:
              'the claimable rows are all already `taken` by live members → the members are not ' +
              'idle-by-choice and there is nothing to wake them for.',
          },
    };
  }

  return undefined;
}

/**
 * EI-18681259560385029: IO shell for the alert above — the fleet's live authoritative
 * claimable count, or `null` when it genuinely could not be read.
 *
 * WI-5938: the implementation moved to `lib/fleet/lane-health.ts` so `fleet:bench` can
 * ENFORCE the invariant this file only states in prose ("DO NOT fleet:bench it either —
 * the lane is not drained"). It is re-exported here unchanged; see that module for the
 * full rationale, including why a second claimable count would be a bug rather than a
 * convenience (EI-19313376980892266).
 */
export type { FleetLaneHealth } from '../../fleet/lane-health';

/**
 * The dominant claim floors behind a gated lane, largest first — what the leader must
 * actually act on. Buckets OVERLAP by construction, so this ranks them rather than
 * pretending they partition the matched set.
 */
export function topExcludedFloors(
  excluded: Record<string, number> | null | undefined,
  limit = 3,
): Array<[string, number]> {
  if (!excluded) return [];
  return Object.entries(excluded)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

export type DecoratedAgent = AgentAssignment & {
  sessionState?: SessionState | null;
  wakeable?: boolean | null;
  confirmLiveness?: boolean | null;
  verdict?: MemberVerdict;
  wakeMode?: WakeMode;
  lastToolCallAt?: string | null;
  /** EI-19307414464301772: last tool call excluding HOUSEKEEPING_TOOL_NAMES. */
  productiveToolCallAt?: string | null;
  parkedOn?: string[];
  /** EI-18732218464905145: the leader-legible collapse of `parkedOn` — set by
   *  `decorateComposedParkedOn` when a raw key is a `composed-root:<id>` sentinel.
   *  Absent (or equal to `parkedOn` verbatim) when the member holds no composed
   *  await, or the resolution read failed (fails open to the raw flat list). */
  parkedOnResolved?: Array<string | ComposedParkEntry>;
  verifiedWaitTakeovers?: VerifiedWaitTakeoverAlert[];
  contextPressure?: ContextPressureBucket | null;
  coordHook?: CoordDeafState | null;
  coordLastReadAgoSec?: number | null;
  unanswered?: UnansweredDirectedSummary;
  directives?: DirectiveActuationSummary;
  monitorState?: MonitorState | null;
  nextFireAt?: string | null;
  loopMode?: 'work' | 'monitor' | null;
  lifecycleBackoff?: LifecycleBackoffInfo | null;
};

/**
 * EI-18732218464905145 (the WI-6095/EI-18731480441007330 false-deadlock incident):
 * a composed `events:await { spec }` registration stores ONE root node (its own
 * deadline/timeout-behavior, on `event_await_nodes`) plus N sibling LEAF rows on
 * `event_awaits` (each with `expires_ts: NULL` by design — the root owns it), and
 * an anchor `event_awaits` row keyed `composed-root:<rootId>` that
 * `listParkedAwaitsForSubscribers` (the shared read behind `parkedOn` everywhere:
 * fleet:assignments, coord:presence, this brief) returns as just another flat key.
 * The result: a leader reading `parkedOn` sees the root sentinel and its leaves as
 * N independent, seemingly-unbounded waits — exactly the misreading that produced a
 * false "permanent unbreakable deadlock" diagnosis live on this fleet. This type is
 * the single structured replacement: one entry per composed tree, carrying the
 * `any`/`all`/`k-of-n` semantics and the EFFECTIVE deadline in the same place a
 * leader already looks.
 */
export interface ComposedParkEntry {
  kind: 'composed';
  rootId: number;
  /** Derived from requiredCount vs. leaf count — 'any' (require 1), 'all'
   *  (require === total), or 'k-of-n' for anything in between. */
  mode: 'any' | 'all' | 'k-of-n';
  required: number;
  of: number;
  leaves: string[];
  /** The root node's OWN deadline — never NULL for a real timed composed await,
   *  unlike a leaf row's (always-NULL-by-design) expires_ts. */
  expiresTs: string | null;
  onTimeout: TimeoutBehavior;
}

/**
 * PURE (no I/O — unit-tests without PG): collapse a member's raw flat `parkedOn`
 * keys into the leader-legible form. A `composed-root:<id>` sentinel with a
 * resolved tree in `composedTrees` becomes ONE `ComposedParkEntry`, and every raw
 * key that is one of THAT tree's own leaves is dropped from the flat list (it is
 * now represented inside the entry, not duplicated beside it) — closing the "the
 * root is listed as a sibling of its own leaves" defect verbatim. A composed
 * sentinel with NO matching tree (the async lookup failed, or raced a fire/cancel)
 * is left as its raw string — fail OPEN, never silently drop information the raw
 * read actually returned. Every other (ordinary, non-composed) key passes through
 * unchanged.
 */
export function resolveComposedParkedOn(
  rawKeys: readonly string[],
  composedTrees: ReadonlyMap<
    number,
    { required: number; leaves: readonly string[]; expiresTs: string | null; onTimeout: TimeoutBehavior }
  >,
): Array<string | ComposedParkEntry> {
  if (rawKeys.length === 0) return [];
  const consumedLeafKeys = new Set<string>();
  const composedEntries: Array<string | ComposedParkEntry> = [];
  for (const key of rawKeys) {
    const m = /^composed-root:(\d+)$/.exec(key);
    if (!m) continue;
    const rootId = Number(m[1]);
    const tree = composedTrees.get(rootId);
    if (!tree) {
      composedEntries.push(key); // fail open: unresolved tree — keep the raw sentinel visible
      continue;
    }
    for (const leaf of tree.leaves) consumedLeafKeys.add(leaf);
    const of = tree.leaves.length;
    const mode: ComposedParkEntry['mode'] = tree.required >= of && of > 0 ? 'all' : tree.required <= 1 ? 'any' : 'k-of-n';
    composedEntries.push({
      kind: 'composed',
      rootId,
      mode,
      required: tree.required,
      of,
      leaves: [...tree.leaves],
      expiresTs: tree.expiresTs,
      onTimeout: tree.onTimeout,
    });
  }
  const plainKeys = rawKeys.filter((key) => !/^composed-root:\d+$/.test(key) && !consumedLeafKeys.has(key));
  return [...composedEntries, ...plainKeys];
}

/**
 * Resolve composed-await park state for a batch of agents (best-effort, per-agent
 * bounded, fail-soft): only agents whose raw `parkedOn` contains a
 * `composed-root:<id>` sentinel are read at all — the common case (an ordinary,
 * non-composed park, or no park) costs nothing extra. A read failure for one
 * agent's tree never blocks the others, and never blocks the brief as a whole —
 * it simply leaves that agent's `parkedOnResolved` unset, so `projectMember`
 * falls back to the raw flat list exactly as before this fix. Mutates in place,
 * matching `decorateParkedOn`'s own contract.
 */
export async function decorateComposedParkedOn<T extends { agentId: string } & Pick<DecoratedAgent, 'parkedOn' | 'parkedOnResolved'>>(
  agents: T[],
  deps: {
    listActiveComposedRoots?: typeof listActiveComposedRoots;
    loadTreeLeaves?: typeof loadTreeLeaves;
  } = {},
): Promise<T[]> {
  const listRoots = deps.listActiveComposedRoots ?? listActiveComposedRoots;
  const loadLeaves = deps.loadTreeLeaves ?? loadTreeLeaves;
  const candidates = agents.filter((a) => (a.parkedOn ?? []).some((k) => /^composed-root:\d+$/.test(k)));
  if (candidates.length === 0) return agents;
  await Promise.all(
    candidates.map(async (a) => {
      try {
        const rootsProbe = await withBoundedTimeout(listRoots(a.agentId), {
          fallback: [],
          timeoutMs: 1_500,
          label: 'leader-brief:composedParkedOn:roots',
        });
        const treeMap = new Map<
          number,
          { required: number; leaves: readonly string[]; expiresTs: string | null; onTimeout: TimeoutBehavior }
        >();
        await Promise.all(
          rootsProbe.value.map(async (root) => {
            const leavesProbe = await withBoundedTimeout(loadLeaves(root.id), {
              fallback: [],
              timeoutMs: 1_500,
              label: 'leader-brief:composedParkedOn:leaves',
            });
            treeMap.set(root.id, {
              required: root.requiredCount,
              leaves: leavesProbe.value.map((l) => l.eventKey),
              expiresTs: root.expiresTs,
              onTimeout: root.timeoutBehavior,
            });
          }),
        );
        a.parkedOnResolved = resolveComposedParkedOn(a.parkedOn ?? [], treeMap);
      } catch {
        /* best-effort — a resolution failure must never block the brief; parkedOn stays flat */
      }
    }),
  );
  return agents;
}

/**
 * PURE: scope the leader brief from the same presence-primary roster used by
 * fleet:status. Keeping this projection separate makes the membership parity
 * contract explicit: a live presence member is never dropped merely because
 * its assignment leg has no claim row yet.
 *
 * P-010: returns the CENSUS beside the rows. The membership filter here is
 * two-stage and only the second stage is discretionary — `fleetSlug === fleet`
 * decides who is on the roster at all, while the stale-idle cut decides who this
 * RESPONSE shows. Only the second is counted as `withheld`, because a member of
 * another fleet was never a candidate for this number; folding them in would make
 * `withheld` grow with unrelated fleets and read as mass concealment.
 */
export function selectLeaderBriefMembers(
  entries: readonly DecoratedAgent[],
  fleet: string,
  includeStale = false,
): { rows: DecoratedAgent[]; census: FleetPopulationCensus } {
  const ofThisFleet = entries.filter((entry) => entry.fleetSlug === fleet);
  return selectFleetPopulation(
    ofThisFleet,
    (entry) => includeStale || entry.claims.length > 0 || entry.alive,
    {
      population: `member(s) of fleet '${fleet}'`,
      basis:
        'A row is on the roster if presence records it in this fleet; it is shown here if it holds ' +
        'a claim or is alive (heartbeat-fresh), or unconditionally under include_stale.',
      withheldReason:
        'idle AND not heartbeat-fresh (stale-idle) — note this hides members precisely when they ' +
        'are dying, which is when the count matters most',
      reveal: 'include_stale: true',
    },
  );
}

/**
 * Reconcile a visible member's parked/wakeable projection with the psu-host
 * liveness authority. A dead host can leave a fresh heartbeat and inbox-wake
 * await behind, which otherwise makes leader-brief report a dead owner as
 * parked/wakeable. Nursery cups remain governed by their nursery state.
 */
export function reconcilePsuHostLiveness<T extends DecoratedAgent>(
  agents: T[],
  agentRoles: ReadonlyMap<string, string | null>,
  findHost: (ownerId: string) => unknown | null = findLiveHost,
): T[] {
  // Unification P-005: the rule itself now lives in the shared liveness
  // oracle (applyPsuHostAuthority) so it is no longer leader-brief-private —
  // any surface whose cohort is known-psu-hosted applies the SAME authority.
  return applyPsuHostAuthority(agents, agentRoles, findHost);
}

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed).
 *  `claimableCount` (EI-18681259560385029) is the fleet-wide live claimable total threaded
 *  into the per-member bench suggestion; `null`/omitted reads as UNKNOWN, never as 0. */
export function projectMember(
  a: DecoratedAgent,
  nowMs: number,
  claimableCount?: number | null,
  /** EI-18689489507862177: pre-floor match + per-floor exclusions, so the bench
   *  suggestion can tell a GATED lane from a drained one. Absent = not read. */
  laneGating?: { matchedByFilter: number; excluded?: Record<string, number> } | null,
  /** EI-18703234178947959: the fleet's own control_state is winding-down (owner-paused),
   *  so an idle member is compliant and carries no bench suggestion. Absent = not paused. */
  fleetPaused?: boolean | null,
  /** EI-19313376980892266: this member's authoritative concurrency verdict from the shared
   *  oracle (work_items.taken_by), NOT the presence layer's `load`. Absent = not read on
   *  this call, which suppresses nothing. */
  concurrency?: { blocked: boolean; activeClaims: number; heldIds: string[] } | null,
  /** WI-37161: the live shared-inference-pool verdict — see computeBenchSuggestion's
   *  `poolCapacity` param. Absent = not read on this call, which suppresses nothing. */
  poolCapacity?: PoolDegradedState | null,
): LeaderBriefMember {
  const lastMs = a.lastToolCallAt ? Date.parse(a.lastToolCallAt) : NaN;
  const prodMs = a.productiveToolCallAt ? Date.parse(a.productiveToolCallAt) : NaN;
  const lastToolCallAgeMs = Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : null;
  const productiveToolCallAgeMs = Number.isFinite(prodMs) ? Math.max(0, nowMs - prodMs) : null;
  // EI-19931924184335892: `a.stalled` is the raw per-CLAIM rollup (any held claim
  // with no last_progress_at/taken_at progress in >10min — see the fleet_assignment
  // view) — a claim-progress-checkpoint signal, NOT a liveness signal. It is already
  // suppressed by decorateLoopMonitorStates when the member's engine loop reports
  // itself healthy, but that suppression is contingent on the LOOP's own (separately
  // flaky — WI-6639) self-assessment, so it can miss. A fresh real tool call
  // (`lastToolCallAgeMs` within the same VERDICT_SPEAKING_FRESH_MS window this file
  // already uses everywhere else to mean "really working right now" — see
  // deriveMemberVerdict's `speaking` leg) is a STRONGER, more direct liveness proof
  // than either signal, so it overrides the same way here: a leader reading this row
  // must never see `stalled:true` beside a lastToolCallAgeMs that itself proves the
  // opposite. Live incident: sessionState:'recorded' (a LIVE-but-not-wake-dispatchable
  // state, not a "not-live" verdict as it was misread) + stalled:true +
  // lastToolCallAgeMs:~53000 led a leader to force-release a claim the holder closed,
  // with a committed evidenced fix, 8 minutes later.
  const speakingNow = lastToolCallAgeMs != null && lastToolCallAgeMs <= VERDICT_SPEAKING_FRESH_MS;
  return {
    agentId: a.agentId,
    label: a.label,
    fleetRole: a.fleetRole ?? null,
    sessionState: a.sessionState ?? null,
    wakeable: a.wakeable ?? null,
    verdict: a.verdict ?? null,
    wakeMode: a.wakeMode === 'auto' || a.wakeMode === 'manual' ? a.wakeMode : null,
    monitorState: a.monitorState ?? null,
    nextFireAt: a.nextFireAt ?? null,
    loopMode: a.loopMode ?? null,
    ...(a.lifecycleBackoff ? { throttled: a.lifecycleBackoff } : {}),
    lastToolCallAgeMs,
    productiveToolCallAgeMs,
    doing: a.doing,
    workItemIds: a.claims
      .filter((claim) => claim.type === 'work-item' && claim.id)
      .map((claim) => claim.id as string),
    queuedCount: a.queued.length,
    load: a.load,
    stalled: a.stalled === true && !speakingNow,
    contextPressure: a.contextPressure ?? null,
    ...(a.coordHook ? { coordHook: a.coordHook } : {}),
    ...(a.unanswered ? { unanswered: a.unanswered } : {}),
    ...(a.directives ? { directives: a.directives } : {}),
    ...(() => {
      // EI-18732218464905145: prefer the composed-collapsed view when one was
      // resolved; fall back to the raw flat list (unresolved / non-composed /
      // resolution-failed) exactly as before this fix.
      const parked = a.parkedOnResolved ?? a.parkedOn;
      return parked && parked.length > 0 ? { parkedOn: parked } : {};
    })(),
    ...(a.verifiedWaitTakeovers && a.verifiedWaitTakeovers.length > 0
      ? { verifiedWaitTakeovers: a.verifiedWaitTakeovers }
      : {}),
    ...(() => {
      const suggestion = computeBenchSuggestion(
        { ...a, lastToolCallAgeMs },
        claimableCount,
        laneGating,
        fleetPaused,
        concurrency,
        poolCapacity,
      );
      return suggestion ? { benchSuggestion: suggestion } : {};
    })(),
    ...(computeDormantAlert(a, fleetPaused) ? { dormant: true } : {}),
    ...(computeSpinningAlert(
      { ...a, lastToolCallAgeMs, productiveToolCallAgeMs },
      fleetPaused,
    )
      ? { spinning: true }
      : {}),
  };
}

export default defineTool({
  name: 'fleet:leader-brief',
  profile: 'engineer',
  description:
    "A leader's ONE-call health brief for ONE fleet (yours by default). Per member: " +
    'sessionState, `wakeable`, `verdict`, wakeMode, ' +
    'lastToolCallAgeMs, claims (doing/workItemIds/queuedCount/load), loop state+nextFireAt, ' +
    'stalled, unanswered, contextPressure, parkedOn + parkedOnResolved, benchSuggestion, ' +
    '`dormant`, `spinning`, `throttled` (backed off from a provider wall — nextFireAt is ' +
    'a wait, not a tick; see `throttled.until`/`.reason`), ' +
    'unownedCriticals + unownedCriticalsFederated + abandonedUnclaimed.',
  guidance: {
    when:
      'AFTER a wake: "who is working / stuck / unanswered / about to compact across MY fleet". ' +
      'PARK, do not poll: events:await the fleet:*:<slug> keys (events:catalog) + ' +
      'work-item:claimable; loop:arm is then a LONG fallback heartbeat (15m+), never the ' +
      "monitor. Folded into coord:orient { mode:'monitor' }. " +
      'Spec: agent-insights/leading-a-fleet-without-polling.',
    notWhen:
      'Mug/placement read over the WHOLE roster (fleet:assignments), ' +
      "or a member's message history (coord:inbox { agent }).",
    chaining:
      'A stalled/dead member → fleet:kill + relaunch, or a directed coord:send nudge. A nonzero ' +
      '`unanswered` → coord:send a follow-up or coord:catch-up. `benchSuggestion` set → ' +
      'fleet:bench onto the blocked-on gate; `dormant:true` → wake, never bench. ' +
      '`spinning:true` → coord:send{wake:"required"}. ' +
      'Nonzero `unownedCriticals`/`abandonedUnclaimed` → CLAIM it (release=no-op); the ' +
      '`…Federated` sibling is remote + unclaimable (WI-6846). ' +
      'Every `*Alert` ships `*AlertFalsifier` — RUN its `check` before acting; it confirms or ' +
      'KILLS the alert.',
    // Not counted against the P-011 prompt-weight budget (description + when/notWhen/
    // chaining are) — response documentation belongs here, demand-loaded via tools:find.
    returns:
      '`blockedAt` — READ IT FIRST. The arbitrated answer to "is my fleet blocked, and at ' +
      'WHICH layer": one of fleet-paused | inference-pool | spec-scope | claim-floors | ' +
      'members, with a single `remedy`, the `subordinate` alerts it overrules, and a ' +
      '`falsifier`. Absent ⇒ no layer is blocking (every member working), NOT "unknown". ' +
      'It exists because the `*Alert` booleans in `summary` are flat and CO-FIRE: a starved ' +
      'fleet trips several at once and they prescribe opposite acts (measured 2026-08-09 — ' +
      'the brief said "wake them" while fleet:capacity said "place conservatively"; both ' +
      'true). The layers are a physical dependency chain, not a severity ranking — each ' +
      "lower layer's evidence is measured THROUGH the ones above it, so a member starved of " +
      'inference reads as idle at every layer below. At `inference-pool` the flat advice ' +
      'inverts: a wake adds another request behind the same congestion and makes it WORSE ' +
      '(WI-37161). `members` is the ONLY layer whose remedy is a wake, and when the pool ' +
      'could not be read it says so rather than silently promoting itself.',
  },
  capability: 'work_items:read',
  // The default full response is intentionally rich, but the direct MCP result
  // door is smaller than a fleet-wide diagnostic. The domain shaper preserves
  // blockedAt + aggregate health + bounded intervention rows before the door can
  // cut JSON in the middle of the envelope. Explicit payloadTier:'full' remains
  // the unshaped escape hatch for programmatic/narrow callers.
  shape: {
    standard: (data) => shapeLeaderBrief(data, 'standard'),
    trimmed: (data) => shapeLeaderBrief(data, 'trimmed'),
  },
  payloadTierCeilingChars: LEADER_BRIEF_SHAPER_BUDGET_CHARS,
  requirePrincipal: false,
  // EI-20192040030675541: this supervision read owns its individual
  // workspace-scoped reads and never touches ctx.tx. Keeping the dispatcher's
  // ambient transaction open across the roster/decorations/diagnostic awaits
  // pins an org-app pool slot and can leave the leader blind behind the 45s
  // acquisition deadline when the fleet is saturated.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    fleet: z
      .string()
      .max(120)
      .optional()
      .describe("Fleet slug to brief. Defaults to the caller's current presence membership (launch environment is a failure-only fallback) — pass explicitly when monitoring a fleet you didn't launch into."),
    harness: z.string().max(80).optional(),
    workspace: z.string().max(120).optional(),
    include_stale: z
      .boolean()
      .optional()
      .describe('Also include members with no claims and a stale heartbeat (default false — dead/idle noise).'),
    unowned_critical_age_hours: z
      .number()
      .min(0)
      .max(168)
      .optional()
      .describe(
        'WI-5213: hours an unassigned critical must age before it surfaces here (0 = immediate; max 168). Default 4.',
      ),
    orphan_min_age_minutes: z
      .number()
      .min(0)
      .max(1440)
      .optional()
      .describe('Minutes an orphaned in-flight item must sit before it surfaces here. Default 0.'),
    since: z
      .string()
      .max(40)
      .optional()
      .describe(
        "P-022: measure `delta` from this ISO timestamp instead of your last wake. The snapshot-only axes (pool factor, prior spec revision) have no history to re-read at an arbitrary time and stay unavailable — they are never back-filled from a boundary they did not observe.",
      ),
  }),
  async handler(args, ctx) {
    let actorWorkspace: string | null = null;
    let ownerId: string | undefined;
    // P-004/D-096: kept beyond the destructure because takeFleetLeadership needs
    // the whole identity (it heartbeats presence to label the new leader's row).
    let agentIdentity: AgentIdentity | undefined;
    try {
      const identity = resolveAgentIdentity(ctx);
      agentIdentity = identity;
      actorWorkspace = identity.workspaceId ?? null;
      ownerId = identity.ownerId;
    } catch {
      actorWorkspace = null;
    }
    return buildLeaderBrief(args, {
      agentIdentity,
      ownerId,
      actorWorkspace,
      self: resolveSelfRef(ctx),
      // An AGENT calling its own brief is the case leadership bookkeeping was
      // written for: a fleet nobody leads is how a whole fleet dies unnoticed,
      // so the caller is installed when the seat is empty.
      allowLeadershipWrites: true,
      resolveCallerMembership: true,
    });
  },
});

/**
 * Who the brief is computed AS, and what that caller is permitted to do.
 *
 * Extracted (popup-agent-state-coverage-2026-08-18 P-002) so a READ-ONLY viewer
 * — the HUD conversation popup, showing a leader what that leader itself reads —
 * can compute the identical brief without inheriting the tool handler's two
 * agent-shaped behaviours, both of which are wrong for a viewer and neither of
 * which a `payloadTier`/args knob could have turned off:
 *
 *  1. LEADERSHIP WRITES. `fleet:leader-brief` deliberately CLAIMS an empty
 *     leader seat (`takeFleetLeadership`) and refreshes the control row
 *     (`ensureFleetLeaderControl`). Correct for an agent; catastrophic for a
 *     UI read — opening a popup would install the human's session as leader of
 *     someone else's fleet, demoting whoever held it. `allowLeadershipWrites:
 *     false` skips BOTH; the `notLeader` NOTICE is still produced, because that
 *     is a read.
 *  2. AMBIENT FLEET RESOLUTION. The handler falls back to the CALLER's presence
 *     membership (and then the launch environment) when `fleet` is omitted. In
 *     the operator process that resolves to whatever fleet the operator itself
 *     was launched into — a real answer to the wrong question. A viewer passes
 *     `resolveCallerMembership: false` and MUST name the fleet.
 *
 * Everything else is identical by construction: this is the same function, not
 * a parallel reimplementation, so the popup cannot drift from what the agent is
 * told (the whole point of surfacing it).
 */
export interface LeaderBriefCaller {
  /** Full identity — required only for the leadership CLAIM (it heartbeats
   *  presence to label the new leader's row). Undefined for a viewer. */
  agentIdentity?: AgentIdentity;
  /**
   * The owner the brief is computed FOR. This is NOT bookkeeping: it scopes
   * `directives` (P-013 — the ledger's verdict on YOUR directives to each
   * member), so a viewer passes the VIEWED LEADER's ownerId to see what that
   * leader sees, not its own.
   */
  ownerId?: string;
  /** The caller's workspace, or null. Normalized through
   *  `resolveConcreteWorkspaceId` with `args.workspace` exactly as before. */
  actorWorkspace: string | null;
  /** Marks the caller's own row `isSelf`. Undefined ⇒ no row is marked. */
  self?: SelfRef;
  /** See LeaderBriefCaller's docblock §1. */
  allowLeadershipWrites: boolean;
  /** See LeaderBriefCaller's docblock §2. */
  resolveCallerMembership: boolean;
}

/**
 * The READ half of `fleet:leader-brief` — every leg from roster through
 * decorations, alerts and the fleet-block verdict. Pure with respect to the
 * fleet registry when `allowLeadershipWrites` is false.
 */
export async function buildLeaderBrief(
  args: {
    fleet?: string;
    harness?: string;
    workspace?: string;
    include_stale?: boolean;
    unowned_critical_age_hours?: number;
    orphan_min_age_minutes?: number;
    since?: string;
  },
  caller: LeaderBriefCaller,
) {
    const { agentIdentity, ownerId, actorWorkspace, self, allowLeadershipWrites } = caller;
    const membership = caller.resolveCallerMembership
      ? await resolvePresenceFleet(ownerId, deriveFleetMembership())
      : { fleetSlug: null as string | null };
    const fleet = args.fleet ?? membership.fleetSlug;
    if (!fleet) {
      return {
        data: {
          ok: false,
          error: 'no_fleet',
          hint:
            'No fleet resolvable from current presence or launch context and no { fleet } ' +
            'was passed. Pass { fleet: "<slug>" } explicitly, or use fleet:assignments for the ' +
            'whole-workspace roster.',
        },
      };
    }
    // EI-13820: ctx.workspaceId is the literal '*' sentinel for an unscoped su
    // session (EI-9013) — normalize through resolveConcreteWorkspaceId so '*'
    // never leaks into the roster/presence workspace filter (see the identical
    // fix + rationale in fleet:assignments' handler).
    const workspaceId = resolveConcreteWorkspaceId(args.workspace, actorWorkspace);
    // fleet:status's presence-primary roster is the membership authority. The
    // old claim-primary read omitted live idle members whose assignment view had
    // no row, so leader-brief and fleet:status reported different rosters.
    const rosterResult = await listFleetRosterDiagnosed({ fleetSlug: fleet, workspaceId });
    const rosterEntries: DecoratedAgent[] = rosterResult.entries.map((entry) => ({
      ...entry,
      ...(entry.wakeMode === 'auto' || entry.wakeMode === 'manual'
        ? { wakeMode: entry.wakeMode }
        : { wakeMode: undefined }),
    }));
    // ── P-004 / D-096: leadership self-claim ────────────────────────────────
    // Decided from `rosterEntries` — the UNFILTERED roster — and NOT from
    // `grouped` below, which drops idle members with a stale heartbeat unless
    // include_stale is set. A live-but-idle leader is routinely absent from the
    // filtered view, and reading that as "no leader" would seize leadership from
    // someone still working. The whole rule is in leadership-disposition.ts.
    let notLeader: NotLeaderNotice | undefined;
    let leadershipClaimed: AutoClaimedNotice | undefined;
    let leaderControl: LeaderControlOutcome | undefined;
    let fleetCreatedAtMs: number | null = null;
    try {
      const fleetRecord = await getFleet(workspaceId, fleet);
      fleetCreatedAtMs = fleetRecord?.createdAt ?? null;
      const registeredLeader = fleetRecord?.leaderOwnerId ?? null;
      const leaderRow = registeredLeader
        ? rosterEntries.find((e) => e.agentId === registeredLeader)
        : undefined;
      const disposition = decideLeadershipDisposition({
        callerOwnerId: ownerId,
        registeredLeader,
        leaderSessionState: leaderRow?.sessionState,
      });
      if (disposition.kind === 'not-leader') {
        // A READ — the notice only reports who the registered leader is, so a
        // read-only viewer still gets it.
        notLeader = buildNotLeaderNotice(disposition, fleet);
      } else if (
        disposition.kind === 'auto-claim' &&
        // P-002: a viewer never seizes a vacant leader seat. Without this a
        // human opening the popup would install their own session as leader of
        // a fleet they are merely looking at.
        allowLeadershipWrites &&
        fleetRecord &&
        agentIdentity &&
        ownerId
      ) {
        const out = await takeFleetLeadership(workspaceId, fleetRecord, agentIdentity, ownerId, {
          harnessSlug: args.harness,
        });
        leaderControl = out.control;
        leadershipClaimed = {
          claimed: true,
          reason: disposition.reason,
          previousLeader: out.previousLeader,
          notified: out.notified,
          note:
            disposition.reason === 'no-registered-leader'
              ? `'${fleet}' had NO registered leader; you are now installed as its leader. A fleet nobody leads is how a whole fleet dies unnoticed — you now own monitoring it.`
              : `The registered leader of '${fleet}' (${out.previousLeader}) is gone, so leadership passed to you. Nothing live was displaced.`,
        };
      } else if (disposition.kind === 'is-leader' && allowLeadershipWrites && fleetRecord && ownerId) {
        // Also a WRITE (it refreshes the leader's control row), so it is gated
        // too — a viewer reading a leader's brief must not touch that leader's
        // control state.
        leaderControl = await ensureFleetLeaderControl({
          workspaceId,
          ownerId,
          fleetSlug: fleet,
          harnessSlug: args.harness,
        });
      }
    } catch {
      /* best-effort: leadership bookkeeping must NEVER fail the health brief */
    }
    // P-015 / D-005: one profile-derived discovery advisory, read from the
    // existing event-await store after leader-control has had a chance to repair
    // the standing watches. No fleet metrics or populations are copied here.
    const monitoringBlindAdvisory = await readLeaderMonitoringBlindAdvisory(fleet);
    // Reconcile liveness BEFORE selecting the population. A stale directed
    // wake can make a dead owner look `live` through recent agent_activity;
    // selecting first would bake that ghost into the census even after the
    // authoritative psu-host check marks the row ended.
    await reconcileWakeability(rosterEntries).catch(() => {});
    // Missing host is a liveness signal only for known visible members. Keep
    // this best-effort so absent roles never reinterpret bootstrapping/remote
    // rows as desktop deaths.
    try {
      const presence = await listPresence({ workspaceId });
      reconcilePsuHostLiveness(
        rosterEntries,
        new Map(presence.map((p) => [p.ownerId, p.agentRole] as const)),
      );
    } catch {
      /* host reconciliation never blocks the health brief */
    }
    const { rows: grouped, census: memberCensus } = selectLeaderBriefMembers(
      rosterEntries,
      fleet,
      args.include_stale,
    );
    await decorateParkedOn(grouped).catch(() => {});
    // EI-18732218464905145: collapse a composed-await park (root + leaf sentinels)
    // into ONE structured entry before projection — best-effort, never blocks.
    await decorateComposedParkedOn(grouped).catch(() => {});
    await decorateLoopMonitorStates(grouped).catch(() => {});
    await decorateMemberVerdicts(grouped).catch(() => {});
    // EI-19307414464301772: the productive-only sibling of lastToolCallAt, feeding
    // computeSpinningAlert below — best-effort, never blocks the rest of the brief.
    await decorateProductiveToolCalls(grouped).catch(() => {});
    await decorateContextPressure(grouped).catch(() => {});
    await decorateUnansweredDirected(grouped).catch(() => {});
    // P-013: what the LEDGER says happened, beside what the member said. Scoped to
    // the caller's own directives — you are accountable for what you instructed.
    await decorateDirectiveActuation(grouped, ownerId).catch(() => {});
    await decorateCoordDeafness(grouped).catch(() => {});
    // P-005: a fired one-shot wait disappears from parkedOn, but its
    // authoritative stalled/absent verdict is durable. Surface that evidence
    // beside the member that must own the wake/takeover remedy.
    const verifiedWaitTakeovers = await listVerifiedWaitTakeoversForSubscribers(
      grouped.map((a) => a.agentId),
    ).catch(() => []);
    const takeoversBySubscriber = new Map<string, VerifiedWaitTakeoverAlert[]>();
    for (const alert of verifiedWaitTakeovers) {
      const current = takeoversBySubscriber.get(alert.subscriberId) ?? [];
      current.push(alert);
      takeoversBySubscriber.set(alert.subscriberId, current);
    }
    for (const agent of grouped) {
      agent.verifiedWaitTakeovers = takeoversBySubscriber.get(agent.agentId) ?? [];
    }
    // WI-5213: unowned criticals THIS fleet's claim spec would admit — read
    // failures already fail soft to `[]` inside readUnownedCriticalsForFleet.
    const unownedCriticalsAll: UnownedCriticalCandidate[] = await readUnownedCriticalsForFleet({
      fleet,
      harness: args.harness,
      workspaceId,
      ageHours: args.unowned_critical_age_hours,
    });
    // WI-6846: a majority-remote-origin backlog reads as urgent unowned work a
    // leader is expected to act on, when in fact `origin:'remote'` rows are
    // structurally un-actionable here (cannot claim — the claimable pre-filter
    // already excludes them; cannot close — work_items:set_state refuses remote-
    // authored mutation locally). Partition so `unownedCriticals` stays a
    // trustworthy "CLAIM these" signal, and surface the remote-origin count
    // separately rather than dropping it.
    const { actionable: unownedCriticals, federatedUnresolvable: unownedCriticalsFederated } =
      partitionUnownedCriticalsByOrigin(unownedCriticalsAll);
    // EI-18680302159738037: members refused by THIS fleet's claim spec. The remedy is
    // a spec write only the leader can make, so the block is leader-actionable by
    // construction — yet it was delivered as ordinary inbox mail, where one
    // action-required row does not survive a 5-figure inbox. Read failures already
    // fail soft to `[]` inside fetchFleetAdmissionBlocks.
    const admissionBlocked: FleetAdmissionBlock[] = await fetchFleetAdmissionBlocks(fleet);
    const admissionDependencyEscapes = admissionBlocked.filter((block) => block.dependencyEscape != null);
    // EI-18693470222331709: items released mid-flight (progress recorded, now
    // unassigned) — read failures already fail soft to `[]`.
    const orphanedInFlight: OrphanedInFlightCandidate[] = await readOrphanedInFlightForFleet({
      fleet,
      harness: args.harness,
      workspaceId,
      minAgeMinutes: args.orphan_min_age_minutes,
    });
    // EI-18681259560385029: read the fleet's LIVE claimable count before projecting members
    // — the per-member bench suggestion must not assert "drained or scoped-out" without it.
    // Fails soft to null (UNKNOWN), never 0.
    const fleetLaneHealth = await readFleetLaneHealth({
      fleet,
      harness: args.harness,
      workspaceId: actorWorkspace,
      assignee: ownerId,
    });
    const fleetClaimableCount = fleetLaneHealth?.claimable ?? null;
    // EI-18703234178947959: the fleet's OWN durable control state (mig 575) — the same
    // `winding-down` bit `fleetControlWindDownRefusal` floors every member's claim on.
    // Read it BEFORE projecting members so a paused fleet never emits a wake-me/bench-me
    // suggestion for a member that is correctly standing down. Fail-soft to NOT-paused:
    // a registry hiccup must never silence a genuine starvation alert.
    const fleetPause = await (async (): Promise<{ paused: boolean; reason: string | null }> => {
      try {
        const { getFleet } = await import('../../agent-fleets-store');
        const rec = await getFleet(workspaceId, fleet);
        return rec?.controlState === 'winding-down'
          ? { paused: true, reason: rec.controlReason ?? null }
          : { paused: false, reason: null };
      } catch {
        return { paused: false, reason: null };
      }
    })();
    // EI-19313376980892266: the AUTHORITATIVE per-member concurrency verdict — read from
    // `work_items.taken_by` in ONE batched query and decided by the same
    // `evaluateClaimConcurrency` the scheduler refuses on. Without it the bench suggestion
    // branches on the presence layer's `load`, which omits parked-but-held rows and so
    // reports AT-CAPACITY members as `idle-with-claimable`.
    //
    // The fleet's OWN spec limit is resolved first, deliberately: defaulting to 1 when a
    // leader authored concurrency > 1 would mark a legitimately-free member blocked and
    // SUPPRESS a real starvation signal — a false negative on the exact alert this brief
    // exists to raise. Fails soft to an EMPTY map (which suppresses nothing anywhere),
    // never to a fabricated verdict.
    const concurrencyByOwner = await (async (): Promise<
      Map<string, { blocked: boolean; activeClaims: number; heldIds: string[] }>
    > => {
      try {
        const { readClaimConcurrencyBatch, getClaimSpecRecord, fleetSpecBeeKey } = await import(
          '../../scheduler/claim-spec-store'
        );
        const rec = await getClaimSpecRecord({
          cupId: fleetSpecBeeKey(fleet),
          workspaceId,
        }).catch(() => null);
        return await readClaimConcurrencyBatch({
          cupIds: grouped.map((a) => a.agentId),
          // `actorWorkspace` is string|null; the reader takes an optional string and
          // falls back to DEFAULT_COORD_WORKSPACE, which is what null means here too.
          workspaceId: actorWorkspace ?? undefined,
          maxConcurrentClaims: rec?.spec.limits?.maxConcurrentClaims,
        });
      } catch {
        return new Map();
      }
    })();
    // WI-37161 / EI-20243921934115652: read the live shared-inference-pool verdict BEFORE
    // projecting members, scoped to THIS fleet's observed model provider. The old no-arg
    // reader always used the legacy Claude pool, so a Codex fleet inherited Claude exhaustion
    // and the brief told its leader not to wake 25 healthy Luna lanes. Mixed/unknown model
    // families fail soft to UNKNOWN instead of borrowing either provider's capacity.
    const capacityAgentByOwner = await (async (): Promise<
      Map<string, 'claude' | 'omp' | 'codex' | null>
    > => {
      try {
        const { advSessionsByCoordOwner } = await import('../../adv-sessions');
        const sessions = await advSessionsByCoordOwner();
        return new Map(
          [...sessions].map(([ownerId, session]) => [ownerId, session.agent] as const),
        );
      } catch {
        return new Map();
      }
    })();
    const capacityProvider = fleetCapacityProviderForMembers(grouped, capacityAgentByOwner);
    const poolCapacity = capacityProvider ? await readPoolDegradedState(capacityProvider) : null;
    const nowMs = Date.now();
    const members = grouped.map((a) =>
      projectMember(
        a,
        nowMs,
        fleetClaimableCount,
        fleetLaneHealth,
        fleetPause.paused,
        concurrencyByOwner.get(a.agentId) ?? null,
        poolCapacity,
      ),
    );
    // `self` now arrives on the caller bag (see LeaderBriefCaller): a viewer has
    // no row of its own in the fleet, so nothing is marked for it.
    const markedMembers = markSelfRows(members, self, 'agentId');
    const summary = {
      fleet,
      members: members.length,
      // P-010: what `members` (and every count below it, all of which are filters
      // OVER the same list) is a count OF. Without this the number is only
      // comparable to itself: the same fleet read 11 / 11 / 14 / 8 / 9 across
      // leader-brief and fleet:assignments within minutes, each defensible, none
      // reconciled inline.
      population: memberCensus,
      speaking: members.filter((m) => m.verdict === 'speaking').length,
      monitoring: members.filter((m) => m.monitorState === 'monitoring').length,
      waiting: members.filter((m) => m.monitorState === 'waiting').length,
      parked_awaiting_capability: members.filter(
        (m) => m.monitorState === 'parked-awaiting-capability',
      ).length,
      stalled: members.filter((m) => m.verdict === 'stalled' || m.stalled).length,
      dead: members.filter((m) => m.verdict === 'dead').length,
      unanswered_directed: members.filter((m) => (m.unanswered?.count ?? 0) > 0).length,
      high_context: members.filter((m) => m.contextPressure === 'high').length,
      critical_context: members.filter((m) => m.contextPressure === 'critical').length,
      parked: members.filter((m) => (m.parkedOn?.length ?? 0) > 0).length,
      verified_wait_takeovers: members.reduce(
        (count, member) => count + (member.verifiedWaitTakeovers?.length ?? 0),
        0,
      ),
      // P-001 coord-deafness: live members NOT seeing their coord mail right
      // now — a coord:send to them silently queues until they settle/wake.
      coord_deaf: members.filter((m) => m.coordHook != null).length,
      // EI-9943: members alive+speaking but not advancing and not yet benched —
      // the live-loop-polling-on-a-blocker pattern this whole item targets.
      bench_suggested: members.filter((m) => m.benchSuggestion != null).length,
      // EI-18681259560385029: of those, the ones that must NOT be benched — alive,
      // unclaimed, and idle beside a queue that is NOT empty. `bench_suggested` alone
      // was read as benign (it counts a REMEDY); this counts a STARVATION SYMPTOM.
      idle_with_claimable: members.filter((m) => m.benchSuggestion?.kind === 'idle-with-claimable')
        .length,
      // EI-18689489507862177: members idle against an EMPTY (or unread) queue. Distinct from
      // idle_with_claimable above, which by construction only counts them when claimable > 0
      // — so in a fully-GATED lane (claimable 0, spec matching plenty) that field reads 0 and
      // these members land here instead. This is the count computeFloorStarvedFleetAlert
      // keys on; without it the gated-lane alert could never fire.
      laneless_idle: members.filter((m) => m.benchSuggestion?.kind === 'laneless-idle').length,
      // EI-18730414627683753: members with ZERO self-wake mechanism (no loop, no park, no
      // claim) — distinct from laneless_idle above, which does not distinguish a healthy
      // loop-armed member (will re-cycle on its own) from one that will never wake again.
      // >0 here means the leader must wake these members NOW; waiting out a tick does nothing.
      dormant: members.filter((m) => m.dormant === true).length,
      // EI-19307414464301772: members alive and visibly taking turns whose calls are
      // entirely per-turn housekeeping (coord:glance/activity:report/journal:record-turn/
      // flags:get/sessions:ingest-gate-event) for well past budget — every OTHER surface
      // here (stalled, dead) reads these as healthy. >0 means wake it explicitly and
      // investigate; do not assume the loop will self-correct.
      spinning: members.filter((m) => m.spinning === true).length,
      // EI-19381528967421062: members whose loop is backed off from a provider wall right
      // now — `active:true`/`sessionState:parked` read identical to a healthy between-wakes
      // member on every OTHER surface. >0 here means those claims are stranded until
      // `throttled.until`, not lost; do not relaunch/reclaim solely on this, but do NOT read
      // the fleet as fully healthy either — see each member's `throttled` field for when.
      throttled: members.filter((m) => m.throttled != null).length,
      // The live authoritative claimable total behind the two fields above (the same
      // number work_items:claimable reports). null ⇒ could not be read on this brief —
      // NOT zero, and never to be read as a drained lane.
      claimable_now: fleetClaimableCount,
      // EI-19313376980892266 fix B: WHICH scoping produced the number above. A bare
      // count is not comparable to another surface's count — beside
      // work_items:claimable's default-spec total this one reads as a contradiction
      // when the two are simply different questions. null when the lane read failed
      // (i.e. claimable_now is null too), never a fabricated scoping.
      claimable_now_spec: fleetLaneHealth
        ? {
            ...fleetLaneHealth.spec,
            note:
              `claimable_now (${fleetLaneHealth.claimable}) counts rows admitted by ` +
              `${fleetLaneHealth.spec.ref} within harness '${fleetLaneHealth.spec.harness}'. ` +
              `work_items:claimable{harness} asks a DIFFERENT question (the default spec, ` +
              `harness-wide) and a larger number there is expected, not a contradiction — ` +
              `compare only against the same spec+harness.`,
          }
        : null,
      // WI-3818: make any incomplete canonical roster read explicit to callers
      // instead of silently presenting a partial membership list.
      degraded_roster_legs: rosterResult.degradedLegs,
      // WI-5213: unowned criticals (filing is not fixing) THIS fleet's claim
      // spec would admit — >0 here means an escalation the leader should act
      // on (reclaim/reassign/nudge), not weather to wait out. WI-6846: this is
      // now LOCAL-origin only (actionable here) — see unowned_criticals_federated.
      unowned_criticals: unownedCriticals.length,
      // WI-6846: origin:'remote' rows from the SAME spec-admitted set above —
      // this node can neither claim nor close them (see unownedCriticalsFederated
      // in the payload for the recovery-state list + note). Nonzero here is
      // explicitly NOT an escalation for THIS leader to act on.
      unowned_criticals_federated: unownedCriticalsFederated.length,
      // EI-18693470222331709: orphaned in-flight items (filing is not fixing, same
      // as unowned_criticals above) — >0 means near-complete work stranded by a
      // release/reap, the cheapest claimable win on this brief.
          // WI-6678: renamed from `orphaned_in_flight`. "Orphan" made every leader reach for
          // work_items:release (the standing "reclaim orphans" monitor instruction says so) —
          // but this condition REQUIRES assignee IS NULL, so a release cannot possibly clear
          // it and returns ok:true having done nothing. Observed live: a leader "reclaimed"
          // two of these and reported it to the owner, changing nothing. The only resolving
          // action is a member CLAIMING and finishing the item.
          abandoned_unclaimed: orphanedInFlight.length,
      // EI-18680302159738037: DISTINCT (item, member) pairs this fleet's own claim
      // spec refused in the last 24h. Unlike every other advisory here, the blocked
      // party already told you — as inbox mail, which is where it got buried. >0
      // means a member is structurally UNABLE to claim work it was pointed at, and
      // the only remedy is a spec write YOU make (scheduler:set_claim_spec); no
      // amount of member discipline clears it. See `admissionBlocked` for the rows.
      admission_blocked: admissionBlocked.length,
      // P-006: the critical subset whose refused item is an unresolved dependency
      // of work the member already holds. Rows carry the exact dependency + three routes.
      admission_dependency_escapes: admissionDependencyEscapes.length,
      // EI-18703234178947959: this fleet's own control_state is winding-down (fleet:pause /
      // fleet:wind-down). Emitted EXPLICITLY rather than left implicit, because it is the
      // reason the idle-member alerts above read 0/false: idle members are COMPLYING with
      // the pause, so "no alert" here means "no action needed", not "nothing was checked".
      // Lift with fleet:resume; until then the claim path refuses these members work.
      fleet_paused: fleetPause.paused,
      // WI-37161: the live shared-inference-pool verdict (the same read `fleet:capacity`
      // reports), surfaced HERE — not only folded into the per-member `throttled` field — so a
      // leader reading the summary alone can see the pool is degraded/exhausted even though
      // `throttled` (a DIFFERENT, per-member signal — see PoolDegradedState's doc comment) can
      // legitimately read 0 for every member at once while the pool itself is congested. null
      // means unread this call, never "healthy".
      pool_capacity: poolCapacity,
    };
    const totalLoad = members.reduce((sum, m) => sum + m.load, 0);
    // EI-15055: loud fleet-wide zero-wip-with-supply alert — see computeStrandedFleetAlert.
    const strandedFleetAlert = computeStrandedFleetAlert({
      totalLoad,
      parkedCount: summary.parked,
      unownedCriticalCount: unownedCriticals.length,
      harness: args.harness ?? null,
      fleet,
    });
    // EI-18655873409999215: the SPEC-STARVED alert — best-effort, fail-soft (a
    // preview error or missing spec must never break the brief). Measures the
    // fleet's OWN effective claim spec against the live claimable pool, the same
    // compiled-filter count scheduler:set_claim_spec's write-time guard uses.
    // EI-18681259560385029: idle members beside a NONEMPTY queue — the shape both alerts
    // below are structurally blind to (see computeIdleWithClaimableAlert).
    const idleWithClaimableAlert = computeIdleWithClaimableAlert({
      claimableCount: fleetClaimableCount,
      idleMemberCount: summary.idle_with_claimable,
      fleetPaused: fleetPause.paused,
      harness: args.harness ?? null,
      // The SAME predicate the count above is derived from, so the falsifier can never
      // name a member the alert is not actually accusing.
      idleMemberIds: members
        .filter((m) => m.benchSuggestion?.kind === 'idle-with-claimable')
        .map((m) => m.agentId),
      poolCapacity,
    });
    // EI-18689489507862177: the GATED-lane twin of the alert above. `idle_with_claimable`
    // is 0 by construction in this state (its bench branch requires claimableCount > 0), so
    // this one counts laneless-idle members instead — keying it to idle_with_claimable would
    // ship an alert that can never fire.
    const floorStarvedAlert = computeFloorStarvedFleetAlert({
      claimable: fleetClaimableCount,
      matchedByFilter: fleetLaneHealth?.matchedByFilter ?? null,
      idleMemberCount: summary.laneless_idle,
      excluded: fleetLaneHealth?.excluded ?? null,
      fleetPaused: fleetPause.paused,
      harness: args.harness ?? null,
      fleet,
    });
    // fleet-lead-instrumentation-audit-2026-08-09 P-019/P-012: ARBITRATE the alerts above
    // into ONE dominant layer. Computed from the same inputs the siblings fired on (never a
    // second read), so it cannot disagree with them — it only ORDERS them.
    const blockedAt = computeFleetBlockVerdict({
      fleetPaused: fleetPause.paused,
      poolCapacity,
      claimable: fleetClaimableCount,
      matchedByFilter: fleetLaneHealth?.matchedByFilter ?? null,
      idleMemberCount: summary.idle_with_claimable,
      lanelessIdleCount: summary.laneless_idle,
      harness: args.harness ?? null,
      fleet,
    });
    let specStarvedAlert: { reason: string; falsifier: AlertFalsifier } | undefined;
    // WI-5937 acceptance #3: "leader-brief returns spec filter + both counts + per-member
    // doing in one read" — the fleet's OWN active view.filter (so a leader reads WHAT is
    // scoped without a separate scheduler:get_claim_spec round-trip) plus BOTH claimable
    // counts side by side: the harness-WIDE pool (what work_items:claimable{harness} would
    // show, pre-spec-narrowing) and the spec-scoped matched count (pre-floor) — the exact
    // pair whose conflation (1037 harness-wide vs 0 spec-scoped) produced the false
    // spec-starved ruling this item's own root-cause section documents. Best-effort/optional:
    // a preview failure must never block the rest of the brief.
    let specFilter: unknown;
    let harnessWidePool: number | undefined;
    let specMatched: number | undefined;
    // P-005: the spec row's own authorship, surfaced beside the filter it describes. A
    // leader reading `specFilter` alone cannot tell their own lane from one an automated
    // peer rewrote under them.
    let specRevision: number | undefined;
    let specUpdatedBy: string | null | undefined;
    let specUpdatedAt: string | null | undefined;
    let specAuthorshipAlert: { reason: string; falsifier: AlertFalsifier } | undefined;
    try {
      const { getClaimSpecRecord, fleetSpecBeeKey } = await import('../../scheduler/claim-spec-store');
      const rec = await getClaimSpecRecord({ cupId: fleetSpecBeeKey(fleet), workspaceId });
      if (rec.source !== 'default') {
        specFilter = rec.spec.view?.filter ?? null;
        specRevision = rec.revision ?? undefined;
        specUpdatedBy = rec.updatedBy;
        specUpdatedAt = rec.updatedAt;
        // P-005: computed from the record ALONE, and deliberately BEFORE the pool preview
        // below — the preview is the fragile half (it compiles the filter and counts the
        // pool), and coupling a drift signal to it would mean a preview outage silently
        // takes the drift check with it. That is the same class of blindness this alert
        // exists to report, one level up.
        specAuthorshipAlert = computeSpecAuthorshipAlert({
          readerId: ownerId ?? null,
          updatedBy: rec.updatedBy,
          revision: rec.revision,
          updatedAt: rec.updatedAt,
          harness: args.harness ?? null,
          fleet,
        });
        try {
          const { previewSpecPoolEffect } = await import('../../scheduler/spec-pool-preview');
          const effect = await previewSpecPoolEffect(rec.spec, { workspaceId, harness: args.harness ?? null });
          specStarvedAlert = computeSpecStarvedFleetAlert({
            totalLoad,
            specMatched: effect.matched,
            poolSize: effect.pool,
            harness: args.harness ?? null,
            fleet,
          });
          harnessWidePool = effect.pool;
          specMatched = effect.matched;
        } catch {
          /* best-effort — a pool-effect failure must not cost the authorship read above */
        }
      }
    } catch {
      /* best-effort — never block the brief on a spec-effect preview failure */
    }
    // P-014: leader-REGISTERED custom invariants, evaluated here alongside the
    // built-in alerts above. The built-ins are checks somebody thought to build in
    // advance; this is where a leader's own ad-hoc check lives instead of dying with
    // the turn that wrote it. Same best-effort discipline as the preview above — and
    // internally each invariant is isolated too, so one bad registry entry reports
    // itself as errored rather than costing the leader the rest of the brief.
    let customInvariants: InvariantEvaluation[] | undefined;
    let customInvariantAlert: { reason: string } | undefined;
    const { readFleetInvariantEvaluations, computeCustomInvariantAlert } = await import('./invariants');
    customInvariants = await readFleetInvariantEvaluations({ workspaceId, fleetSlug: fleet });
    if (customInvariants) customInvariantAlert = computeCustomInvariantAlert(customInvariants);
    // P-023: the PER-MEMBER "why is this idle" verdict, computed AFTER `blockedAt` because it
    // is deliberately subordinate to it. Attributing idleness to a member while the pool is at
    // factor 0 is exactly the inversion P-002 measured; deriving a per-member answer
    // independently would reproduce that once per member, and a specific per-member reason
    // reads as BETTER evidence than a fleet-wide one, so it would be believed harder.
    const membersWithVerdict = markedMembers.map((m) => ({
      ...m,
      idleVerdict: computeMemberIdleVerdict(
        {
          sessionState: m.sessionState,
          load: m.load,
          stalled: m.stalled,
          lastToolCallAgeMs: m.lastToolCallAgeMs,
          contextPressure: m.contextPressure,
          throttled: (m as { throttled?: unknown }).throttled,
          loopMode: m.loopMode,
          nextFireAt: m.nextFireAt,
          parkedOn: m.parkedOn,
        },
        { blockedAtLayer: blockedAt?.layer ?? null, midTurnFreshnessMs: VERDICT_SPEAKING_FRESH_MS },
      ),
    }));
    const idleCauses = summariseIdleCauses(membersWithVerdict.map((m) => m.idleVerdict));
    // P-024 / D-013: the reservation plan. Built on the P-023 causes above rather than on a
    // second read of member state, so "who is holding work" cannot differ between the two
    // blocks. Recommends nothing at all when the pool is not scarce, and never recommends a
    // bench — the trade P-024 exists because the leader was forced to make.
    const reservation = computePoolReservation(
      membersWithVerdict.map((m) => ({ agentId: m.agentId, idleCause: m.idleVerdict.cause })),
      { factor: poolCapacity?.factor ?? null, queueDepth: poolCapacity?.queueDepth ?? null },
    );
    const memberVerdicts = compactLeaderBriefMemberVerdicts(membersWithVerdict);
    const boundedMembers = trimToByteBudget(membersWithVerdict, LEADER_BRIEF_MEMBER_DETAIL_BUDGET);
    const boundedReservationMembers = trimToByteBudget(
      reservation.members,
      LEADER_BRIEF_RESERVATION_DETAIL_BUDGET,
    );
    const reservationForResponse = {
      ...reservation,
      members: boundedReservationMembers.kept,
      ...(boundedReservationMembers.truncated
        ? {
            membersTruncated: true,
            membersReturned: boundedReservationMembers.kept.length,
            membersHint:
              'Reservation details are bounded for transport; use memberVerdicts for the complete member index.',
          }
        : {}),
    };
    // P-022 / D-011: the wake-to-wake delta. Every field above this line is point-in-time,
    // which is what made "what changed since my last wake" a hand-reconstruction from
    // checkpoint prose. Boundary is REPORTED, never implied, and an axis with no baseline
    // reports available:false rather than a zero — a "nothing changed" that actually means
    // "I have no baseline" is the exact bug class this plan exists to catalogue.
    // Best-effort like its neighbours: a delta failure must not cost the leader the brief.
    let delta: FleetBriefDelta | undefined;
    let deltaSummary: string | undefined;
    if (ownerId) {
      try {
        const { resolveFleetBriefDelta } = await import('../../fleet-brief-delta-store');
        const resolved = await resolveFleetBriefDelta({
          key: { workspaceId, fleetSlug: fleet, ownerId },
          harnessSlug: args.harness ?? null,
          observation: {
            at: new Date().toISOString(),
            // The ROSTER, not the shown list: a member going stale-idle drops out of
            // `members` but has not left the fleet, and reading that as a departure is
            // precisely the visibility-for-membership confusion P-010 documented.
            rosterSize: memberCensus.candidates ?? null,
            countedMembers: members.length,
            specRevision: specRevision ?? null,
            poolFactor: poolCapacity?.factor ?? null,
          },
          fireCount: await (async () => {
            try {
              const { getLoopStatus } = await import('../../harness/routines/loop');
              return (await getLoopStatus(ownerId))?.fireCount ?? null;
            } catch {
              return null;
            }
          })(),
          since: args.since ?? null,
        });
        if (resolved) {
          delta = resolved.delta;
          deltaSummary = resolved.summary;
        }
      } catch {
        /* best-effort — an absent delta block reads as absent, never as a set of zeroes */
      }
    }
    // P-007: cross-epoch campaign measurements are derived live from authoritative
    // writers. Keep this adjacent to the existing wake delta: delta answers "what
    // changed since my last wake" while campaign answers "what has this fleet done
    // since the explicit/fleet-created boundary". Best-effort preserves the health
    // brief if any campaign reader is unavailable; individual axes carry their own
    // unavailable-not-zero verdicts.
    let campaign: FleetCampaign | undefined;
    if (fleetCreatedAtMs != null) {
      try {
        const { readFleetCampaign } = await import('./fleet-campaign');
        campaign = await readFleetCampaign({
          workspaceId,
          fleetSlug: fleet,
          fleetCreatedAtMs,
          since: args.since ?? null,
          harnessSlug: args.harness ?? null,
        });
      } catch {
        /* best-effort — absence is not a fabricated empty campaign */
      }
    }
    return {
      data: {
        ok: true,
        ...(self ? { self } : {}),
        // P-004/D-096: the caller is acting on this fleet without holding its
        // leadership. Surfaced BEFORE the summary so it is not lost under the
        // member rows — the value of this branch is that the caller learns it.
        ...(notLeader ? { notLeader } : {}),
        ...(leadershipClaimed ? { leadershipClaimed } : {}),
        ...(leaderControl ? { leaderControl } : {}),
        ...(monitoringBlindAdvisory ? { monitoringBlindAdvisory } : {}),
        // P-019/P-012: the arbitrated "which layer is blocking my fleet" verdict, placed
        // ABOVE the summary on purpose — the alert booleans below are flat and co-fire, and
        // reading them in field order is what produced the inverted remedy this fixes.
        // Absent ⇒ no layer is blocking (every member working), not "unknown".
        ...(blockedAt ? { blockedAt } : {}),
        summary: {
          ...summary,
          strandedFleetAlert: strandedFleetAlert != null,
          specStarvedAlert: specStarvedAlert != null,
          // P-005: unlike its siblings this one is not about SUPPLY — it says the lane you
          // are reading was authored by someone else, so every other spec figure here
          // describes a scope you have not ratified.
          specAuthorshipAlert: specAuthorshipAlert != null,
          idleWithClaimableAlert: idleWithClaimableAlert != null,
          floorStarvedAlert: floorStarvedAlert != null,
          ...(customInvariants ? { customInvariantAlert: customInvariantAlert != null } : {}),
        },
        // P-022: placed directly under the summary it differences. `deltaSummary` is the
        // one-line "since your last wake — members ±N, closes +N, spec rev X→Y, pool factor
        // A→B" a monitor tick actually reads; `delta` carries the per-axis availability so a
        // reader can tell an unmeasured axis from a quiet one.
        ...(delta ? { delta, deltaSummary } : {}),
        ...(campaign ? { campaign } : {}),
        // P-023: counts by cause. A cause that never fired is ABSENT, not 0 — a zero row
        // invites reading an unpopulated cause as a measured absence.
        idleCauses,
        // P-024: included only when the pool is actually scarce. Under a healthy pool the plan
        // is "recommend nothing", and rendering that every wake would be one more always-present
        // block a leader learns to skip past.
        ...(reservation.scarcity.scarce ? { reservation: reservationForResponse } : {}),
        // EI-20226510994156306: this compact index is intentionally complete even when the
        // verbose member rows below are bounded. It is the stable recovery surface for a
        // 50-member fleet: every id + verdict remains available without a full-tier fetch.
        memberVerdicts,
        members: boundedMembers.kept,
        ...(boundedMembers.truncated
          ? {
              membersTruncated: true,
              membersReturned: boundedMembers.kept.length,
              membersHint:
                'Verbose member rows are bounded for transport; use memberVerdicts for all ids/verdicts and narrow fleet:assignments { agent } for detail.',
            }
          : {}),
        ...(unownedCriticals.length > 0 ? { unownedCriticals } : {}),
        ...(unownedCriticalsFederated.length > 0
          ? {
              unownedCriticalsFederated,
              // WI-6846: carry the non-actionability with the finding, same discipline as
              // abandonedUnclaimedAction below — a bare count invites a leader to try to
              // claim/close these and hit a refusal for every one.
              unownedCriticalsFederatedNote:
                `${unownedCriticalsFederated.length} unowned critical(s) this fleet's spec would admit are ` +
                `origin:'remote' — authored on a DIFFERENT node. This node can neither claim them ` +
                `(already excluded from self-select) nor close them (work_items:set_state refuses to ` +
                `mutate a remote-authored row locally). Only the authoring peer resolving it, or ` +
                `federation delivering that resolution, clears one. Not this leader's escalation to act on.`,
            }
          : {}),
        ...(orphanedInFlight.length > 0
          ? {
              abandonedUnclaimed: orphanedInFlight,
              // WI-6678: carry the RESOLVING ACTION with the finding. The field name alone
              // could not carry it — and a leader acting on the wrong verb gets ok:true.
              abandonedUnclaimedAction:
                `${orphanedInFlight.length} item(s) show progress then abandonment, and are ALREADY unassigned. ` +
                `work_items:release does NOTHING here (it returns ok:true on the no-op — WI-6678). ` +
                `Resolve by CLAIMING them, or promote them with work_items:set_priority { priority } so the ` +
                `queue hands them to a member — the count falls only when one is claimed and finished.`,
            }
          : {}),
        ...(admissionBlocked.length > 0
          ? {
              admissionBlocked,
              // Same discipline as abandonedUnclaimedAction above: carry the RESOLVING
              // ACTION with the finding. It matters more here than anywhere else on this
              // brief, because the natural reading of "a member is not claiming its work"
              // is a discipline problem — and acting on that reading produces a fleet-wide
              // directive that cannot possibly help, which is exactly what happened in the
              // incident that filed this (EI-18680302159738037).
              // Front-loaded deliberately: the monitor projection CLIPS this to 220
              // chars, so the anti-misreading ("not discipline") and the lever
              // (set_claim_spec) must both land inside the first sentence or the
              // clipped copy reads as a bare complaint.
              admissionBlockedAction:
                `NOT member discipline — ${admissionBlocked.length} (item, member) pair(s) were refused by THIS ` +
                `fleet's claim spec; only YOUR spec write clears it: scheduler:set_claim_spec { fleet, … } to widen ` +
                `the lane, or route the item to a member whose lane admits it. ` +
                (admissionDependencyEscapes.length > 0
                  ? `${admissionDependencyEscapes.length} row(s) are typed DEPENDENCY ESCAPES: each names the ` +
                    `dependency and blocked held item ids, preserves the member's ownership, and carries three ` +
                    `routes (spec_widen, outside_lane_placement, leader_claim). `
                  : '') +
                `Each row names the specId + revision that refused it; after a widen the member self-claims on its ` +
                `next scheduler:get_next, with no re-dispatch. \`occurrences\` > 1 means that member is stuck in a ` +
                `refusal LOOP, burning a wake each time.`,
            }
          : {}),
        // EI-19313376980892266 item C: every alert ships its FALSIFIER beside its reason
        // — the read-only one-liner whose output either confirms or KILLS the alert. The
        // reason is what the leader believes; the falsifier is what they can run. Emitted
        // as a sibling field rather than folded into the reason string so it survives a
        // truncating renderer and is machine-checkable (alert-falsifier-reality.test.ts).
        ...(strandedFleetAlert
          ? {
              strandedFleetAlertReason: strandedFleetAlert.reason,
              strandedFleetAlertFalsifier: strandedFleetAlert.falsifier,
            }
          : {}),
        ...(specStarvedAlert
          ? {
              specStarvedAlertReason: specStarvedAlert.reason,
              specStarvedAlertFalsifier: specStarvedAlert.falsifier,
            }
          : {}),
        ...(specAuthorshipAlert
          ? {
              specAuthorshipAlertReason: specAuthorshipAlert.reason,
              specAuthorshipAlertFalsifier: specAuthorshipAlert.falsifier,
            }
          : {}),
        ...(idleWithClaimableAlert
          ? {
              idleWithClaimableAlertReason: idleWithClaimableAlert.reason,
              idleWithClaimableAlertFalsifier: idleWithClaimableAlert.falsifier,
            }
          : {}),
        ...(floorStarvedAlert
          ? {
              floorStarvedAlertReason: floorStarvedAlert.reason,
              floorStarvedAlertFalsifier: floorStarvedAlert.falsifier,
            }
          : {}),
        // P-014: always carried when ANY invariant is registered — including the
        // all-satisfied case. A leader must be able to tell "my checks ran and found
        // nothing" from "my checks are not running", which a reason-only field cannot
        // express (that is the same false-clean shape the invariants exist to catch).
        ...(customInvariants ? { customInvariants } : {}),
        ...(customInvariantAlert ? { customInvariantAlertReason: customInvariantAlert.reason } : {}),
        // EI-18703234178947959: the owner's own stated pause reason, verbatim, so the
        // leader reads WHY the fleet is standing down without a second registry lookup.
        ...(fleetPause.paused && fleetPause.reason
          ? { fleetPausedReason: fleetPause.reason }
          : {}),
        // WI-5937 acceptance #3 — see the comment above the preview call: the fleet's own
        // active claim-spec filter, plus both claimable counts (harness-wide pool vs
        // spec-scoped matched) side by side, so a leader never has to compare member prose
        // against a summary count without the two authoritative reads one call away.
        ...(specFilter !== undefined ? { specFilter } : {}),
        // P-005: the filter's PROVENANCE, emitted whenever the filter itself is — a
        // revision the leader can diff wake-to-wake, and the identity that last moved it.
        // Present-but-null updatedBy is meaningful (an unattributed write), so these ride
        // the same presence test as specFilter rather than being dropped when null.
        ...(specRevision !== undefined ? { specRevision } : {}),
        ...(specUpdatedBy !== undefined ? { specUpdatedBy } : {}),
        ...(specUpdatedAt !== undefined ? { specUpdatedAt } : {}),
        ...(harnessWidePool !== undefined ? { harnessWidePool } : {}),
        ...(specMatched !== undefined ? { specMatched } : {}),
      },
    };
}
