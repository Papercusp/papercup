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
  decorateDirectiveActuation,
  decorateCoordDeafness,
  type MemberVerdict,
  type MonitorState,
} from './assignments';
import type { CoordDeafState } from '../coordination/inbox-read-freshness';
import type { SessionState } from '../coordination/presence-wakeability';
import type { WakeMode } from '../coordination/wake-mode';
import type { ContextPressureBucket } from '../coordination/context-pressure';
import type { UnansweredDirectedSummary } from '../coordination/unanswered-directed';
import type { DirectiveActuationSummary } from '../coordination/directive-effect';
import {
  readUnownedCriticalsForFleet,
  readOrphanedInFlightForFleet,
  type UnownedCriticalCandidate,
  type OrphanedInFlightCandidate,
} from '../../harness/improvements/unowned-critical-escalation';
import { listActiveComposedRoots, loadTreeLeaves } from '../../events/await/compose-store';
import type { TimeoutBehavior } from '../../events/await/types';
import { withBoundedTimeout } from '../../bounded-timeout';

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
    // WI-5973: the fleet LEADER running its monitor loop, correctly (per the
    // documented leader contract) held NO work-item claim — optional so
    // pre-existing call sites keep compiling unchanged; absent reads as "not
    // the leader's own monitor row", never a false suppression.
    fleetRole?: string | null;
    loopMode?: 'work' | 'monitor' | null;
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
  /** EI-18703234178947959: the fleet's own control state is winding-down (owner-paused).
   *  Suppresses the alert entirely — see the defence-in-depth note below. */
  fleetPaused?: boolean | null;
}): { reason: string } | undefined {
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
}): { reason: string } | undefined {
  if (input.fleetPaused) return undefined;
  if (input.claimable == null || input.claimable !== 0) return undefined;
  if (input.matchedByFilter == null || input.matchedByFilter <= 0) return undefined;
  if (input.idleMemberCount <= 0) return undefined;
  const floors = topExcludedFloors(input.excluded);
  return {
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
 * EI-18681259560385029: IO shell for the alert above — the fleet's live authoritative
 * claimable count, or `null` when it genuinely could not be read.
 *
 * Uses `aggregateIssueClaimExclusions` (the SAME oracle behind work_items:claimable and
 * scheduler:get_next) resolved through the SAME `resolveFleetClaimSpec` path that
 * `work_items:claimable { spec: <fleetSlug> }` uses, so the number this alert fires on and
 * the number an agent sees when they check by hand structurally cannot disagree. Note
 * `claimable` is POST-floor, unlike `matchedByFilter` and previewSpecPoolEffect's `matched`
 * — those are pre-floor filter counts (~113 vs 4 on this fleet at the time of writing),
 * which is why the spec-starved alert cannot stand in for this one.
 *
 * EI-18689489507862177: this used to `return breakdown.claimable` and DISCARD the rest of
 * the breakdown it had already paid for. That single lost field is what made the whole
 * "gated vs drained" distinction below unavailable to the leader — `matchedByFilter` and
 * the per-floor `excluded` buckets were fetched on every brief and thrown away one line
 * before the code that needed them. Return the whole shape; the extra fields cost nothing.
 *
 * Fails soft to `null`, never to `0`: a read error must not manufacture "the lane is
 * drained" — that synthesised zero-state is the same class of bug as the wording this item
 * fixes, and it would silently disable the alert rather than announcing itself.
 */
export interface FleetLaneHealth {
  /** Post-floor: what a self-selecting member would actually see as claimable right now. */
  claimable: number;
  /** Pre-floor: rows the fleet's own view.filter matches. >0 with claimable===0 ⇒ GATED, not drained. */
  matchedByFilter: number;
  /** Per-floor counts of why matched rows are not claimable. Buckets OVERLAP (not a partition). */
  excluded: Record<string, number>;
}

async function readFleetLaneHealth(args: {
  fleet: string;
  harness?: string;
  workspaceId?: string | null;
  assignee?: string;
}): Promise<FleetLaneHealth | null> {
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
    return {
      claimable: breakdown.claimable,
      matchedByFilter: breakdown.matchedByFilter,
      excluded: breakdown.excluded as unknown as Record<string, number>,
    };
  } catch {
    return null;
  }
}

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
  confirmLiveness?: boolean | null;
  verdict?: MemberVerdict;
  wakeMode?: WakeMode;
  lastToolCallAt?: string | null;
  parkedOn?: string[];
  /** EI-18732218464905145: the leader-legible collapse of `parkedOn` — set by
   *  `decorateComposedParkedOn` when a raw key is a `composed-root:<id>` sentinel.
   *  Absent (or equal to `parkedOn` verbatim) when the member holds no composed
   *  await, or the resolution read failed (fails open to the raw flat list). */
  parkedOnResolved?: Array<string | ComposedParkEntry>;
  contextPressure?: ContextPressureBucket | null;
  coordHook?: CoordDeafState | null;
  coordLastReadAgoSec?: number | null;
  unanswered?: UnansweredDirectedSummary;
  directives?: DirectiveActuationSummary;
  monitorState?: MonitorState | null;
  nextFireAt?: string | null;
  loopMode?: 'work' | 'monitor' | null;
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
  /** EI-18689489507862177: pre-floor match + per-floor exclusions, so the bench
   *  suggestion can tell a GATED lane from a drained one. Absent = not read. */
  laneGating?: { matchedByFilter: number; excluded?: Record<string, number> } | null,
  /** EI-18703234178947959: the fleet's own control_state is winding-down (owner-paused),
   *  so an idle member is compliant and carries no bench suggestion. Absent = not paused. */
  fleetPaused?: boolean | null,
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
    ...(a.directives ? { directives: a.directives } : {}),
    ...(() => {
      // EI-18732218464905145: prefer the composed-collapsed view when one was
      // resolved; fall back to the raw flat list (unresolved / non-composed /
      // resolution-failed) exactly as before this fix.
      const parked = a.parkedOnResolved ?? a.parkedOn;
      return parked && parked.length > 0 ? { parkedOn: parked } : {};
    })(),
    ...(() => {
      const suggestion = computeBenchSuggestion(a, claimableCount, laneGating, fleetPaused);
      return suggestion ? { benchSuggestion: suggestion } : {};
    })(),
    ...(computeDormantAlert(a, fleetPaused) ? { dormant: true } : {}),
  };
}

