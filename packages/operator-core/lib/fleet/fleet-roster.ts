/**
 * fleet-roster — the named-fleet analog of hive-roster (named-su-agent-fleets-2026-06-29
 * P-005). ONE unified per-agent live-state surface for a named fleet, cloned from
 * fleet/hive-roster.ts but keyed on the SOFT presence label `fleet_slug` (mig 407)
 * instead of `hive_slug`. Same composition: presence (identity + the mig-277 scalars +
 * Tier-1) folded with the fleet:assignments work-detail ({doing,queued,load,orphaned,…}).
 *
 * The one structural difference from hive-roster: `hive_slug` rides the PresenceRecord
 * the @papercusp/coordination store reads, but `fleet_slug` does NOT (the store SELECT is
 * unchanged) — so the default presence read joins it in per-owner via fetchPresenceFleet
 * before folding (the `readPresence` DI seam lets a caller inject an already-enriched
 * source). The pure halves (filterPresenceToFleet / foldFleetRoster) unit-test without PG.
 *
 * `availableFleets` is the registry-side read: every PERSISTED fleet (agent_fleets,
 * which survives all-members-killed — D-003) annotated with its LIVE member count
 * (presence rows carrying that fleet_slug with a heartbeat within PRESENCE_STALE_MS).
 * "Available = >=1 live member" (D-003) is the predicate routing + psu apply on top.
 */
import { listPresence, PRESENCE_STALE_MS } from '../agent-tools/coordination/presence';
import { fetchPresenceFleet } from '../agent-tools/coordination/presence-fleet';
import {
  computeLastActiveSecAgo,
  fetchPresenceTier1,
  type PresenceTier1Joins,
} from '../agent-tools/coordination/presence-tier1';
import {
  fetchWakeability,
  deriveSessionState,
  isHardStale,
  type SessionState,
  type WakeabilitySignals,
} from '../agent-tools/coordination/presence-wakeability';
import { listFleetAssignments, groupByAgent, type AgentAssignment } from './assignments';
import { listFleets, type AgentFleetRecord } from '../agent-fleets-store';
import { getOrgPg } from '@papercusp/db-org';
import { withBoundedTimeout } from '../bounded-timeout';

/**
 * WI-3818: per-sub-read budget for listFleetRoster's fan-out (presence, then
 * Tier-1/assignments/wakeability in parallel). During the 2026-07-10 host-load
 * storm any one of these hanging blocked the WHOLE roster read until the 55s
 * MCP client timeout — the caller got nothing instead of a slim-but-usable
 * partial roster. Each leg now degrades to an empty fallback at this budget
 * instead of hanging; a degraded leg means that leg's detail is simply
 * missing from the fold (e.g. a timed-out `listFleetAssignments` yields
 * presence-only entries with `doing:null`/`queued:[]`/`load:0` — the "drop
 * queued detail first" fallback happens naturally at this level).
 */
export const FLEET_ROSTER_SUBREAD_TIMEOUT_MS = 8_000;

/** The presence fields the fold needs, plus the joined-in fleet label. Kept structural
 *  so foldFleetRoster unit-tests without importing the store types. */
export interface FleetFoldPresence {
  ownerId: string;
  ownerLabel: string | null;
  source: string | null;
  intent: string;
  currentPlanSlug: string | null;
  host: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  lastActiveAt: string | null;
  agentRole: string | null;
  /** The SOFT named-fleet membership label (joined in per-owner — does NOT ride the
   *  base PresenceRecord like hive_slug). */
  fleetSlug: string | null;
  fleetRole: string | null;
  userId: string | null;
  stale: boolean;
  federated?: boolean;
}

/** One agent's unified live-state: the fleet work-detail (AgentAssignment,
 *  shape-preserved) + presence identity + the mig-277 scalars + Tier-1 + fleet label. */
export interface FleetRosterEntry extends AgentAssignment {
  ownerLabel: string | null;
  source: string | null;
  host: string | null;
  startedAt: string | null;
  lastActiveAt: string | null;
  agentRole: string | null;
  fleetSlug: string | null;
  fleetRole: string | null;
  userId: string | null;
  federated: boolean;
  /** EI-5858: the coordinator-facing session state (live | parked | ended | recorded),
   *  derived from wakeability the SAME way coord:presence does — so fleet:status no
   *  longer masks an `ended` (dead) session behind a still-warm heartbeat. null for a
   *  federated peer / when the wakeability read is unavailable (state unknown). */
  sessionState: SessionState | null;
  // ── Tier-1 (P-003) — populated for local agents; null/empty for federated peers
  lastActiveSecAgo: number | null;
  claimedItems: string[];
  model: string | null;
  awaitingEvent: boolean;
  awaitingEventKey: string | null;
  awaitingNote: string | null;
  wakeMode: string | null;
}

