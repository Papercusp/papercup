'use client';

/**
 * useAgentLeaderBrief — the lazy `agentLeaderBrief.byOwner` fetch
 * (popup-agent-state-coverage-2026-08-18 P-003).
 *
 * The audit behind that plan found that no UI anywhere reads
 * `fleet:leader-brief`. Opening a fleet LEADER's conversation popup showed the
 * generic board scoring every session gets — so six per-member signals whose
 * entire purpose is "intervene now" (`dormant`, `spinning`, `throttled`,
 * `coordHook`, `verifiedWaitTakeovers`, `benchSuggestion`) were on no screen,
 * and a member in any of those states rendered as an ordinary "working" row.
 *
 * This is the client half. It is a THIRD hook beside `useAgentDetail` and
 * `useAgentOrders` for the same reason those two are separate: the brief is an
 * expensive server-side fan-out, and folding it into `agentDetail.byOwner`
 * would make that cost unconditional on every popup open AND on every footer
 * summary-chip read. See `adv-agent-leader-brief.ts` for the server argument.
 *
 * ── Why the `enabled` gate is "is in a fleet", not "is the leader" ──────────
 * The obvious client gate is "only fetch when the roster says this agent leads
 * the fleet". It is wrong, and the server file says why: leadership is decided
 * from BOTH the fleet registry (`agent_fleets.leader_owner_id`) and presence
 * (`coord_presence.fleet_role`), and the two CAN disagree — that disagreement
 * IS the `presenceDrift` condition `coord:orient` warns a leader about. The
 * roster this popup already holds carries only the presence half. Gating on it
 * would blank the pane for exactly the agent whose own orient is telling it
 * that it leads, which is the case where a leader is flying blind.
 *
 * So the gate is the cheap, drift-free one — the viewed agent is in SOME fleet
 * and the rail that renders this is open — and the leadership decision stays
 * server-side where both sources are readable. A non-leader member costs two
 * cheap reads and comes back with a `skipped` verdict, no brief at all.
 *
 * ── Every field below is OPTIONAL on purpose ────────────────────────────────
 * This models the WIRE, not the current server. The SPA rebuilds on the vite
 * hot path while the sidecar only reloads on restart, so a fresh bundle is
 * routinely served payloads that predate a field it knows about. Declaring one
 * required is what let a `.length` typecheck and then throw at runtime, killing
 * a whole HUD tab (see the `unread` docblock in use-agent-detail.ts). Read
 * through `?.` / `?? []`, never bare.
 */

import { useSyncQuery } from '@papercusp/sync';

/**
 * Why no brief was computed. NEVER collapse these into a null brief: "this
 * agent leads nothing" and "we could not read the fleet" look identical on
 * screen unless the pane is told which it is, and the second one is the case
 * where a leader is flying blind and does not know it.
 */
export type LeaderBriefSkipReason = 'no-fleet' | 'not-leader' | 'no-workspace' | 'read-failed';

/** Mirrors `LifecycleBackoffInfo` — present ONLY while this member's engine loop
 *  is backed off from a provider wall. `nextFireAt` alone reads as a normal
 *  cadence tick, which is the whole reason this is a separate field. */
export interface LeaderBriefThrottled {
  /** The provider-kill classification, e.g. `usage_limit` / `rate_limited`. */
  reason?: string;
  /** ISO of the fire this backoff is waiting for; null when unscheduled. */
  until?: string | null;
  resumesInMs?: number | null;
}

/** Mirrors `CoordDeafState`. `'stale'` = has not read its coord mail for a whole
 *  budget window despite fresh activity; `'missing'` = no read on record at all.
 *  Either way a `coord:send` to this member will NOT be seen until it settles. */
export type LeaderBriefCoordDeaf = 'stale' | 'missing';

/** Mirrors `UnansweredDirectedEntry`. */
export interface LeaderBriefUnansweredEntry {
  msgId?: string;
  from?: string;
  summary?: string;
  ageMs?: number;
}

/** Mirrors `UnansweredDirectedSummary` — what this member was ASKED and has not
 *  answered. Distinct from `directives` below, which is what HAPPENED. */
export interface LeaderBriefUnanswered {
  count?: number;
  oldestAgeMs?: number;
  /** Newest-first, capped server-side even when `count` is larger. */
  newest?: LeaderBriefUnansweredEntry[];
}

/** Mirrors `DirectiveActuationSummary` — of YOUR directives to this member that
 *  named a required side effect, how many the LEDGER shows were carried out. */
export interface LeaderBriefDirectives {
  total?: number;
  satisfied?: number;
  notYet?: number;
  unprovable?: number;
  /** Newest-first lines for the not-yet ones only. */
  outstanding?: string[];
}

/** Mirrors `LeaderBriefMember['benchSuggestion']`.
 *  `idle-with-claimable` is the branch a leader must NOT act on by benching —
 *  it is a STARVATION symptom, not a member that should park. */
export interface LeaderBriefBenchSuggestion {
  kind?: 'stalled-no-mcp' | 'laneless-idle' | 'idle-with-claimable';
  reason?: string;
  item?: string | null;
  itemTitle?: string | null;
}

/** Mirrors the fields of `VerifiedWaitTakeoverAlert` this surface renders. */
export interface LeaderBriefTakeover {
  eventKey?: string;
  classification?: 'stalled' | 'absent';
  firedAt?: string;
  remedy?: string;
}

/**
 * One member row of the brief, trimmed to what the peers rail renders. The
 * server row (`LeaderBriefMember`) carries more; this mirror deliberately does
 * not chase every field, because a field this surface does not render is a
 * field that cannot go stale here.
 */
