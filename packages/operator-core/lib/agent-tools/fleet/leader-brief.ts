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
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { resolvePresenceFleet } from '../coordination/presence-fleet';
import { resolveSelfRef, markSelfRows } from '../coordination/self-marker';
import { COORD_ROLES } from '../coordination/roles';
import { listFleetRosterDiagnosed } from '../../fleet/fleet-roster';
import type { AgentAssignment } from '../../fleet/assignments';
import { listPresence } from '../coordination/presence';
import { findLiveHost } from '../../events/await/psu-pty-discovery';
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
  benchSuggestion?: { reason: string; item: string | null; itemTitle: string | null };
  isSelf?: true;
}

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed).
 *  EI-9943: flag a member that is (a) actually alive right now — `speaking` or
 *  `first-turn-done`, i.e. burning real turns, not booted/joined/dead — (b)
 *  holding a claim that `stalled` already marks as not-advancing, and (c) NOT
 *  already benched (`parkedOn` empty) — benching an already-benched member is
 *  a no-op the leader doesn't need surfaced again. Reuses `stalled`/`verdict`/
 *  `parkedOn` verbatim (the SAME signals `fleet:assignments`' stalled_claims /
 *  fleet:bench's parkedOn already compute) — no new tracking, no wake-count
 *  state: `stalled`'s existing progress-window check is the "blocked for a
 *  while" signal this reuses instead of inventing a separate wake counter. */
export function computeBenchSuggestion(
  a: Pick<DecoratedAgent, 'stalled' | 'verdict' | 'parkedOn' | 'doing'>,
): LeaderBriefMember['benchSuggestion'] {
  if ((a.parkedOn?.length ?? 0) > 0) return undefined;
  if (a.verdict !== 'speaking' && a.verdict !== 'first-turn-done') return undefined;
  if (!a.stalled) return undefined;
  return {
    reason:
      "holds a claim not advancing while alive — likely live-loop-polling a peer's " +
      'critical path instead of parking on an event (fleet:bench).',
    item: a.doing?.id ?? null,
    itemTitle: a.doing?.title ?? null,
  };
}

export type DecoratedAgent = AgentAssignment & {
  sessionState?: SessionState | null;
  confirmLiveness?: boolean | null;
  verdict?: MemberVerdict | null;
  wakeMode?: WakeMode | string | null;
  lastToolCallAt?: string | null;
  parkedOn?: string[];
  contextPressure?: ContextPressureBucket | null;
  coordHook?: CoordDeafState | null;
  coordLastReadAgoSec?: number | null;
  unanswered?: UnansweredDirectedSummary;
  monitorState?: MonitorState | null;
  nextFireAt?: string | null;
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
  for (const agent of agents) {
    const role = agentRoles.get(agent.agentId);
    if (role == null || role === 'cup') continue;
    if (agent.sessionState === 'parked' && findHost(agent.agentId) == null) {
      agent.sessionState = 'ended';
      agent.alive = false;
    }
  }
  return agents;
}

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed). */
export function projectMember(a: DecoratedAgent, nowMs: number): LeaderBriefMember {
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
      const suggestion = computeBenchSuggestion(a);
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
    '(ok|high|critical), bench state (parkedOn), and benchSuggestion (EI-9943: alive+speaking ' +
    'but not advancing, not yet benched — nudge toward fleet:bench). Scoped to ONE fleet ' +
    '(yours by default) instead of the whole workspace roster fleet:assignments returns. ' +
    'Replaces the hand-assembled presence+assignments+inbox scan a leader otherwise repeats ' +
    'every monitor wake.',
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
      'fleet:bench it onto the gate it is actually blocked on, instead of live-loop-polling.',
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
    const workspaceId = args.workspace ?? actorWorkspace ?? activeWorkspaceId();
    // fleet:status's presence-primary roster is the membership authority. The
    // old claim-primary read omitted live idle members whose assignment view had
    // no row, so leader-brief and fleet:status reported different rosters.
    const rosterResult = await listFleetRosterDiagnosed({ fleetSlug: fleet, workspaceId });
    const grouped = selectLeaderBriefMembers(
      rosterResult.entries,
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
    const nowMs = Date.now();
    const members = grouped.map((a) => projectMember(a, nowMs));
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
      // WI-3818: make any incomplete canonical roster read explicit to callers
      // instead of silently presenting a partial membership list.
      degraded_roster_legs: rosterResult.degradedLegs,
    };
    return {
      data: {
        ok: true,
        ...(self ? { self } : {}),
        summary,
        members: markedMembers,
      },
    };
  },
});