const EMPTY_TIER1: PresenceTier1Joins = {
  claimedItems: [],
  model: null,
  awaitingEvent: false,
  awaitingEventKey: null,
  awaitingNote: null,
  wakeMode: 'auto',
};

/** Synthesize a work-detail-empty AgentAssignment for a presence-only agent
 *  (idle, or a federated peer with no local claims). */
function assignmentFromPresence(p: FleetFoldPresence): AgentAssignment {
  return {
    agentId: p.ownerId,
    label: p.ownerLabel,
    name: null,
    present: true,
    alive: !p.stale,
    heartbeatAt: p.heartbeatAt,
    intent: p.intent,
    declaredPlanSlug: p.currentPlanSlug,
    fleetSlug: p.fleetSlug,
    fleetRole: p.fleetRole,
    claims: [],
    orphaned: false,
    stalled: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
  };
}

/** Pure: scope a presence list to one named fleet, keyed on the fleet_slug label.
 *  By default a fleet roster is EXACTLY its labeled members; `includeUnattributed`
 *  (off by default — unlike hive-roster, where SU/standalone rows share the workspace)
 *  also pulls in rows with NULL fleet_slug. */
export function filterPresenceToFleet(
  presence: FleetFoldPresence[],
  fleetSlug: string,
  includeUnattributed: boolean,
): FleetFoldPresence[] {
  return presence.filter((p) => p.fleetSlug === fleetSlug || (includeUnattributed && p.fleetSlug == null));
}

/**
 * PURE fold: one entry per agent across the UNION of presence + assignments, keyed by
 * ownerId. Keeps the fleet work-detail unchanged (shape-preserved for the survey +
 * dashboard) and attaches presence identity + mig-277 scalars + the fleet label +
 * Tier-1. Sort: live first, then orphan-holders, then newest heartbeat.
 */
export function foldFleetRoster(
  presence: FleetFoldPresence[],
  assignments: AgentAssignment[],
  tier1: Map<string, PresenceTier1Joins>,
  nowMs: number,
  wakeability: Map<string, WakeabilitySignals> = new Map(),
): FleetRosterEntry[] {
  const presById = new Map(presence.map((p) => [p.ownerId, p]));
  const asgById = new Map(assignments.map((a) => [a.agentId, a]));
  const ids = new Set<string>([...presById.keys(), ...asgById.keys()]);
  const out: FleetRosterEntry[] = [];
  for (const id of ids) {
    const p = presById.get(id) ?? null;
    const base = asgById.get(id) ?? (p ? assignmentFromPresence(p) : null);
    if (!base) continue;
    // EI-5858: derive the coordinator-facing sessionState from wakeability the SAME
    // way coord:presence does, and GATE `alive` on it. `fleet:status.alive` used to
    // be pure heartbeat-freshness, so a cleanly-`ended` session read `alive:true` for
    // the ~10-min stale window (a leader treated 6 dead agents as working). A row with
    // no wakeability entry (a federated peer, or the read unavailable) keeps its
    // heartbeat-derived `alive` and a null sessionState (state unknown).
    const w = wakeability.get(id);
    const stale = p ? p.stale : !base.alive;
    // fleet-liveness-zombie-await-2026-07-07: a reboot-killed member leaves an
    // un-cancelled wake-await, so `wakeable` alone would pin it to `parked`
    // (counted a live member) forever. Feed the DEAD-ceiling check so an
    // hour-cold heartbeat is authoritatively `ended` regardless of that zombie await.
    const hbMs = (p?.heartbeatAt ?? base.heartbeatAt) ? Date.parse((p?.heartbeatAt ?? base.heartbeatAt)!) : null;
    const sessionState: SessionState | null = w
      ? deriveSessionState({ stale, wakeable: w.wakeable, liveTurn: w.liveTurn, hardStale: isHardStale(hbMs, nowMs) })
      : null;
    const alive = sessionState === 'ended' ? false : base.alive;
    out.push({
      ...base,
      alive,
      sessionState,
      ownerLabel: p?.ownerLabel ?? base.label,
      source: p?.source ?? null,
      host: p?.host ?? null,
      startedAt: p?.startedAt ?? null,
      lastActiveAt: p?.lastActiveAt ?? null,
      agentRole: p?.agentRole ?? null,
      fleetSlug: p?.fleetSlug ?? base.fleetSlug ?? null,
      fleetRole: p?.fleetRole ?? base.fleetRole ?? null,
      userId: p?.userId ?? null,
      federated: Boolean(p?.federated),
      lastActiveSecAgo: computeLastActiveSecAgo(p?.lastActiveAt ?? null, nowMs),
      ...EMPTY_TIER1,
      ...(tier1.get(id) ?? {}),
    });
  }
  return out.sort(
    (a, b) =>
      Number(b.alive) - Number(a.alive) ||
      Number(b.orphaned) - Number(a.orphaned) ||
      (b.heartbeatAt ?? '').localeCompare(a.heartbeatAt ?? ''),
  );
}

