/**
 * fleet:status — one fleet's registry identity + its live roster (named-su-agent-fleets-
 * 2026-06-29 P-004).
 *
 * Combines the durable agent_fleets row (title/description/leader) with the unified
 * fleet roster (listFleetRoster, keyed on the fleet_slug presence label) — "who's in this
 * fleet and exactly what each is doing", the per-fleet analog of coord:presence.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, readJsonResult, type SeeAlsoEntry } from '@papercusp/agent-mcp';
import { getFleet } from '../../agent-fleets-store';
import {
  listFleetRosterDiagnosed,
  splitFleetRosterCounts,
  countRunningFleetBees,
  countRunningWorkspaceBees,
  type FleetRosterEntry,
  type FleetRosterDegradedLeg,
} from '../../fleet/fleet-roster';
import { applyPsuHostAuthority } from '../coordination/liveness-oracle';
import { getCompletionIntegrityStats, type CompletionIntegrityStats } from '../../work-items';
import { withBoundedTimeout } from '../../bounded-timeout';
import type { AdvSessionEndedBy } from '../../adv-sessions';
import { json, resolveFleetCaller, ROUTING_LADDER } from './_shared';
import { crossCheckLaunchVerification, buildOwnerActivityReader } from '../../fleet/launch-verification-cross-check';

/**
 * WI-3818: bound the two OPTIONAL legs — completionStats (harness-scoped
 * aggregate, only fetched when `harness` is passed) and the two bee-count
 * queries — so a slow one degrades to "omitted"/0 instead of hanging the
 * whole handler until the 55s MCP client timeout. The roster itself carries
 * the bulk of the fan-out and is bounded internally (fleet-roster.ts); these
 * are the "drop completionStats/queued detail first" fallback the ticket
 * asks for — completionStats is the first thing to go missing under load.
 */
const FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS = 6_000;

/**
 * fleet:status payload tiers (context-trimming-tiers-2026-07-01 P-022).
 *
 * The registry roster is intentionally lossless for full-tier callers, but a
 * normal model-facing read must not send one unbounded row per historical/live
 * member through the result door. Keep the control/liveness decision core on
 * every row, cap the roster, and make the cut explicit so a leader can narrow
 * or request the full tier when it needs a particular member's resume detail.
 */
export const FLEET_STATUS_TIER_CAPS = {
  trimmed: { members: 8, label: 80, intent: 100, doing: 80, resumeHint: 180 },
  standard: { members: 12, label: 140, intent: 180, doing: 120, resumeHint: 300 },
} as const;

type FleetStatusTier = keyof typeof FLEET_STATUS_TIER_CAPS;

const clipFleetStatus = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : null;

const isNonRunnableFleetMember = (row: unknown): boolean => {
  const state = (row as { sessionState?: unknown } | null | undefined)?.sessionState;
  return state === 'ended' || state === 'suspect' || state === 'draining';
};

/**
 * Shape the status read after the handler has produced its complete roster.
 * Leader and non-runnable rows are selected before ordinary live rows when a
 * cap is needed: a truncated monitor read must retain the rows that determine
 * whether leadership is available and whether a member needs recovery.
 */
