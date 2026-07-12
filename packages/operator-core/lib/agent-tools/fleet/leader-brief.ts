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
 * (reconcileWakeability → decorateMemberVerdicts → decorateParkedOn →
 * decorateContextPressure → decorateUnansweredDirected — all reused verbatim,
 * reuse-first, no forked logic) filtered to ONE fleet's members and reshaped
 * into a leader-lean per-member row (ages in ms, not raw timestamps; claims
 * collapsed to counts — the fields a leader's relaunch/re-steer/nudge
 * decision actually reads, not the full claim-ledger fleet:assignments
 * carries for the Queen's placement decision).
 *
 * Resolves the target fleet from `deriveFleetMembership()` (the caller's own
 * launch-env fleet) unless `fleet` is passed explicitly (an su monitoring a
 * fleet it didn't launch into). coord:orient's monitor mode folds this in for
 * a fleet leader automatically (see orient.ts) — a leader's monitor wake is
 * then ONE round-trip instead of orient + a separate fleet:assignments scan.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity, deriveFleetMembership } from '../coordination/identity';
import { resolveSelfRef, markSelfRows } from '../coordination/self-marker';
import { COORD_ROLES } from '../coordination/roles';
import { groupByAgent, listFleetAssignments, type AgentAssignment } from '../../fleet/assignments';
import {
  reconcileWakeability,
  decorateMemberVerdicts,
  decorateParkedOn,
  decorateContextPressure,
  decorateUnansweredDirected,
  decorateCoordDeafness,
  type MemberVerdict,
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
  /** ms since the member's last recorded tool call; null = never (still booting). */
  lastToolCallAgeMs: number | null;
  doing: unknown;
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
  verdict?: MemberVerdict;
  wakeMode?: WakeMode;
  lastToolCallAt?: string | null;
  parkedOn?: string[];
  contextPressure?: ContextPressureBucket | null;
  coordHook?: CoordDeafState | null;
  coordLastReadAgoSec?: number | null;
  unanswered?: UnansweredDirectedSummary;
};

/** PURE: exported for direct unit-testing (no PG/DI ceremony needed). */
export function projectMember(a: DecoratedAgent, nowMs: number): LeaderBriefMember {
  const lastMs = a.lastToolCallAt ? Date.parse(a.lastToolCallAt) : NaN;
  return {
    agentId: a.agentId,
    label: a.label,
    fleetRole: a.fleetRole ?? null,
    sessionState: a.sessionState ?? null,
    verdict: a.verdict ?? null,
    wakeMode: a.wakeMode ?? null,
    lastToolCallAgeMs: Number.isFinite(lastMs) ? Math.max(0, nowMs - lastMs) : null,
    doing: a.doing,
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
    'current claims (doing/queuedCount/load), progress-stalled flag, unanswered directed ' +
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
      'The Queen/placement-decision read over the WHOLE workspace roster (fleet:assignments), ' +
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
      .describe("Fleet slug to brief. Defaults to the caller's own launch-env fleet (deriveFleetMembership) — pass explicitly when monitoring a fleet you didn't launch into."),
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
    const fleet = args.fleet ?? deriveFleetMembership().fleetSlug;
    if (!fleet) {
      return {
        data: {
          ok: false,
          error: 'no_fleet',
          hint:
            "No fleet resolvable — this session's PAPERCUSP_FLEET_SLUG is unset and no { fleet } " +
            'was passed. Pass { fleet: "<slug>" } explicitly, or use fleet:assignments for the ' +
            'whole-workspace roster.',
        },
      };
    }
    const workspaceId = args.workspace ?? actorWorkspace ?? activeWorkspaceId();
    const rows = await listFleetAssignments({
      workspaceId,
      harness: args.harness,
      activeOnly: true,
    });
    const grouped: DecoratedAgent[] = groupByAgent(rows).filter(
      (g) => g.fleetSlug === fleet && (args.include_stale || g.claims.length > 0 || g.alive),
    );
    await reconcileWakeability(grouped).catch(() => {});
    await decorateMemberVerdicts(grouped).catch(() => {});
    await decorateParkedOn(grouped).catch(() => {});
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