export default defineTool({
  name: 'fleet:leader-brief',
  profile: 'engineer',
  description:
    "A leader's ONE-call health brief for ONE fleet (yours by default). Per member: " +
    'sessionState, `verdict` (booted|joined|first-turn-done|speaking|stalled|dead), wakeMode, ' +
    'lastToolCallAgeMs, claims (doing/workItemIds/queuedCount/load), loop state ' +
    '(monitoring|waiting|parked-awaiting-capability)+nextFireAt, stalled, unanswered, ' +
    'contextPressure (ok|high|critical), parkedOn + parkedOnResolved (a composed await is ONE ' +
    'entry carrying its ROOT deadline + any/all mode, never loose leaves), benchSuggestion ' +
    '(check `kind`), `dormant`, unownedCriticals + abandonedUnclaimed (started then ABANDONED — ' +
    'assignee IS NULL, so CLAIM it).',
  guidance: {
    when:
      'AFTER something wakes you: "who is working / stuck / unanswered / about to compact across MY fleet". ' +
      'How you SEE the fleet, NOT how you watch it — PARK, do not poll: events:await over ' +
      'fleet:{member-dead,context-critical,claim-released,item-completed}:<slug> (slug LAST) + ' +
      'work-item:claimable { payload_filter:{plan} }. loop:arm is then a LONG fallback heartbeat ' +
      "(15m+), never the monitor. Folded into coord:orient { mode:'monitor' }. " +
      'Spec: agent-insights/leading-a-fleet-without-polling.',
    notWhen:
      'The Mug/placement read over the WHOLE workspace roster (fleet:assignments), ' +
      'or one member\'s message history (coord:inbox { agent }).',
    chaining:
      'A stalled/dead member → fleet:kill + relaunch, or a directed coord:send nudge. A nonzero ' +
      '`unanswered` → coord:send a follow-up or coord:catch-up. `benchSuggestion` set → ' +
      'fleet:bench onto the blocked-on gate; `dormant:true` → wake, never bench. ' +
      'Nonzero `unownedCriticals`/`abandonedUnclaimed` → CLAIM it (already unassigned, so ' +
      'work_items:release is a no-op returning ok:true — WI-6678). ' +
      '`idleWithClaimableAlert` → wake those members; never bench (the queue is NOT empty).',
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
    orphan_min_age_minutes: z
      .number()
      .min(0)
      .max(1440)
      .optional()
      .describe('Minutes an orphaned in-flight item must sit before it surfaces here. Default 0.'),
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
    // EI-18732218464905145: collapse a composed-await park (root + leaf sentinels)
    // into ONE structured entry before projection — best-effort, never blocks.
    await decorateComposedParkedOn(grouped).catch(() => {});
    await decorateLoopMonitorStates(grouped).catch(() => {});
    await decorateMemberVerdicts(grouped).catch(() => {});
    await decorateContextPressure(grouped).catch(() => {});
    await decorateUnansweredDirected(grouped).catch(() => {});
    // P-013: what the LEDGER says happened, beside what the member said. Scoped to
    // the caller's own directives — you are accountable for what you instructed.
    await decorateDirectiveActuation(grouped, ownerId).catch(() => {});
    await decorateCoordDeafness(grouped).catch(() => {});
    // WI-5213: unowned criticals THIS fleet's claim spec would admit — read
    // failures already fail soft to `[]` inside readUnownedCriticalsForFleet.
    const unownedCriticals: UnownedCriticalCandidate[] = await readUnownedCriticalsForFleet({
      fleet,
      harness: args.harness,
      workspaceId,
      ageHours: args.unowned_critical_age_hours,
    });
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
    const nowMs = Date.now();
    const members = grouped.map((a) =>
      projectMember(a, nowMs, fleetClaimableCount, fleetLaneHealth, fleetPause.paused),
    );
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
      // EI-18703234178947959: this fleet's own control_state is winding-down (fleet:pause /
      // fleet:wind-down). Emitted EXPLICITLY rather than left implicit, because it is the
      // reason the idle-member alerts above read 0/false: idle members are COMPLYING with
      // the pause, so "no alert" here means "no action needed", not "nothing was checked".
      // Lift with fleet:resume; until then the claim path refuses these members work.
      fleet_paused: fleetPause.paused,
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
      fleetPaused: fleetPause.paused,
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
    });
    let specStarvedAlert: { reason: string } | undefined;
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
        specFilter = rec.spec.view?.filter ?? null;
        harnessWidePool = effect.pool;
        specMatched = effect.matched;
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
          floorStarvedAlert: floorStarvedAlert != null,
        },
        members: markedMembers,
        ...(unownedCriticals.length > 0 ? { unownedCriticals } : {}),
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
        ...(strandedFleetAlert ? { strandedFleetAlertReason: strandedFleetAlert.reason } : {}),
        ...(specStarvedAlert ? { specStarvedAlertReason: specStarvedAlert.reason } : {}),
        ...(idleWithClaimableAlert
          ? { idleWithClaimableAlertReason: idleWithClaimableAlert.reason }
          : {}),
        ...(floorStarvedAlert ? { floorStarvedAlertReason: floorStarvedAlert.reason } : {}),
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
        ...(harnessWidePool !== undefined ? { harnessWidePool } : {}),
        ...(specMatched !== undefined ? { specMatched } : {}),
      },
    };
  },
});