export interface ListFleetRosterOpts {
  fleetSlug: string;
  workspaceId?: string | null;
  /** Also include local agents with NULL fleet_slug (no fleet) sharing the workspace.
   *  Default FALSE — a fleet roster is exactly its labeled members. */
  includeUnattributed?: boolean;
  /** DI seam: the presence source (already enriched with the fleet label). Defaults to
   *  listPresence + fetchPresenceFleet (LOCAL rows). */
  readPresence?: (opts: { workspaceId?: string | null }) => Promise<FleetFoldPresence[]>;
}

/** Default presence source: list local presence and join in the fleet_slug/fleet_role
 *  label (it does not ride the PresenceRecord). */
async function defaultReadFleetPresence(opts: { workspaceId?: string | null }): Promise<FleetFoldPresence[]> {
  const records = await listPresence(opts);
  const fleetMap = await fetchPresenceFleet(records.map((r) => r.ownerId));
  return records.map((r) => {
    const f = fleetMap.get(r.ownerId);
    return {
      ownerId: r.ownerId,
      ownerLabel: r.ownerLabel,
      source: r.source,
      intent: r.intent,
      currentPlanSlug: r.currentPlanSlug,
      host: r.host,
      startedAt: r.startedAt,
      heartbeatAt: r.heartbeatAt,
      lastActiveAt: r.lastActiveAt,
      agentRole: r.agentRole,
      fleetSlug: f?.fleetSlug ?? null,
      fleetRole: f?.fleetRole ?? null,
      userId: r.userId,
      stale: r.stale,
    };
  });
}

/** Which fan-out legs of a `listFleetRoster` read were degraded (timed out or
 *  errored) and fell back to an empty/default value — WI-3818 observability,
 *  so a caller can tell "this roster may be incomplete" instead of silently
 *  trusting a possibly-partial fold. Empty array ⇒ every leg answered fully. */
export type FleetRosterDegradedLeg = 'presence' | 'tier1' | 'assignments' | 'wakeability';

export interface ListFleetRosterResult {
  entries: FleetRosterEntry[];
  degradedLegs: FleetRosterDegradedLeg[];
}

/**
 * The unified fleet-roster read, WITH per-leg timeout diagnostics (WI-3818).
 * Fleet-scopes presence (on the fleet_slug label), enriches with Tier-1, joins
 * the fleet work-detail, and folds — one read for "who's in this fleet and
 * exactly what each is doing". Each sub-read is bounded at
 * FLEET_ROSTER_SUBREAD_TIMEOUT_MS: a slow/hanging leg degrades to an empty
 * fallback (reported in `degradedLegs`) instead of hanging the whole read —
 * so under host load this resolves with a slim-but-usable partial roster
 * well inside the 55s MCP client timeout, rather than nothing at all.
 */