export function shapeFleetStatus(data: unknown, tier: FleetStatusTier): unknown {
  const d = data as ({ members?: unknown[]; leaderId?: unknown } & Record<string, unknown>) | null | undefined;
  if (!d || !Array.isArray(d.members)) return data;
  const caps = FLEET_STATUS_TIER_CAPS[tier];

  const projectMember = (row: unknown): Record<string, unknown> => {
    const r = (row ?? {}) as Record<string, unknown>;
    const sessionState = typeof r.sessionState === 'string' ? r.sessionState : null;
    const base = {
      agentId: r.agentId ?? null,
      label: clipFleetStatus(r.label, caps.label),
      fleetRole: r.fleetRole ?? null,
      intent: clipFleetStatus(r.intent, caps.intent),
      // Keep the liveness verdict and its raw heartbeat signal together. A
      // fresh heartbeat with an ended session is deliberately not runnable.
      heartbeatFresh: typeof r.heartbeatFresh === 'boolean' ? r.heartbeatFresh : null,
      sessionState,
      lastActiveSecAgo: typeof r.lastActiveSecAgo === 'number' ? r.lastActiveSecAgo : null,
      doing: clipFleetStatus(r.doing, caps.doing),
      load: typeof r.load === 'number' ? r.load : null,
    };

    if (sessionState === 'ended' || sessionState === 'suspect') {
      return {
        ...base,
        resumable: r.resumable === true,
        endedAt: typeof r.endedAt === 'string' ? r.endedAt : null,
        endedBy: typeof r.endedBy === 'string' ? r.endedBy : null,
        ...(tier === 'standard'
          ? {
              resumeHint: clipFleetStatus(r.resumeHint, caps.resumeHint),
              endedAtCaveat: clipFleetStatus(r.endedAtCaveat, caps.resumeHint),
            }
          : {}),
      };
    }

    if (tier === 'standard') {
      return {
        ...base,
        ...(typeof r.lastToolCallAt === 'string' ? { lastToolCallAt: r.lastToolCallAt } : {}),
      };
    }
    return base;
  };

  const source = d.members;
  const selected =
    source.length <= caps.members
      ? source
      : (() => {
          const prioritized = [
            ...source.filter((row) => row && (row as { agentId?: unknown }).agentId === d.leaderId),
            ...source.filter(isNonRunnableFleetMember),
            ...source,
          ];
          const seen = new Set<unknown>();
          return prioritized.filter((row) => {
            if (seen.has(row)) return false;
            seen.add(row);
            return true;
          });
        })().slice(0, caps.members);

  const members = selected.map(projectMember);
  if (source.length > caps.members) {
    members.push({
      ...projectMember({}),
      agentId: '(truncated)',
      intent: `showing ${caps.members} of ${source.length} — narrow by member or use payloadTier:"full" for the complete roster`,
    });
  }

  return {
    ...d,
    members,
    ...(source.length > caps.members
      ? {
          members_note: `roster capped at ${caps.members} of ${source.length}; leader and non-runnable rows prioritized`,
        }
      : {}),
  };
}

/**
 * Reconcile fleet:status's member census with the local psu host authority.
 *
 * `coord_presence` heartbeats can outlive a visible terminal session, leaving a
 * dead desktop member in the live roster. The liveness oracle already owns the
 * rule for ending a hostless known psu cohort; fleet:status opts into that rule
 * only for rows with a recorded tty. Headless su members intentionally have no
 * tty (and may have no local psu-pty host between wakes), so applying the rule to
 * every `agent_role:'su'` row would turn legitimate headless members into ghosts.
 */
export function reconcileFleetStatusLiveness(
  roster: FleetRosterEntry[],
  findHost?: (ownerId: string) => unknown | null,
): FleetRosterEntry[] {
  const visibleRoles = new Map<string, string>();
  for (const member of roster) {
    if (member.tty != null && member.agentRole != null && member.agentRole !== 'cup') {
      visibleRoles.set(member.agentId, member.agentRole);
    }
  }
  return applyPsuHostAuthority(roster, visibleRoles, findHost);
}

