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
 * decorateMemberVerdicts →
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
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { resolvePresenceFleet } from '../coordination/presence-fleet';
import { resolveSelfRef, markSelfRows } from '../coordination/self-marker';
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
  decorateContextPressure,
  decorateUnansweredDirected,
  decorateCoordDeafness,
  type MemberVerdict,
  type MonitorState,
} from './assignments';
import type { CoordDeafState } from '../coordination/inbox-read-freshness';
import type { SessionState } from '../coordination/presence-wakeability';
import type { WakeMode } from '../coordination/wake-mode';
import type { ContextPressureBucket } from '../coordination/context-pressure';
import type { UnansweredDirectedSummary } from '../coordination/unanswered-directed';
import {
  readUnownedCriticalsForFleet,
  type UnownedCriticalCandidate,
} from '../../harness/improvements/unowned-critical-escalation';

export interface LeaderBriefMember {
  agentId: string;
  label: string | null;
  fleetRole: string | null;
  sessionState: SessionState | null;
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
  /** ms since the member's last recorded tool call; null = never (still booting). */
  lastToolCallAgeMs: number | null;
  doing: unknown;
  /** Every currently-held work-item id (bounded by the member's actual claim list). */
  workItemIds: string[];
  queuedCount: number;
  load: number;
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
  /** Active non-inbox-wake events:await keys — a deliberately-benched member. */
  parkedOn?: string[];
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
  isSelf?: true;
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
  },
  /**
   * EI-18681259560385029: the fleet's LIVE authoritative claimable count (the same
   * `claimableCount` work_items:claimable reports — spec_match AND all ~12 floors),
   * or `null` when it could not be read.
   *
   * THE THREE VALUES ARE THREE DIFFERENT FACTS AND MUST NOT COLLAPSE:
   *   > 0   → the queue is NOT empty; an idle member is a starvation symptom, and
   *           benching it is the WRONG remedy.
   *   === 0 → the lane really is drained; the historical bench advice is correct.
   *   null  → UNKNOWN (read failed / no harness to scope by). Deliberately NOT
   *           folded into 0: doing so would silently restore the exact bug this
   *           parameter fixes — an unchecked "drained or scoped-out" assertion —
   *           and it would do so invisibly, forever. Unknown says so out loud.
   */
  claimableCount?: number | null,
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
  if (a.load === 0 && (a.queued?.length ?? 0) === 0 && !a.doing) {
    // EI-18681259560385029: the ORIGINAL text asserted "likely idle-cycling a drained or
    // scoped-out lane" UNCONDITIONALLY — a confident diagnosis of a fact it never checked.
    // When the queue is actually nonempty that sentence points a leader AWAY from the truth
    // ("lane drained, parking is correct") and its paired remedy (fleet:bench onto an event)
    // is precisely backwards: it puts the member to SLEEP next to work it should be taking.
    // Live 2026-07-26T04:32Z: five members carried this line while claimableCount was 2, and
    // the leader read it and stood the fleet down. Branch on the real number instead.
    if (claimableCount != null && claimableCount > 0) {
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
    return {
      kind: 'laneless-idle',
      reason:
        'alive with NO claim, nothing queued, and not parked on an event — idle-cycling ' +
        (claimableCount === 0
          ? 'a lane VERIFIED drained right now (0 claimable under this fleet\'s spec) '
          : 'a lane whose claimable queue could NOT be read on this brief (unknown, not verified drained) ') +
        'every wake instead of resting on a scoped completion event (EI-13846). ' +
        (claimableCount === 0
          ? 'fleet:bench it onto a scoped event, or confirm its claim spec still admits work.'
          : 'Check work_items:claimable BEFORE benching — an unread queue is not an empty one.'),
      item: null,
      itemTitle: null,
    };
  }
  return undefined;
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
}): { reason: string } | undefined {
  if (input.totalLoad > 0 || input.parkedCount === 0 || input.unownedCriticalCount === 0) return undefined;
  return {
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
}): { reason: string } | undefined {
  if (input.totalLoad > 0 || input.poolSize === 0 || input.specMatched > 0) return undefined;
  return {
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
}): { reason: string } | undefined {
  if (input.claimableCount == null || input.claimableCount <= 0) return undefined;
  if (input.idleMemberCount <= 0) return undefined;
  return {
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
 * EI-18681259560385029: IO shell for the alert above — the fleet's live authoritative
 * claimable count, or `null` when it genuinely could not be read.
 *
 * Uses `aggregateIssueClaimExclusions` (the SAME oracle behind work_items:claimable and
 * scheduler:get_next) resolved through the SAME `resolveFleetClaimSpec` path that
 * `work_items:claimable { spec: <fleetSlug> }` uses, so the number this alert fires on and
 * the number an agent sees when they check by hand structurally cannot disagree. Note this
 * is `breakdown.claimable` (post-floor), NOT `matchedByFilter` and NOT
 * previewSpecPoolEffect's `matched` — those are pre-floor filter counts (~113 vs 4 on this
 * fleet at the time of writing), which is why the spec-starved alert cannot stand in here.
 *
 * Fails soft to `null`, never to `0`: a read error must not manufacture "the lane is
 * drained" — that synthesised zero-state is the same class of bug as the wording this item
 * fixes, and it would silently disable the alert rather than announcing itself.
 */
async function readFleetClaimableCount(args: {
  fleet: string;
  harness?: string;
  workspaceId?: string | null;
  assignee?: string;
}): Promise<number | null> {
  try {
    const { resolveFleetClaimSpec, resolveClaimSpecWorkspace } = await import(
      '../../scheduler/claim-spec-store'
    );
    const { aggregateIssueClaimExclusions } = await import('../../scheduler/get-next');
    const ws = resolveClaimSpecWorkspace(args.workspaceId ?? undefined);
    const resolved = await resolveFleetClaimSpec({ spec: args.fleet, workspaceId: ws });
    if (!resolved) return null;
    // aggregateIssueClaimExclusions requires a harness to scope by. Prefer the caller's,
    // else the one the spec record itself rides — without either we cannot produce a
    // trustworthy number, and null (unknown) is the honest answer.
    const harness = args.harness ?? resolved.record.harnessSlug ?? null;
    if (!harness) return null;
    const breakdown = await aggregateIssueClaimExclusions(resolved.record.spec.view.filter, {
      harness,
      states: resolved.record.spec.states,
      assignee: args.assignee,
    });
    return breakdown.claimable;
  } catch {
    return null;
  }
}

export type DecoratedAgent = AgentAssignment & {
  sessionState?: SessionState | null;
  confirmLiveness?: boolean | null;
  verdict?: MemberVerdict;
  wakeMode?: WakeMode;
  lastToolCallAt?: string | null;
  parkedOn?: string[];
  contextPressure?: ContextPressureBucket | null;
  coordHook?: CoordDeafState | null;
  coordLastReadAgoSec?: number | null;
  unanswered?: UnansweredDirectedSummary;
  monitorState?: MonitorState | null;
  nextFireAt?: string | null;
  loopMode?: 'work' | 'monitor' | null;
};

/**
 * PURE: scope the leader brief from the same presence-primary roster used by
 * fleet:status. Keeping this projection separate makes the membership parity
 * contract explicit: a live presence member is never dropped merely because
 * its assignment leg has no claim row yet.
 */
export function selectLeaderBriefMembers(
  entries: readonly DecoratedAgent[],
  fleet: string,
  includeStale = false,
): DecoratedAgent[] {
  return entries.filter(
    (entry) =>
      entry.fleetSlug === fleet &&
      (includeStale || entry.claims.length > 0 || entry.alive),
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
): LeaderBriefMember {
  const lastMs = a.lastToolCallAt ? Date.parse(a.lastToolCallAt) : NaN;
  return {
    agentId: a.agentId,
    label: a.label,
    fleetRole: a.fleetRole ?? null,
    sessionState: a.sessionState ?? null,
    verdict: a.verdict ?? null,
    wakeMode: a.wakeMode === 'auto' || a.wakeMode === 'manual' ? a.wakeMode : null,
    monitorState: a.monitorState ?? null,
    nextFireAt: a.nextFireAt ?? null,
    loopMode: a.loopMode ?? null,
    lastToolCallAgeMs: Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : null,
    doing: a.doing,
    workItemIds: a.claims
      .filter((claim) => claim.type === 'work-item' && claim.id)
      .map((claim) => claim.id as string),
    queuedCount: a.queued.length,
    load: a.load,
    stalled: a.stalled === true,
    contextPressure: a.contextPressure ?? null,
    ...(a.coordHook ? { coordHook: a.coordHook } : {}),
    ...(a.unanswered ? { unanswered: a.unanswered } : {}),
    ...(a.parkedOn && a.parkedOn.length > 0 ? { parkedOn: a.parkedOn } : {}),
    ...(() => {
      const suggestion = computeBenchSuggestion(a, claimableCount);
      return suggestion ? { benchSuggestion: suggestion } : {};
    })(),
  };
}

export default defineTool({
  name: 'fleet:leader-brief',
  profile: 'engineer',
  description:
    "A leader's ONE-call fleet-health brief: per-member sessionState, lifecycle `verdict` " +
    '(booted|joined|first-turn-done|speaking|stalled|dead), wakeMode, lastToolCallAgeMs, ' +
    'current claims (doing/workItemIds/queuedCount/load), healthy loop state (monitoring|waiting|' +
    'parked-awaiting-capability) + nextFireAt, progress-stalled flag, unanswered directed ' +
    'messages (count/oldestAgeMs/newest — with no reply/ack yet), contextPressure ' +
    '(ok|high|critical), bench state (parkedOn), benchSuggestion (alive but not advancing, ' +
    'or alive+idle with zero claims/queued and unparked — a fleet:bench candidate), ' +
    'and unownedCriticals (aged unassigned ' +
    'criticals this fleet\'s spec would admit). Scoped to ONE fleet ' +
    '(yours by default), not the whole workspace roster fleet:assignments returns. ' +
    'Replaces a leader\'s hand-assembled presence+assignments+inbox scan each monitor wake.',
  guidance: {
    when:
      "On a leader's repeating monitor tick: "
      + '"who is actually working / stuck / unanswered / about to compact right now, across MY fleet". '
      + "Folded automatically into coord:orient { mode:'monitor' } for a resolvable fleet leader.",
    notWhen:
      'The Mug/placement-decision read over the WHOLE workspace roster (fleet:assignments), ' +
      'or full message history for one member (coord:inbox { agent }).',
    chaining:
      'A stalled/dead member → fleet:kill + relaunch, or a directed coord:send nudge. A nonzero ' +
      '`unanswered` → coord:send a follow-up or coord:catch-up the thread. `benchSuggestion` set → ' +
      'fleet:bench it onto the gate it is actually blocked on. Nonzero `unownedCriticals` → claim it.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
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
      .positive()
      .max(168)
      .optional()
      .describe('WI-5213: hours an unassigned critical must age before it surfaces here. Default 4.'),
  }),
  async handler(args, ctx) {
    let actorWorkspace: string | null = null;
    let ownerId: string | undefined;
    try {
      const identity = resolveAgentIdentity(ctx);
      actorWorkspace = identity.workspaceId ?? null;
      ownerId = identity.ownerId;
    } catch {
      actorWorkspace = null;
    }
    const membership = await resolvePresenceFleet(ownerId, deriveFleetMembership());
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
    const grouped = selectLeaderBriefMembers(
      rosterEntries,
      fleet,
      args.include_stale,
    );
    await reconcileWakeability(grouped).catch(() => {});
    // Missing host is a liveness signal only for known visible members. Keep
    // this best-effort so absent roles never reinterpret bootstrapping/remote
    // rows as desktop deaths.
    try {
      const presence = await listPresence({ workspaceId });
      reconcilePsuHostLiveness(grouped, new Map(presence.map((p) => [p.ownerId, p.agentRole] as const)));
    } catch {
      /* host reconciliation never blocks the health brief */
    }
    await decorateParkedOn(grouped).catch(() => {});
    await decorateLoopMonitorStates(grouped).catch(() => {});
    await decorateMemberVerdicts(grouped).catch(() => {});
    await decorateContextPressure(grouped).catch(() => {});
    await decorateUnansweredDirected(grouped).catch(() => {});
    await decorateCoordDeafness(grouped).catch(() => {});
    // WI-5213: unowned criticals THIS fleet's claim spec would admit — read
    // failures already fail soft to `[]` inside readUnownedCriticalsForFleet.
    const unownedCriticals: UnownedCriticalCandidate[] = await readUnownedCriticalsForFleet({
      fleet,
      harness: args.harness,
      workspaceId,
      ageHours: args.unowned_critical_age_hours,
    });
    // EI-18681259560385029: read the fleet's LIVE claimable count before projecting members
    // — the per-member bench suggestion must not assert "drained or scoped-out" without it.
    // Fails soft to null (UNKNOWN), never 0.
    const fleetClaimableCount = await readFleetClaimableCount({
      fleet,
      harness: args.harness,
      workspaceId: actorWorkspace,
      assignee: ownerId,
    });
    const nowMs = Date.now();
    const members = grouped.map((a) => projectMember(a, nowMs, fleetClaimableCount));
    const self = resolveSelfRef(ctx);
    const markedMembers = markSelfRows(members, self, 'agentId');
    const summary = {
      fleet,
      members: members.length,
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
      // The live authoritative claimable total behind the two fields above (the same
      // number work_items:claimable reports). null ⇒ could not be read on this brief —
      // NOT zero, and never to be read as a drained lane.
      claimable_now: fleetClaimableCount,
      // WI-3818: make any incomplete canonical roster read explicit to callers
      // instead of silently presenting a partial membership list.
      degraded_roster_legs: rosterResult.degradedLegs,
      // WI-5213: unowned criticals (filing is not fixing) THIS fleet's claim
      // spec would admit — >0 here means an escalation the leader should act
      // on (reclaim/reassign/nudge), not weather to wait out.
      unowned_criticals: unownedCriticals.length,
    };
    const totalLoad = members.reduce((sum, m) => sum + m.load, 0);
    // EI-15055: loud fleet-wide zero-wip-with-supply alert — see computeStrandedFleetAlert.
    const strandedFleetAlert = computeStrandedFleetAlert({
      totalLoad,
      parkedCount: summary.parked,
      unownedCriticalCount: unownedCriticals.length,
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
    });
    let specStarvedAlert: { reason: string } | undefined;
    try {
      const { getClaimSpecRecord, fleetSpecBeeKey } = await import('../../scheduler/claim-spec-store');
      const { previewSpecPoolEffect } = await import('../../scheduler/spec-pool-preview');
      const rec = await getClaimSpecRecord({ cupId: fleetSpecBeeKey(fleet), workspaceId });
      if (rec.source !== 'default') {
        const effect = await previewSpecPoolEffect(rec.spec, { workspaceId, harness: args.harness ?? null });
        specStarvedAlert = computeSpecStarvedFleetAlert({
          totalLoad,
          specMatched: effect.matched,
          poolSize: effect.pool,
        });
      }
    } catch {
      /* best-effort — never block the brief on a spec-effect preview failure */
    }
    return {
      data: {
        ok: true,
        ...(self ? { self } : {}),
        summary: {
          ...summary,
          strandedFleetAlert: strandedFleetAlert != null,
          specStarvedAlert: specStarvedAlert != null,
          idleWithClaimableAlert: idleWithClaimableAlert != null,
        },
        members: markedMembers,
        ...(unownedCriticals.length > 0 ? { unownedCriticals } : {}),
        ...(strandedFleetAlert ? { strandedFleetAlertReason: strandedFleetAlert.reason } : {}),
        ...(specStarvedAlert ? { specStarvedAlertReason: specStarvedAlert.reason } : {}),
        ...(idleWithClaimableAlert
          ? { idleWithClaimableAlertReason: idleWithClaimableAlert.reason }
          : {}),
      },
    };
  },
});