export async function listFleetRosterDiagnosed(opts: ListFleetRosterOpts): Promise<ListFleetRosterResult> {
  const { fleetSlug, workspaceId } = opts;
  const includeUnattributed = opts.includeUnattributed === true;
  const readPresence = opts.readPresence ?? defaultReadFleetPresence;
  const degradedLegs: FleetRosterDegradedLeg[] = [];

  const presenceResult = await withBoundedTimeout(readPresence({ workspaceId }), {
    fallback: [] as FleetFoldPresence[],
    timeoutMs: FLEET_ROSTER_SUBREAD_TIMEOUT_MS,
    label: 'fleet-roster:presence',
  });
  if (presenceResult.degraded) degradedLegs.push('presence');
  const presenceAll = presenceResult.value;
  const presence = filterPresenceToFleet(presenceAll, fleetSlug, includeUnattributed);
  const inFleet = new Set(presence.map((p) => p.ownerId));
  const localIds = presence.filter((p) => !p.federated).map((p) => p.ownerId);

  const [tier1Result, rowsResult, wakeabilityResult] = await Promise.all([
    withBoundedTimeout(fetchPresenceTier1(localIds), {
      fallback: new Map<string, PresenceTier1Joins>(),
      timeoutMs: FLEET_ROSTER_SUBREAD_TIMEOUT_MS,
      label: 'fleet-roster:tier1',
    }),
    withBoundedTimeout(listFleetAssignments({ workspaceId }), {
      fallback: [],
      timeoutMs: FLEET_ROSTER_SUBREAD_TIMEOUT_MS,
      label: 'fleet-roster:assignments',
    }),
    // EI-5858: wakeability drives the `ended` gate on `alive` + surfaces
    // sessionState. Best-effort — a slow/failed query degrades to
    // heartbeat-only `alive` (today's pre-WI-3818 behavior), never breaks the
    // roster read.
    withBoundedTimeout(fetchWakeability(localIds), {
      fallback: new Map<string, WakeabilitySignals>(),
      timeoutMs: FLEET_ROSTER_SUBREAD_TIMEOUT_MS,
      label: 'fleet-roster:wakeability',
    }),
  ]);
  if (tier1Result.degraded) degradedLegs.push('tier1');
  if (rowsResult.degraded) degradedLegs.push('assignments');
  if (wakeabilityResult.degraded) degradedLegs.push('wakeability');

  // A degraded `assignments` leg naturally drops the heaviest per-member detail
  // first (WI-3818's "drop queued detail first" fallback): foldFleetRoster
  // synthesizes a work-detail-empty AgentAssignment from presence alone
  // (assignmentFromPresence) when no assignment row is found — so entries
  // still exist with identity/intent/liveness, just without doing/queued/load.
  const assignments = groupByAgent(rowsResult.value).filter((a) => inFleet.has(a.agentId));
  const entries = foldFleetRoster(presence, assignments, tier1Result.value, Date.now(), wakeabilityResult.value);
  return { entries, degradedLegs };
}

/**
 * The unified fleet-roster read. Fleet-scopes presence (on the fleet_slug label),
 * enriches with Tier-1, joins the fleet work-detail, and folds — one read for "who's in
 * this fleet and exactly what each is doing". Back-compat wrapper over
 * `listFleetRosterDiagnosed` for callers that don't need the degraded-legs
 * diagnostics (WI-3818) — same bounded-fan-out behavior either way.
 */
export async function listFleetRoster(opts: ListFleetRosterOpts): Promise<FleetRosterEntry[]> {
  return (await listFleetRosterDiagnosed(opts)).entries;
}

/**
 * Live fleet-presence counts, SPLIT by substrate (WI-1764 #4). A named fleet's live
 * presence rows are two very different things and conflating them into one
 * `liveMemberCount` hid the origin incident (a fleet showed 0 members while 3
 * autonomous-loop bees ran — "correct but ignorable"):
 *   • members — VISIBLE desktop su agents (fleet:launch-on-plan / capability:terminal),
 *     the ones a plan is handed to. agent_role != 'bee'.
 *   • bees — BACKGROUND queen↔bee autonomous-loop workers (cup:spawn) that joined
 *     this fleet's presence label. agent_role = 'bee'.
 */
export interface FleetLiveCounts {
  /** Live VISIBLE desktop su MEMBERS (fresh presence, agent_role != 'bee'). */
  members: number;
  /** Live BACKGROUND autonomous-loop BEES attributed to this fleet. Source depends on the
   *  caller: the presence-label split (liveFleetAgentCounts / splitFleetRosterCounts) or,
   *  preferred, the nursery fleet_slug (liveFleetBeeCountsFromNursery — WI-1813, reliable
   *  + presence-independent). */
  bees: number;
}

const EMPTY_FLEET_COUNTS: FleetLiveCounts = { members: 0, bees: 0 };

