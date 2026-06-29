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
import { listFleetAssignments, groupByAgent, type AgentAssignment } from './assignments';
import { listFleets, type AgentFleetRecord } from '../agent-fleets-store';
import { getOrgPg } from '@papercusp/db-org';

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
  return presence.filter(
    (p) => p.fleetSlug === fleetSlug || (includeUnattributed && p.fleetSlug == null),
  );
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
): FleetRosterEntry[] {
  const presById = new Map(presence.map((p) => [p.ownerId, p]));
  const asgById = new Map(assignments.map((a) => [a.agentId, a]));
  const ids = new Set<string>([...presById.keys(), ...asgById.keys()]);
  const out: FleetRosterEntry[] = [];
  for (const id of ids) {
    const p = presById.get(id) ?? null;
    const base = asgById.get(id) ?? (p ? assignmentFromPresence(p) : null);
    if (!base) continue;
    out.push({
      ...base,
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
async function defaultReadFleetPresence(opts: {
  workspaceId?: string | null;
}): Promise<FleetFoldPresence[]> {
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

/**
 * The unified fleet-roster read. Fleet-scopes presence (on the fleet_slug label),
 * enriches with Tier-1, joins the fleet work-detail, and folds — one read for "who's in
 * this fleet and exactly what each is doing".
 */
export async function listFleetRoster(opts: ListFleetRosterOpts): Promise<FleetRosterEntry[]> {
  const { fleetSlug, workspaceId } = opts;
  const includeUnattributed = opts.includeUnattributed === true;
  const readPresence = opts.readPresence ?? defaultReadFleetPresence;
  const presenceAll = await readPresence({ workspaceId });
  const presence = filterPresenceToFleet(presenceAll, fleetSlug, includeUnattributed);
  const inFleet = new Set(presence.map((p) => p.ownerId));
  const localIds = presence.filter((p) => !p.federated).map((p) => p.ownerId);
  const [tier1, rows] = await Promise.all([
    fetchPresenceTier1(localIds),
    listFleetAssignments({ workspaceId }),
  ]);
  const assignments = groupByAgent(rows).filter((a) => inFleet.has(a.agentId));
  return foldFleetRoster(presence, assignments, tier1, Date.now());
}

/** A persisted fleet annotated with its live-member count (the "available" signal). */
export interface AvailableFleet extends AgentFleetRecord {
  /** Presence rows carrying this fleet_slug whose heartbeat is within PRESENCE_STALE_MS.
   *  >=1 ⇒ the fleet is AVAILABLE for routing (D-003). */
  liveMemberCount: number;
}

/** Pure: annotate each persisted fleet with its live-member count (0 when none). */
export function annotateFleetsWithCounts(
  fleets: AgentFleetRecord[],
  counts: Map<string, number>,
): AvailableFleet[] {
  return fleets.map((f) => ({ ...f, liveMemberCount: counts.get(f.fleetSlug) ?? 0 }));
}

/** IO seam: live members per fleet_slug — presence rows with a fresh heartbeat
 *  (within PRESENCE_STALE_MS) carrying a fleet_slug, grouped by fleet. */
async function liveFleetMemberCounts(workspaceId: string): Promise<Map<string, number>> {
  const { sql } = getOrgPg();
  const secs = Math.max(1, Math.floor(PRESENCE_STALE_MS / 1000));
  const rows = await sql<{ fleet_slug: string; n: number }[]>`
    SELECT fleet_slug, count(*)::int AS n
      FROM harness_shared.coord_presence
     WHERE workspace_id = ${workspaceId}
       AND fleet_slug IS NOT NULL
       AND heartbeat_at > now() - ${`${secs} seconds`}::interval
     GROUP BY fleet_slug
  `;
  return new Map(rows.map((r) => [r.fleet_slug, Number(r.n)]));
}

/**
 * Every persisted fleet in the workspace, annotated with its live-member count. The
 * registry rows persist with zero live members (D-003), so the caller decides what
 * "available" means — the standard predicate is `liveMemberCount > 0` (routing option 2
 * + the psu "pick existing" list).
 */
export async function availableFleets(workspaceId: string): Promise<AvailableFleet[]> {
  const [fleets, counts] = await Promise.all([
    listFleets(workspaceId),
    liveFleetMemberCounts(workspaceId),
  ]);
  return annotateFleetsWithCounts(fleets, counts);
}
