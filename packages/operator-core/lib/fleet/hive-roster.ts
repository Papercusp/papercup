/**
 * hive-roster — presence-v2 Phase 3 fold (presence-v2-2026-06-14 P-006/P-015):
 * ONE unified per-agent live-state surface for a Hive. Folds the coord:presence
 * read (identity + the mig-277 last_active_at/agent_role/hive_slug scalars +
 * the P-003 Tier-1 enrichment) together with the fleet:assignments work-detail
 * ({doing,queued,load,orphaned,claims,declaredUnclaimed}). Fold, don't duplicate:
 * fleet_assignment is already a projection-shaped view — this COMPOSES it with
 * presence rather than re-deriving either.
 *
 * MUST preserve the {doing,queued,load,orphaned} shape: the shipped Queen
 * placement survey (local-hive-orchestration P-030) + the B10 member dashboard
 * consume it (D-009#2 / P-015). It does — every HiveRosterEntry extends
 * AgentAssignment unchanged; presence/Tier-1 are additive fields.
 *
 * Composition only — NO edits to su-85dd2's in-flight coord:presence read
 * (P-003): this imports the EXPORTED reads (listPresence + the pure
 * fetchPresenceTier1/computeLastActiveSecAgo) and folds their output. The pure
 * halves (filterPresenceToHive / foldHiveRoster) unit-test without PG;
 * listHiveRoster is the thin IO wrapper, with a DI seam (readPresence) so
 * su-85dd2's Phase-2 hive-scoped read (incl. federated peers, P-004) drops in.
 */
import { listPresence } from '../agent-tools/coordination/presence';
import {
  computeLastActiveSecAgo,
  fetchPresenceTier1,
  type PresenceTier1Joins,
} from '../agent-tools/coordination/presence-tier1';
import { listFleetAssignments, groupByAgent, type AgentAssignment } from './assignments';

/** The presence fields the fold needs — structurally a `PresenceRecord` (local)
 *  or `UnifiedPresenceRecord` (federated). Kept structural so foldHiveRoster
 *  unit-tests without importing the store types. */
export interface FoldPresence {
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
  hiveSlug: string | null;
  userId: string | null;
  stale: boolean;
  federated?: boolean;
}

/** One agent's unified live-state: the fleet work-detail (AgentAssignment,
 *  shape-preserved) + presence identity + the mig-277 scalars + Tier-1. */