/** A persisted fleet annotated with its live member/bee counts (the "available" signal). */
export interface AvailableFleet extends AgentFleetRecord {
  /** VISIBLE desktop su members: presence rows carrying this fleet_slug (heartbeat within
   *  PRESENCE_STALE_MS), agent_role != 'bee'. >=1 ⇒ the fleet is AVAILABLE for routing
   *  (D-003) — a live desktop DRIVER a plan can be handed to (a bee cannot). */
  liveMemberCount: number;
  /** BACKGROUND autonomous-loop bees spawned INTO this fleet — counted from the nursery
   *  fleet_slug (WI-1813, running/restarting, child_role='bee'), reliable + presence-
   *  independent. A fleet with 0 members but a nonzero beeCount is the WI-1764 substrate
   *  mismatch — bees were spawned where visible desktop members were meant. */
  beeCount: number;
}

/** Pure: annotate each persisted fleet with its live member/bee counts (0 when none). */
export function annotateFleetsWithCounts(
  fleets: AgentFleetRecord[],
  counts: Map<string, FleetLiveCounts>,
): AvailableFleet[] {
  return fleets.map((f) => {
    const c = counts.get(f.fleetSlug) ?? EMPTY_FLEET_COUNTS;
    return { ...f, liveMemberCount: c.members, beeCount: c.bees };
  });
}

/** Pure: is this coord_presence agent_role a background nursery BEE (vs a visible
 *  desktop su member)? deriveAgentRole maps fleet-spawn/signed-spawn sources → 'bee';
 *  visible su desktop sessions → 'su'/'human'. WI-1764 #4. */
export function isBeeRole(agentRole: string | null | undefined): boolean {
  return agentRole === 'cup';
}

/** Pure: split a set of live fleet-roster entries into member vs bee counts by
 *  agent_role (WI-1764 #4). Unit-testable without PG — the fleet:status analog of the
 *  liveFleetAgentCounts SQL split. */
export function splitFleetRosterCounts(entries: Array<{ agentRole: string | null }>): FleetLiveCounts {
  let members = 0;
  let bees = 0;
  for (const e of entries) {
    if (isBeeRole(e.agentRole)) bees += 1;
    else members += 1;
  }
  return { members, bees };
}

/** IO seam: live member/bee counts per fleet_slug — presence rows with a fresh heartbeat
 *  (within PRESENCE_STALE_MS) carrying a fleet_slug, grouped by fleet AND split by
 *  substrate (WI-1764 #4: members = agent_role != 'bee'; bees = agent_role = 'bee'). */
async function liveFleetAgentCounts(workspaceId: string): Promise<Map<string, FleetLiveCounts>> {
  const { sql } = getOrgPg();
  const secs = Math.max(1, Math.floor(PRESENCE_STALE_MS / 1000));
  const rows = await sql<{ fleet_slug: string; members: number; bees: number }[]>`
    SELECT fleet_slug,
           count(*) FILTER (WHERE agent_role IS DISTINCT FROM 'cup')::int AS members,
           count(*) FILTER (WHERE agent_role = 'cup')::int AS bees
      FROM harness_shared.coord_presence
     WHERE workspace_id = ${workspaceId}
       AND fleet_slug IS NOT NULL
       AND heartbeat_at > now() - ${`${secs} seconds`}::interval
     GROUP BY fleet_slug
  `;
  return new Map(rows.map((r) => [r.fleet_slug, { members: Number(r.members), bees: Number(r.bees) }]));
}

/**
 * IO seam: how many BACKGROUND autonomous-loop bees are running in this workspace right
 * now (running/restarting nursery rows, child_role = 'bee'). WI-1764 #4: surfaced on the
 * fleet reads so the origin mismatch SCREAMS — a fleet showing 0 members while N bees run
 * in the workspace is the tell that cup:spawn was used where fleet:launch-on-plan was
 * meant. Deliberately WORKSPACE-wide (not per-fleet): it counts EVERY running bee,
 * including ungrouped ones and pre-mig-475 rows carrying no fleet_slug — the
 * belt-and-suspenders total that the per-fleet counts (countRunningFleetBees, WI-1813)
 * can miss. */