export default defineTool({
  name: 'fleet:status',
  description:
    'Show one fleet\'s identity (title, description, current leader plus its liveness/vacancy signal) plus its live roster — who is in the fleet and what each member is doing right now — with the roster split as `memberCount` VISIBLE desktop su members / `beeCount` background autonomous-loop bees (WI-1764). Also reports `runningBees`: background bees running in the whole workspace — a fleet with 0 members while runningBees>0 means cup:spawn (bees) was used where fleet:launch-on-plan (desktop members) was meant. Optionally include harness-scoped completion integrity stats so progress reads can separate genuine completions from dedup churn. Under host load, a slow sub-read (presence/assignments/completion-stats/bee-counts) degrades to a fallback instead of hanging the whole call — a degraded response still returns promptly, with `degraded:true` + `degradedLegs` naming exactly which reads timed out/failed (WI-3818). The per-fleet analog of coord:presence.',
  guidance: {
    when: 'Inspecting a specific fleet — its leader and live members — before joining it or handing it a plan.',
    notWhen: 'For the catalog of ALL fleets with availability, use fleet:list.',
    chaining: ROUTING_LADDER,
    // Result-aware (D-003): fill the CONCRETE `@fleet:<slug>` history selector from
    // the result — the "coord:catch-up @fleet:X for who-was-ever-here" pointer WI-1348
    // asks for — carrying the real ended-member count when the fleet has dead sessions.
    // The adjacent-lens pointers are always relevant, so they stay static.
    seeAlso: (result) => {
      const j = readJsonResult<{
        ok?: boolean;
        slug?: string;
        members?: Array<{ sessionState?: string }>;
      }>(result);
      const out: SeeAlsoEntry[] = [
        'fleet:list (the catalog of ALL fleets with availability)',
        'fleet:assignments (what this fleet\'s members are working on)',
        'coord:roster { view:"members" } (membership across hive + fleet)',
      ];
      if (j?.ok && j.slug) {
        const ended = (j.members ?? []).filter((m) => ['ended', 'suspect', 'draining'].includes(m.sessionState ?? '')).length;
        out.push({
          tool: 'coord:catch-up',
          selector: `@fleet:${j.slug}`,
          reason: ended > 0 ? `${ended} ended — who-was-ever-here` : 'who-was-ever-here',
        });
      }
      return out;
    },
  },
  capability: 'fleet:status',
  requirePrincipal: false,
  // EI-20228676874653267: this supervision read owns its DB accessors and
  // never reads ctx.tx. Do not retain the dispatcher's ambient transaction
  // across the roster/optional-leg fan-out; it pins an org-app slot and can
  // starve subsequent control-plane calls under fleet load.
  skipWorkspaceTx: true,
  // The explicit full tier is a deliberate lossless roster read. If its JSON
  // exceeds the generic result door, that door appends a spill pointer/footer
  // into the body and makes machine consumers (for example `ptool --raw`)
  // unable to parse it. Trimmed and standard calls remain bounded by the
  // shapers above; full callers own the larger response they requested.
  skipResultDoor: 'oversize-by-design',
  agentRoles: [...SU_ROLES, 'cup'],
  args: z.object({
    fleet: z.string().min(1).describe('The fleet slug (from fleet:list).'),
    harness: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        'Optional harness slug for progress reporting. When provided, the result includes `completionStats` so genuine completions are separated from dedup/unverified terminal rows.',
      ),
  }),
  // Context-trimming tiers keep the supervision decision core while bounding
  // the roster. Full-tier callers retain the lossless handler response.
  shape: {
    standard: (data) => shapeFleetStatus(data, 'standard'),
    trimmed: (data) => shapeFleetStatus(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const { workspaceId } = resolveFleetCaller(ctx);
    const fleet = await getFleet(workspaceId, args.fleet);
    if (!fleet) {
      return json(
        { ok: false, error: `no fleet '${args.fleet}' in this workspace — see fleet:list` },
        true,
      );
    }
    // WI-3818: each leg is independently bounded so a slow/hanging one degrades
    // to its fallback instead of hanging the whole handler — completionStats
    // (an optional harness-scoped aggregate) and the bee counts are the
    // droppable-first detail; the roster itself reports its OWN per-sub-read
    // degradation (fleet-roster.ts) rather than degrading as a single unit.
    const [rosterResult, completionStatsResult, runningBeesResult, beeCountResult] = await Promise.all([
      listFleetRosterDiagnosed({ fleetSlug: args.fleet, workspaceId }),
      args.harness
        ? withBoundedTimeout<CompletionIntegrityStats | null>(getCompletionIntegrityStats(args.harness), {
            fallback: null,
            timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
            label: 'fleet:status:completionStats',
          })
        : Promise.resolve({ value: null, degraded: false, elapsedMs: 0 } as const),
      withBoundedTimeout(countRunningWorkspaceBees(workspaceId), {
        fallback: 0,
        timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
        label: 'fleet:status:runningBees',
      }),
      withBoundedTimeout(countRunningFleetBees(args.fleet, workspaceId), {
        fallback: 0,
        timeoutMs: FLEET_STATUS_OPTIONAL_LEG_TIMEOUT_MS,
        label: 'fleet:status:beeCount',
      }),
    ]);
    const roster = reconcileFleetStatusLiveness(rosterResult.entries);
    const completionStats = completionStatsResult.value;
    const runningBees = runningBeesResult.value;
    const beeCount = beeCountResult.value;
    // Aggregate every degraded leg (roster sub-reads prefixed `roster.<leg>` +
    // the three top-level optional legs) into one flat, order-stable list —
    // absent entirely when nothing degraded, so a healthy call's payload is
    // byte-identical to pre-WI-3818 behavior.
    const degradedLegs: string[] = [
      ...rosterResult.degradedLegs.map((leg: FleetRosterDegradedLeg) => `roster.${leg}`),
      ...(completionStatsResult.degraded ? ['completionStats'] : []),
      ...(runningBeesResult.degraded ? ['runningBees'] : []),
      ...(beeCountResult.degraded ? ['beeCount'] : []),
    ];
    // WI-1764 #4 / WI-1813: `memberCount` = VISIBLE desktop su members from the roster
    // (presence — members-only, was roster.length). `beeCount` = BACKGROUND bees spawned
    // INTO this fleet, from the nursery (countRunningFleetBees — reliable + presence-
    // independent) rather than the roster's presence-labeled split, which under-counted a
    // bee that had not yet written its presence fleet label.
    // EI-7137: splitFleetRosterCounts's own contract is "a set of LIVE fleet-roster
    // entries" — but `roster` here is the FULL roster (every presence row tagged with
    // this fleet_slug, including ones EI-5858's wakeability reconciliation has already
    // marked sessionState:'ended'/'suspect'/'draining'). Passing it in unfiltered let memberCount count dead
    // former members forever (observed live: memberCount=19 for a 10-live fleet after a
    // wave died). non-runnable `sessionState` values are the authoritative dead signal (a stale-but-
    // still-heartbeating row can otherwise mask a dead session — see EI-5858) — filter
    // those out before counting, but keep them in the full `members[]` list below (still
    // wants full visibility, including who died or is still bootstrapping, for the
    // leader/owner reading this). `recorded` is also non-live: it is a launch-window
    // session state with no live presence, and the leader vacancy calculation below
    // already treats it as vacant.
    const liveRoster = roster.filter(
      (m) => !['ended', 'suspect', 'draining', 'recorded'].includes(m.sessionState ?? ''),
    );
    const { members: memberCount } = splitFleetRosterCounts(liveRoster);

    // The registry's leader is durable, while its liveness belongs to the roster.
    // Do not return that durable id as an unannotated `leader`: callers naturally read
    // the same bare shape as "this is the active authority". `leaderId` preserves the
    // identity for callers that need it; `leader` carries the joined liveness verdict.
    // A missing roster row is UNKNOWN (not vacancy); only an explicit ended/recorded
    // verdict is positive evidence that the slot is gone. A null registry leader is an
    // explicit vacancy.
    const leaderMember = fleet.leaderOwnerId
      ? roster.find((member) => member.agentId === fleet.leaderOwnerId)
      : undefined;
    const leaderSessionState = leaderMember?.sessionState ?? null;
    const leaderVacant =
      fleet.leaderOwnerId == null || ['ended', 'recorded'].includes(leaderSessionState ?? '');
    const leaderLiveness = fleet.leaderOwnerId
      ? {
          agentId: fleet.leaderOwnerId,
          // An absent oracle row is not evidence of a live session. Keep the
          // distinction from an explicit ended row in `presenceRow`.
          sessionState: leaderMember?.sessionState ?? 'unknown',
          heartbeatFresh: leaderMember
            ? (leaderMember.heartbeatFresh ?? leaderMember.alive ?? false)
            : false,
          lastActiveSecAgo: leaderMember?.lastActiveSecAgo ?? null,
          presenceRow: leaderMember != null,
        }
      : null;

    // agent-launch-resume-primitives P-006 / D-006: there is deliberately NO
    // "resume the fleet" verb — any single verb has to GUESS which dead members to
    // revive (all of them? only the ones that died this hour? not the one killed two
    // days ago you never want back), and every guess is wrong for someone. So give
    // the leader the FACTS instead: for each ENDED member, when it died and whether a
    // session is actually resumable — and let it compose the revival per member
    // (capability:launch-agent { resume: { agentId } }, or fresh, or a fork).
    const endedIds = roster
      .filter((m) => ['ended', 'suspect'].includes(m.sessionState ?? ''))
      .map((m) => m.agentId);
    let resumableByOwner = new Map<
      string,
      { sessionId: string | null; endedAt: string | null; endedBy: AdvSessionEndedBy | null }
    >();
    if (endedIds.length) {
      try {
        const { advSessionsByCoordOwner } = await import('../../adv-sessions');
        const advByOwner = await advSessionsByCoordOwner();
        resumableByOwner = new Map(
          endedIds
            .map((id) => [id, advByOwner.get(id)] as const)
            .filter((e): e is [string, NonNullable<(typeof e)[1]>] => !!e[1])
            .map(([id, row]) => [
              id,
              { sessionId: row.sessionId, endedAt: row.endedAt, endedBy: row.endedBy },
            ]),
        );
      } catch {
        // Best-effort enrichment — a lookup failure must never fail the status read.
        resumableByOwner = new Map();
      }
    }

    // LAUNCH-PROBE FALSE-NEGATIVE CROSS-CHECK. `launchTransaction.failed` records what a ~25s probe saw at
    // spawn time; it is not an observation of whether the member worked. Two members stamped "AGENT DID NOT
    // START" on 2026-08-16 went on to close 15 evidenced items over 15-19h while this surface reported an
    // empty fleet. The registry holds both halves — the launch record and the work ledger — so it runs the
    // falsifier itself rather than leaving it to a reader who will forget.
    const failedOwnerIds = (fleet.lastLaunchTransaction?.failed ?? [])
      .map((f) => f?.ownerId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    let launchVerification: Awaited<ReturnType<typeof crossCheckLaunchVerification>> = {
      launchVerificationFalseNegative: [],
    };
    if (failedOwnerIds.length > 0) {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        const { sql } = getOrgPg();
        launchVerification = await crossCheckLaunchVerification(
          failedOwnerIds,
          buildOwnerActivityReader(
            sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<Record<string, unknown>[]>,
            fleet.workspaceId,
          ),
        );
      } catch (e) {
        // UNKNOWN, not clean. A cross-check that could not run must never render as "checked, nothing found".
        launchVerification = {
          launchVerificationFalseNegative: null,
          note: `launch-verification cross-check unavailable (${e instanceof Error ? e.message : String(e)}); the failed[] list is UNVERIFIED.`,
        };
      }
    }

    return {
      data: {
      ok: true,
      slug: fleet.fleetSlug,
      title: fleet.title,
      description: fleet.description,
      leader: leaderLiveness,
      leaderId: fleet.leaderOwnerId,
      leaderLive: leaderLiveness?.sessionState === 'live',
      leaderSessionState,
      leaderVacant,
      // P-009 (H4): the typed control state — 'winding-down' means members must
      // checkpoint + release and pull no new work until fleet:resume.
      controlState: fleet.controlState,
      launchTransaction: fleet.lastLaunchTransaction,
      ...launchVerification,
      ...(fleet.controlState !== 'active'
        ? { controlReason: fleet.controlReason, controlBy: fleet.controlBy, controlAt: fleet.controlAt }
        : {}),
      memberCount,
      beeCount,
      runningBees,
      members: roster.map((m) => ({
        agentId: m.agentId,
        label: m.ownerLabel ?? m.label,
        fleetRole: m.fleetRole,
        intent: m.intent,
        // P-008 (presence-derivation-unification-2026-07-17): the ambiguous
        // `alive` boolean is RETIRED from this payload. `sessionState` is the
        // verdict (live | parked | draining | suspect | ended | recorded);
        // `heartbeatFresh` is the RAW keepalive-freshness signal under its
        // honest name (a warm-dead session reads heartbeatFresh:true +
        // sessionState:'ended'). Read sessionState for "is X working".
        heartbeatFresh: m.heartbeatFresh ?? m.alive,
        sessionState: m.sessionState,
        lastActiveSecAgo: m.lastActiveSecAgo,
        doing: m.doing,
        load: m.load,
        // P-006: only on the dead — what a leader needs to decide whether (and how) to
        // bring this one back. `resumable:true` ⇒ `capability:launch-agent { resume:
        // { agentId }, fleet, brief }` restores it mid-thread with its context intact.
        ...(['ended', 'suspect'].includes(m.sessionState ?? '')
          ? (() => {
              const r = resumableByOwner.get(m.agentId);
              // P-015: `endedAt` is only an observation when the session reported its OWN
              // exit. Otherwise a sweeper stamped now() on noticing a process that was
              // already gone, and a leader reading these as death times sees an artificial
              // cluster — the WI-7126 misdiagnosis. Say so inline, on the row.
              const endedAtIsNotice = r != null && r.endedAt != null && r.endedBy !== 'self';
              return {
                endedAt: r?.endedAt ?? null,
                endedBy: r?.endedBy ?? null,
                ...(endedAtIsNotice
                  ? {
                      endedAtIsNoticeTime: true,
                      endedAtCaveat: `endedAt here is when ${r.endedBy ?? 'an unrecorded writer'} NOTICED this session was gone, not when it ended — the true end time is unknown. Read coord_presence.last_active_at for this owner instead. Do not read a cluster of these as a simultaneous event (WI-7126).`,
                    }
                  : {}),
                resumable: !!r?.sessionId,
                resumableSessionId: r?.sessionId ?? null,
                ...(r?.sessionId
                  ? {}
                  : {
                      resumeHint:
                        'no native session id recorded (an omp thread, or a row predating native-id tracking) — launch this lane fresh instead',
                    }),
              };
            })()
          : {}),
      })),
      ...(completionStats ? { completionStats } : {}),
      // WI-3818: present ONLY when something degraded — a healthy call's shape
      // stays byte-identical to pre-WI-3818 behavior. `degraded:true` means the
      // roster/counts above may be incomplete (a slow leg fell back rather than
      // hanging); `degradedLegs` names exactly which ones.
      ...(degradedLegs.length > 0 ? { degraded: true, degradedLegs } : {}),
      },
    };
  },
});