export interface HiveRosterEntry extends AgentAssignment {
  ownerLabel: string | null;
  source: string | null;
  host: string | null;
  startedAt: string | null;
  lastActiveAt: string | null;
  agentRole: string | null;
  hiveSlug: string | null;
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
function assignmentFromPresence(p: FoldPresence): AgentAssignment {
  return {
    agentId: p.ownerId,
    label: p.ownerLabel,
    name: null,
    present: true,
    alive: !p.stale,
    heartbeatAt: p.heartbeatAt,
    intent: p.intent,
    declaredPlanSlug: p.currentPlanSlug,
    claims: [],
    orphaned: false,
    declaredUnclaimed: false,
    doing: null,
    queued: [],
    load: 0,
  };
}

/** Pure: scope a presence list to one Hive. Local rows carry hive_slug (mig 277);
 *  rows with NULL hive_slug (SU / standalone) are included when
 *  `includeUnattributed` (they share the workspace but no Hive home). Federated
 *  peers are kept when their hive_slug matches (already hive-keyed) or unset. */
export function filterPresenceToHive(
  presence: FoldPresence[],
  hiveSlug: string,
  includeUnattributed: boolean,
): FoldPresence[] {
  return presence.filter(
    (p) => p.hiveSlug === hiveSlug || (includeUnattributed && p.hiveSlug == null),
  );
}

/**
 * PURE fold: one entry per agent across the UNION of presence + assignments,
 * keyed by ownerId. Keeps the fleet work-detail unchanged (shape-preserved for
 * the Queen survey + dashboard) and attaches presence identity + mig-277 scalars
 * + Tier-1. Sort: live first, then orphan-holders, then newest heartbeat.
 */
export function foldHiveRoster(
  presence: FoldPresence[],
  assignments: AgentAssignment[],
  tier1: Map<string, PresenceTier1Joins>,
  nowMs: number,
): HiveRosterEntry[] {
  const presById = new Map(presence.map((p) => [p.ownerId, p]));
  const asgById = new Map(assignments.map((a) => [a.agentId, a]));
  const ids = new Set<string>([...presById.keys(), ...asgById.keys()]);
  const out: HiveRosterEntry[] = [];
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
      hiveSlug: p?.hiveSlug ?? null,
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

/** A lean per-agent snapshot line — the dossier / volatile-tail shape
 *  (directed-wake-honesty-and-spawn-handoff P-021 seam: su-7b271's
 *  assembleSpawnHydration consumes this per-spawn). Drops the heavy arrays
 *  (queued / claims / full work items) for a one-line-per-agent glance, keeping
 *  the coordination-relevant scalars. Pure + bounded by hive size (D-002), so it
 *  is cheap to render on the volatile tail. */
export interface RosterSnapshotLine {
  ownerId: string;
  label: string | null;
  agentRole: string | null;
  alive: boolean;
  /** Seconds since GENUINE activity (last_active_at, D-003) — NOT keepalive heartbeat. */
  lastActiveSecAgo: number | null;
  /** Head-of-line work-item id (doing.id), or null when idle. */
  doing: string | null;
  load: number;
  claimedItems: string[];
  awaitingEvent: boolean;
  federated: boolean;
}

/** Pure: project the full hive roster down to the lean dossier snapshot lines. */
export function toRosterSnapshot(entries: HiveRosterEntry[]): RosterSnapshotLine[] {
  return entries.map((e) => ({
    ownerId: e.agentId,
    label: e.ownerLabel ?? e.label,
    agentRole: e.agentRole,
    alive: e.alive,
    lastActiveSecAgo: e.lastActiveSecAgo,
    doing: e.doing?.id ?? null,
    load: e.load,
    claimedItems: e.claimedItems,
    awaitingEvent: e.awaitingEvent,
    federated: e.federated,
  }));
}

export interface ListHiveRosterOpts {
  hiveSlug: string;
  workspaceId?: string | null;
  /** Include local agents with NULL hive_slug (SU / standalone) sharing the
   *  workspace. Default true. */
  includeUnattributed?: boolean;
  /** DI seam: the presence source. Defaults to listPresence (LOCAL rows). When
   *  su-85dd2's Phase-2 hive-scoped read (incl. federated peers, P-004) lands,
   *  inject it here so the fold spans the whole hive without a rewrite. */
  readPresence?: (opts: { workspaceId?: string | null }) => Promise<FoldPresence[]>;
}

/**
 * The unified hive-roster read (P-006). Hive-scopes presence, enriches with
 * Tier-1, joins the fleet work-detail, and folds — one read for "who's in this
 * hive and exactly what each is doing".
 */
export async function listHiveRoster(opts: ListHiveRosterOpts): Promise<HiveRosterEntry[]> {
  const { hiveSlug, workspaceId } = opts;
  const includeUnattributed = opts.includeUnattributed !== false;
  const readPresence = opts.readPresence ?? ((o) => listPresence(o));
  const presenceAll = await readPresence({ workspaceId });
  const presence = filterPresenceToHive(presenceAll, hiveSlug, includeUnattributed);
  const inHive = new Set(presence.map((p) => p.ownerId));
  const localIds = presence.filter((p) => !p.federated).map((p) => p.ownerId);
  const [tier1, rows] = await Promise.all([
    fetchPresenceTier1(localIds),
    listFleetAssignments({ workspaceId }),
  ]);
  const assignments = groupByAgent(rows).filter((a) => inHive.has(a.agentId));
  return foldHiveRoster(presence, assignments, tier1, Date.now());
}

/** Convenience: the lean dossier snapshot in one call (listHiveRoster +
 *  toRosterSnapshot) — the per-spawn roster-snapshot input for the directed-wake
 *  P-021 hydration seam. Hive-scoped, so bounded; ~6 small reads per call. */
export async function listHiveRosterSnapshot(opts: ListHiveRosterOpts): Promise<RosterSnapshotLine[]> {
  return toRosterSnapshot(await listHiveRoster(opts));
}