export interface LeaderBriefMemberRow {
  agentId: string;
  label?: string | null;
  fleetRole?: string | null;
  /** ZERO self-wake mechanism — no loop, no park, no claim. Nothing will bring
   *  it back; the leader must wake it explicitly. */
  dormant?: true;
  /** Alive and visibly taking turns, but its last PRODUCTIVE call is stale well
   *  past budget — every OTHER liveness surface reads this member as healthy. */
  spinning?: true;
  throttled?: LeaderBriefThrottled;
  coordHook?: LeaderBriefCoordDeaf;
  unanswered?: LeaderBriefUnanswered;
  directives?: LeaderBriefDirectives;
  benchSuggestion?: LeaderBriefBenchSuggestion;
  verifiedWaitTakeovers?: LeaderBriefTakeover[];
  /** ms since the last PRODUCTIVE (non-housekeeping) tool call; null = none on
   *  record. This is what makes `spinning`'s hover text quantitative. */
  productiveToolCallAgeMs?: number | null;
  lastToolCallAgeMs?: number | null;
  stalled?: boolean;
}

/** Mirrors the brief's `summary` block, trimmed to the fleet-level readings the
 *  rail renders (P-004). Counts are of MEMBERS, not of alerts. */
export interface LeaderBriefSummary {
  fleet?: string;
  members?: number;
  /** The five flat alert booleans. Each has a `*AlertReason` sibling on the
   *  brief root — the flag says IF, the reason says WHY, and neither is
   *  renderable without the other. */
  strandedFleetAlert?: boolean;
  specStarvedAlert?: boolean;
  specAuthorshipAlert?: boolean;
  idleWithClaimableAlert?: boolean;
  floorStarvedAlert?: boolean;
  /** Present ONLY when custom invariants are registered at all — its ABSENCE
   *  means "no checks registered", which is not the same as "checks passed". */
  customInvariantAlert?: boolean;
  /** This fleet's own control_state is winding down (fleet:pause/wind-down).
   *  It is the REASON the idle alerts read clean, so it must render beside
   *  them: idle members are COMPLYING, not failing. */
  fleet_paused?: boolean;
  unowned_criticals?: number;
  laneless_idle?: number;
  idle_with_claimable?: number;
  dormant?: number;
  spinning?: number;
  throttled?: number;
  coord_deaf?: number;
  /** null ⇒ could not be read on this brief — NOT zero, and never to be read as
   *  a drained lane. */
  claimable_now?: number | null;
  /** The live shared-inference-pool verdict. null means unread this call, never
   *  "healthy". */
  pool_capacity?: {
    poolExhausted?: boolean;
    degraded?: boolean;
    factor?: number;
    queueDepth?: number | null;
    usableAccounts?: number | null;
    availableAccounts?: number | null;
  } | null;
}

/** One registered custom invariant's evaluation. The contract is ROWS RETURNED
 *  == VIOLATED, and `status:'error'` is a check that could not run — which
 *  protects the leader from nothing and must never render as satisfied. */
export interface LeaderBriefCustomInvariant {
  key?: string;
  title?: string;
  status?: 'satisfied' | 'violated' | 'error';
  rowCount?: number;
  error?: string;
}

/**
 * The brief payload. `ok:false` is a real, renderable variant (the fleet could
 * not be resolved) — not an error to swallow.
 */
export interface LeaderBriefData {
  ok?: boolean;
  error?: string;
  hint?: string;
  summary?: LeaderBriefSummary;
  members?: LeaderBriefMemberRow[];
  /** Set when the verbose member rows were bounded for transport. */
  membersTruncated?: boolean;
  membersReturned?: number;
  /** The caller is acting on this fleet without holding its leadership — the
   *  drift the two-source leadership test above exists to surface. */
  notLeader?: unknown;
  strandedFleetAlertReason?: string;
  specStarvedAlertReason?: string;
  specAuthorshipAlertReason?: string;
  idleWithClaimableAlertReason?: string;
  floorStarvedAlertReason?: string;
  customInvariantAlertReason?: string;
  /** Always carried when ANY invariant is registered, INCLUDING the
   *  all-satisfied case — "my checks ran and found nothing" must be
   *  distinguishable from "my checks are not running". */
  customInvariants?: LeaderBriefCustomInvariant[];
  fleetPausedReason?: string;
}

export interface AgentLeaderBrief {
  ownerId: string;
  /** The fleet this agent's presence row places it in; null when it is in none. */
  fleetSlug: string | null;
  presenceFleetRole: string | null;
  /** The fleet registry's `leader_owner_id` — the authority on who leads. */
  registeredLeader: string | null;
  isLeader: boolean;
  /** Set iff `brief` is null. */
  skipped: LeaderBriefSkipReason | null;
  brief: LeaderBriefData | null;
}

/**
 * Lazy-load the leader-brief for one owner id through sync.
 *
 * `enabled` is the caller's gate — pass `false` while the rail is closed, so a
 * popup whose fleet pane is collapsed pays nothing at all. Any number of call
 * sites may invoke this for the SAME ownerId: `useSyncQuery` shares its cache
 * by `{queryName, args}`, so a second caller is a second READER, not a second
 * fetch.
 */
export function useAgentLeaderBrief(
  ownerId: string | null,
  enabled = true,
): {
  leaderBrief: AgentLeaderBrief | null;
  error: string | null;
  loading: boolean;
} {
  const query = useSyncQuery<AgentLeaderBrief>({
    queryName: 'agentLeaderBrief.byOwner',
    args: ownerId ? { ownerId } : undefined,
    enabled: !!ownerId && enabled,
  });
  return {
    leaderBrief: query.data?.[0] ?? null,
    error: query.error ? String(query.error) : null,
    loading: query.loading,
  };
}