export async function countRunningWorkspaceBees(workspaceId: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND child_role = 'cup'
       AND status IN ('running', 'restarting')
  `;
  return Number(rows[0]?.n ?? 0);
}

/**
 * IO seam: how many BACKGROUND bees spawned INTO one named fleet are running right now
 * (running/restarting nursery rows, child_role = 'bee', fleet_slug = this fleet). WI-1813
 * (WI-1764 #4 follow-up): the RELIABLE per-fleet bee count. Every bee gets its fleet_slug
 * stamped on the nursery row at spawn (operator-spawn.ts, mig 475), so this is
 * presence-INDEPENDENT — unlike the old presence-label count it does not require the bee
 * to boot far enough to write a presence row. The authoritative source for
 * fleet:status.beeCount. Uses the spawned_agents_fleet_slug_running_idx partial index. */
export async function countRunningFleetBees(fleetSlug: string, workspaceId: string): Promise<number> {
  const { sql } = getOrgPg();
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND fleet_slug = ${fleetSlug}
       AND child_role = 'cup'
       AND status IN ('running', 'restarting')
  `;
  return Number(rows[0]?.n ?? 0);
}

/**
 * IO seam: running background-bee counts grouped BY named fleet (running/restarting,
 * child_role = 'bee', fleet_slug not null) — one GROUP BY over the nursery. WI-1813: the
 * per-fleet-map analog of countRunningFleetBees, feeding fleet:list's per-fleet beeCount
 * (members still come from presence — a member is a live desktop session, a bee is a
 * nursery row). Presence-independent + one query for all fleets. */
export async function liveFleetBeeCountsFromNursery(workspaceId: string): Promise<Map<string, number>> {
  const { sql } = getOrgPg();
  const rows = await sql<{ fleet_slug: string; n: number }[]>`
    SELECT fleet_slug, count(*)::int AS n
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND fleet_slug IS NOT NULL
       AND child_role = 'cup'
       AND status IN ('running', 'restarting')
     GROUP BY fleet_slug
  `;
  return new Map(rows.map((r) => [r.fleet_slug, Number(r.n)]));
}

/**
 * IO seam: the LIVE members of ONE named fleet → their coord owner-ids. The
 * id-only, single-fleet analog of liveFleetAgentCounts: presence rows carrying
 * `fleetSlug` with a fresh heartbeat (within PRESENCE_STALE_MS), scoped to the
 * workspace (fleet_slug is unique only per-workspace — mig 406). This is what the
 * coord audience resolver calls to expand `@fleet:<slug>` to its currently-live
 * recipients, with no roster enrichment (cheap enough for the per-send path).
 */
export async function liveFleetMemberIds(fleetSlug: string, workspaceId: string): Promise<string[]> {
  const { sql } = getOrgPg();
  const secs = Math.max(1, Math.floor(PRESENCE_STALE_MS / 1000));
  const rows = await sql<{ owner_id: string }[]>`
    SELECT owner_id
      FROM harness_shared.coord_presence
     WHERE workspace_id = ${workspaceId}
       AND fleet_slug = ${fleetSlug}
       AND heartbeat_at > now() - ${`${secs} seconds`}::interval
  `;
  return rows.map((r) => r.owner_id);
}

/**
 * Every persisted fleet in the workspace, annotated with its live-member count. The
 * registry rows persist with zero live members (D-003), so the caller decides what
 * "available" means — the standard predicate is `liveMemberCount > 0` (routing option 2
 * + the psu "pick existing" list).
 */
export async function availableFleets(workspaceId: string): Promise<AvailableFleet[]> {
  const [fleets, presenceCounts, nurseryBeeCounts] = await Promise.all([
    listFleets(workspaceId),
    liveFleetAgentCounts(workspaceId),
    liveFleetBeeCountsFromNursery(workspaceId),
  ]);
  // WI-1813: members from PRESENCE (a member is a live VISIBLE desktop su session); bees
  // from the NURSERY (the reliable, presence-independent count of bees spawned into the
  // fleet — see countRunningFleetBees). A member and a bee are fundamentally different
  // substrates, so each is counted from its authoritative source.
  const counts = new Map<string, FleetLiveCounts>();
  for (const f of fleets) {
    counts.set(f.fleetSlug, {
      members: presenceCounts.get(f.fleetSlug)?.members ?? 0,
      bees: nurseryBeeCounts.get(f.fleetSlug) ?? 0,
    });
  }
  return annotateFleetsWithCounts(fleets, counts);
}
