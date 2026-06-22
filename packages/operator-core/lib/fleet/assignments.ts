/**
 * fleet/assignments — the typed reader over `harness_shared.fleet_assignment`,
 * the canonical "who's on what" view (state-not-chat-fleet-state-2026-06-05,
 * D-002 / P-002).
 *
 * The view is CLAIM-PRIMARY: every claim row (plan-item lease, durable
 * assignment, work-item taken_by) carries its holder's presence LEFT-joined in,
 * so an orphaned claim — a live lease whose holder is absent/stale — survives
 * the read (a presence-primary join would silently drop it; that orphan is the
 * single most important signal). Presence rows ride along (source='presence')
 * as the by-agent backbone so idle agents answer "what is X doing" too.
 *
 * This module is the ONE place that reads the view: the `fleet:assignments`
 * tool and the /api/adv/roster enrichment both come through here. The PG I/O
 * is a thin `listFleetAssignments`; the grouping + smell selectors are pure so
 * they unit-test without PG.
 */
import { getOrgPg } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../workspace-id-constant';
import { isActivelyWorked, isReclaimable, type ItemActivity } from '../item-activity';

/** A presence row whose workspace is '*' belongs to every workspace's fleet. */
const GLOBAL_WORKSPACE = '*';

export type FleetAssignmentSource =
  | 'presence'
  | 'plan_item_claim'
  | 'plan_item_assignment'
  | 'work_item_claim';

/** One row of the view — one assignment/presence fact. */
export interface FleetAssignmentRow {
  source: FleetAssignmentSource;
  workspaceId: string;
  /** ownerId (su-…) for presence/claims; the agent-NAME for assignments. */
  agentId: string | null;
  agentLabel: string | null;
  agentName: string | null;
  harnessSlug: string | null;
  planSlug: string | null;
  /** P-NNN for plan-item rows. */
  itemId: string | null;
  /** WI-/F-/EI- id for work-item rows. */
  workItemId: string | null;
  itemKind: string | null;
  /** Claim intent / work-item title / presence intent. */
  detail: string;
  status: string | null;
  claimAcquiredTs: string | null;
  claimExpiresTs: string | null;
  /** Lease unexpired (plan-item claims); true for assignment/work rows; null for presence. */
  claimActive: boolean | null;
  livenessMode: string | null;
  lastActivityTs: string | null;
  /** The holder has a coord_presence row at all. */
  holderPresent: boolean;
  /** …and its heartbeat is fresh (PRESENCE_STALE_MS window). */
  holderAlive: boolean;
  holderHeartbeatAt: string | null;
  holderIntent: string | null;
  holderPlanSlug: string | null;
  /** THE signal: an active claim whose holder is DEAD = abandoned work. */
  orphaned: boolean;
  /** THE second signal (agent-activity-liveness-truth P-002, D-001): an active
   *  work-item claim whose holder is ALIVE but the work is NOT advancing — no
   *  item-scoped progress within the STALE_MS window. A claim is not progress.
   *  Mutually exclusive with `orphaned`; null on legs with no progress signal
   *  (plan-item claim/assignment, presence). Both are RECLAIMABLE. */
  stalled: boolean | null;
  /** Last REAL item-scoped progress (a state transition / checkpoint) on the
   *  claimed work-item, or null (no progress recorded / not a work-item claim). */
  lastProgressAt: string | null;
  /** Holder's self-declared plan matches the claim's plan (null when n/a). */
  declaredPlanMatches: boolean | null;
  /** Per-assignee position in the holder's ordered work-list (local-hive P-021).
   *  work-item rows only; null on plan-item/assignment/presence rows. */
  assigneeRank: number | null;
  /** Who set assigneeRank — 'bee' | 'queen' (the propose/dispose audit, D-008). */
  rankWriter: string | null;
}

/**
 * The single derived activity label for one fleet_assignment row (agent-activity-
 * liveness-truth P-005, D-002): the ONE truth every reader uses instead of
 * trusting a claim or a stale "spawned for X" broadcast. Projected straight from
 * the view's already-computed `orphaned`/`stalled` booleans + the progress
 * signal, so it can NEVER drift from the SQL the reconciler reads. This is the
 * view-row expression of {@link classifyItemActivity} (the pure canonical spec);
 * a P-007 test pins the two to agree. "Actively worked" ≡ `progressing` only.
 */
export function deriveActivity(
  r: Pick<FleetAssignmentRow, 'agentId' | 'orphaned' | 'stalled' | 'lastProgressAt' | 'holderAlive'>,
): ItemActivity {
  if (!r.agentId) return 'free';
  if (r.orphaned) return 'dead';
  if (r.stalled) return 'stalled';
  if (r.holderAlive) return r.lastProgressAt ? 'progressing' : 'alive';
  return 'reserved';
}

export interface ListFleetAssignmentsOpts {
  /** Scope to a workspace (+ the '*' global rows). null/undefined = all. */
  workspaceId?: string | null;
  /** Match agent_id OR agent_name exactly. */
  agent?: string;
  /** Match plan_slug exactly. */
  plan?: string;
  /** Match harness_slug exactly. */
  harness?: string;
  /** Drop lapsed plan-item leases (claim_active=false). Default true. */
  activeOnly?: boolean;
}

const toIso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

/** Read the canonical view. One query answers every projection. */
export async function listFleetAssignments(
  opts: ListFleetAssignmentsOpts = {},
): Promise<FleetAssignmentRow[]> {
  const { sql } = getOrgPg();
  const activeOnly = opts.activeOnly !== false;
  const rows = await sql`
    SELECT * FROM harness_shared.fleet_assignment
    WHERE ${
      opts.workspaceId != null
        ? // EI-295: the view UNIONs rows from TWO scoping domains — presence
          // stamps the AGENT's workspace (e.g. 'papercusp-workspace'), while
          // plan-item claims stamp the PLAN-STORE scope (resolvePlanScope →
          // DEFAULT_WORKSPACE_ID for operator-scope plans). Filtering the
          // union by the presence workspace alone silently dropped EVERY
          // claim row, so fleet:assignments / the Queen's placement reads /
          // the claim-discipline watcher all ran on claims:0 fleet-wide.
          // Accept the plan-store default alongside the caller's workspace
          // until the workspace axes are unified (federation lane).
          sql`(workspace_id = ${opts.workspaceId} OR workspace_id = ${GLOBAL_WORKSPACE} OR workspace_id = ${DEFAULT_WORKSPACE_ID})`
        : sql`TRUE`
    }
      AND ${opts.agent ? sql`(agent_id = ${opts.agent} OR agent_name = ${opts.agent})` : sql`TRUE`}
      AND ${opts.plan ? sql`plan_slug = ${opts.plan}` : sql`TRUE`}
      AND ${opts.harness ? sql`harness_slug = ${opts.harness}` : sql`TRUE`}
      AND ${activeOnly ? sql`(claim_active IS DISTINCT FROM false)` : sql`TRUE`}
    ORDER BY source, holder_heartbeat_at DESC NULLS LAST
  `;
  return rows.map(
    (r): FleetAssignmentRow => ({
      source: r.source as FleetAssignmentSource,
      workspaceId: r.workspace_id as string,
      agentId: (r.agent_id as string | null) ?? null,
      agentLabel: (r.agent_label as string | null) ?? null,
      agentName: (r.agent_name as string | null) ?? null,
      harnessSlug: (r.harness_slug as string | null) ?? null,
      planSlug: (r.plan_slug as string | null) ?? null,
      itemId: (r.item_id as string | null) ?? null,
      workItemId: (r.work_item_id as string | null) ?? null,
      itemKind: (r.item_kind as string | null) ?? null,
      detail: (r.detail as string | null) ?? '',
      status: (r.status as string | null) ?? null,
      claimAcquiredTs: toIso(r.claim_acquired_ts),
      claimExpiresTs: toIso(r.claim_expires_ts),
      claimActive: (r.claim_active as boolean | null) ?? null,
      livenessMode: (r.liveness_mode as string | null) ?? null,
      lastActivityTs: toIso(r.last_activity_ts),
      holderPresent: Boolean(r.holder_present),
      holderAlive: Boolean(r.holder_alive),
      holderHeartbeatAt: toIso(r.holder_heartbeat_at),
      holderIntent: (r.holder_intent as string | null) ?? null,
      holderPlanSlug: (r.holder_plan_slug as string | null) ?? null,
      orphaned: Boolean(r.orphaned),
      stalled: (r.stalled as boolean | null) ?? null,
      lastProgressAt: toIso(r.last_progress_at),
      declaredPlanMatches: (r.declared_plan_matches as boolean | null) ?? null,
      assigneeRank: r.assignee_rank == null ? null : Number(r.assignee_rank),
      rankWriter: (r.rank_writer as string | null) ?? null,
    }),
  );
}

// ───────────────────────── pure projections (no PG) ─────────────────────────

/** A claim attached to an agent group (the by-agent projection). */
export interface AgentClaim {
  type: 'plan-item' | 'work-item' | 'assignment';
  harnessSlug: string | null;
  planSlug: string | null;
  /** P-NNN (plan-item/assignment) or the work-item id. */
  id: string | null;
  itemKind: string | null;
  detail: string;
  status: string | null;
  acquiredTs: string | null;
  expiresTs: string | null;
  active: boolean;
  orphaned: boolean;
  /** Holder alive but work not advancing — reclaimable (work-item claims only). */
  stalled: boolean | null;
  /** Last item-scoped progress on the claim (work-item claims only). */
  lastProgressAt: string | null;
  /** The single derived truth: free|reserved|alive|progressing|stalled|dead (P-005). */
  activity: ItemActivity;
  /** Position in the holder's ordered work-list (work-item claims only; null otherwise). */
  rank: number | null;
  /** Who set the rank — 'bee' | 'queen' (D-008). */
  rankWriter: string | null;
}

/** One agent with everything it holds — "what is X doing" in one object. */
export interface AgentAssignment {
  agentId: string;
  label: string | null;
  /** Adopted agent-NAME, when any of its claims carry one. */
  name: string | null;
  present: boolean;
  alive: boolean;
  heartbeatAt: string | null;
  /** Self-declared intent (presence). */
  intent: string;
  /** Self-declared current plan (presence). */
  declaredPlanSlug: string | null;
  claims: AgentClaim[];
  /** Any active claim whose holder (this agent) is DEAD — abandoned work. */
  orphaned: boolean;
  /** Any active work-item claim this agent holds that is ALIVE but not advancing
   *  (no item-scoped progress in the window) — reclaimable (P-002/P-005). */
  stalled: boolean;
  /** Declared a plan but holds no claim/assignment on it — the D-002 smell. */
  declaredUnclaimed: boolean;
  // ── the externalized per-bee ordered work-list (local-hive P-021) ──
  /** Head-of-line: the lowest-rank work-item the agent holds (what it's doing / next).
   *  null when it holds no work-items. The Queen reads this for evict judgment. */
  doing: WorkListItem | null;
  /** The agent's work-items in rank order (head-of-line first; unranked last). The
   *  ordered plan the Queen reads for affinity. */
  queued: WorkListItem[];
  /** How many work-items the agent holds — the load signal for warm-inject vs a fresh
   *  slot (P-052). Counts work-item claims only (not plan-item leases). */
  load: number;
}

function toClaim(r: FleetAssignmentRow): AgentClaim {
  return {
    type:
      r.source === 'plan_item_claim'
        ? 'plan-item'
        : r.source === 'plan_item_assignment'
          ? 'assignment'
          : 'work-item',
    harnessSlug: r.harnessSlug,
    planSlug: r.planSlug,
    id: r.itemId ?? r.workItemId,
    itemKind: r.itemKind,
    detail: r.detail,
    status: r.status,
    acquiredTs: r.claimAcquiredTs,
    expiresTs: r.claimExpiresTs,
    active: r.claimActive !== false,
    orphaned: r.orphaned,
    stalled: r.stalled,
    lastProgressAt: r.lastProgressAt,
    activity: deriveActivity(r),
    rank: r.assigneeRank,
    rankWriter: r.rankWriter,
  };
}

/** One ordered work-list item — the externalized TodoWrite entry (local-hive P-021). */
export interface WorkListItem {
  /** WI-/F-/EI- id. */
  id: string;
  itemKind: string | null;
  title: string;
  status: string | null;
  rank: number | null;
  /** Who placed it — 'bee' (self-authored) | 'queen' (overlay) | null (unranked). */
  rankWriter: string | null;
  /** The derived truth for this held item (P-005): progressing = actively worked;
   *  stalled/dead = reclaimable (the holder isn't really advancing it). */
  activity: ItemActivity;
}

/**
 * Group view rows into per-agent assignments. Claim-primary: an agent with
 * claims but NO presence row still gets a group (present=false — the orphan).
 * Name-keyed assignment rows merge into the ownerId group whose claims carry
 * that owner_name; otherwise they stand alone keyed by the name.
 */
export function groupByAgent(rows: FleetAssignmentRow[]): AgentAssignment[] {
  const groups = new Map<string, AgentAssignment>();
  // Per-agent ordered work-list, accumulated from work_item_claim rows (P-021).
  const workLists = new Map<string, WorkListItem[]>();
  const ensure = (key: string): AgentAssignment => {
    let g = groups.get(key);
    if (!g) {
      g = {
        agentId: key,
        label: null,
        name: null,
        present: false,
        alive: false,
        heartbeatAt: null,
        intent: '',
        declaredPlanSlug: null,
        claims: [],
        orphaned: false,
        stalled: false,
        declaredUnclaimed: false,
        doing: null,
        queued: [],
        load: 0,
      };
      groups.set(key, g);
    }
    return g;
  };

  // Pass 1: presence + ownerId-keyed claims.
  const nameToOwner = new Map<string, string>();
  for (const r of rows) {
    if (!r.agentId) continue;
    if (r.source === 'plan_item_assignment') continue; // pass 2 (name-keyed)
    const g = ensure(r.agentId);
    g.label = g.label ?? r.agentLabel;
    if (r.source === 'presence') {
      g.present = true;
      g.alive = r.holderAlive;
      g.heartbeatAt = r.holderHeartbeatAt;
      g.intent = r.detail;
      g.declaredPlanSlug = r.planSlug;
    } else {
      g.claims.push(toClaim(r));
      // Accumulate the ordered work-list from work-item claims (P-021).
      if (r.source === 'work_item_claim' && r.workItemId) {
        const list = workLists.get(r.agentId) ?? [];
        list.push({
          id: r.workItemId,
          itemKind: r.itemKind,
          title: r.detail,
          status: r.status,
          rank: r.assigneeRank,
          rankWriter: r.rankWriter,
          activity: deriveActivity(r),
        });
        workLists.set(r.agentId, list);
      }
      if (r.orphaned) g.orphaned = true;
      if (r.stalled) g.stalled = true;
      // A claim joined to a presence row also proves the agent exists.
      if (r.holderPresent) {
        g.present = true;
        g.alive = g.alive || r.holderAlive;
        g.heartbeatAt = g.heartbeatAt ?? r.holderHeartbeatAt;
        g.intent = g.intent || (r.holderIntent ?? '');
        g.declaredPlanSlug = g.declaredPlanSlug ?? r.holderPlanSlug;
      }
      if (r.agentName) {
        g.name = g.name ?? r.agentName;
        nameToOwner.set(r.agentName, r.agentId);
      }
    }
  }

  // Pass 2: name-keyed durable assignments → merge into the owner's group when
  // a claim linked the name; otherwise a standalone name-keyed group.
  for (const r of rows) {
    if (r.source !== 'plan_item_assignment' || !r.agentId) continue;
    const ownerKey = nameToOwner.get(r.agentId) ?? r.agentId;
    const g = ensure(ownerKey);
    g.name = g.name ?? r.agentId;
    g.claims.push(toClaim(r));
  }

  // The declared-but-unclaimed smell: a declared plan none of the claims back.
  // + the P-021 ordered work-list: rank ASC (NULLs last), head-of-line = doing.
  for (const g of groups.values()) {
    g.declaredUnclaimed = Boolean(
      g.declaredPlanSlug && !g.claims.some((c) => c.planSlug === g.declaredPlanSlug),
    );
    const list = workLists.get(g.agentId) ?? [];
    list.sort((a, b) => {
      const ar = a.rank ?? Number.POSITIVE_INFINITY;
      const br = b.rank ?? Number.POSITIVE_INFINITY;
      if (ar !== br) return ar - br;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable tiebreak for unranked
    });
    g.queued = list;
    g.doing = list[0] ?? null;
    g.load = list.length;
  }

  // Live agents first, then abandoned/stalled-holders (the reclaimable smell),
  // newest heartbeat first.
  return [...groups.values()].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const aSmell = a.orphaned || a.stalled;
    const bSmell = b.orphaned || b.stalled;
    if (aSmell !== bSmell) return aSmell ? -1 : 1;
    return (b.heartbeatAt ?? '').localeCompare(a.heartbeatAt ?? '');
  });
}

/** Active claims whose holder is DEAD — the abandoned-work list. */
export function orphanedClaims(rows: FleetAssignmentRow[]): FleetAssignmentRow[] {
  return rows.filter((r) => r.orphaned && r.claimActive !== false);
}

/** Active work-item claims whose holder is ALIVE but the work is NOT advancing
 *  (no item-scoped progress in the window) — the stalled-work list (P-002/P-005). */
export function stalledClaims(rows: FleetAssignmentRow[]): FleetAssignmentRow[] {
  return rows.filter((r) => r.stalled === true && r.claimActive !== false);
}

/** Every reclaimable claim — DEAD (orphaned) OR alive-but-STALLED. The set the
 *  reconciler frees + the "is X really being worked?" reader treats as pickable. */
export function reclaimableClaims(rows: FleetAssignmentRow[]): FleetAssignmentRow[] {
  return rows.filter((r) => (r.orphaned || r.stalled === true) && r.claimActive !== false);
}

/**
 * The single per-item TRUTH (agent-activity-liveness-truth P-005, D-002): is this
 * work-item ACTUALLY being worked, by whom, and is it reclaimable? Derived live
 * from the reconciled fleet_assignment row (claim + holder-liveness + progress) —
 * NEVER from a coord broadcast that can outlive the work. This is what every
 * reader (the agent "is-X-covered" check, the Queen survey, placement) should
 * call instead of trusting a stale "spawned for X" announcement: it was a dead
 * bee mistaken for active for an hour that made this resolver necessary.
 *
 * A work-item with no live claim row (unclaimed OR terminal) resolves to `free`
 * with `activelyWorked:false` — the honest answer "nobody is advancing this now".
 */
export interface ItemActivityTruth {
  workItemId: string;
  /** A live (non-terminal) claim row exists for the item. */
  claimed: boolean;
  /** The holder's ownerId, or null when unclaimed/terminal. */
  holder: string | null;
  holderLabel: string | null;
  holderAlive: boolean;
  /** The derived label: free|reserved|alive|progressing|stalled|dead. */
  activity: ItemActivity;
  /** true ⇔ activity === 'progressing' — a LIVE holder making real progress. */
  activelyWorked: boolean;
  /** true ⇔ dead or stalled — free it + re-surface it (don't assume "covered"). */
  reclaimable: boolean;
  lastProgressAt: string | null;
  claimAcquiredTs: string | null;
  /** The work-item title (or holder intent), for a human-readable answer. */
  detail: string;
}

export async function whoIsDoingWhat(
  workItemId: string,
  opts: { workspaceId?: string | null } = {},
): Promise<ItemActivityTruth> {
  // Read the reconciled view (active claims only) and pick this item's work-item
  // claim row. The view excludes terminal statuses from the work_item_claim leg,
  // so a done/dropped item correctly resolves to `free` (nobody advancing it).
  const rows = await listFleetAssignments({ workspaceId: opts.workspaceId ?? null, activeOnly: true });
  const r = rows.find((row) => row.source === 'work_item_claim' && row.workItemId === workItemId);
  if (!r) {
    return {
      workItemId,
      claimed: false,
      holder: null,
      holderLabel: null,
      holderAlive: false,
      activity: 'free',
      activelyWorked: false,
      reclaimable: false,
      lastProgressAt: null,
      claimAcquiredTs: null,
      detail: '',
    };
  }
  const activity = deriveActivity(r);
  return {
    workItemId,
    claimed: true,
    holder: r.agentId,
    holderLabel: r.agentLabel,
    holderAlive: r.holderAlive,
    activity,
    activelyWorked: isActivelyWorked(activity),
    reclaimable: isReclaimable(activity),
    lastProgressAt: r.lastProgressAt,
    claimAcquiredTs: r.claimAcquiredTs,
    detail: r.detail,
  };
}

/** Claims keyed by holder ownerId — the roster's per-agent enrichment. */
export function claimsByAgent(rows: FleetAssignmentRow[]): Map<string, AgentClaim[]> {
  const map = new Map<string, AgentClaim[]>();
  for (const r of rows) {
    if (r.source === 'presence' || !r.agentId) continue;
    const list = map.get(r.agentId);
    if (list) list.push(toClaim(r));
    else map.set(r.agentId, [toClaim(r)]);
  }
  return map;
}

/** The wire shape an orphaned claim is reported in (fleet:assignments + /api/adv/roster). */
export interface OrphanedClaimSummary {
  source: FleetAssignmentSource;
  agent: string | null;
  harness: string | null;
  plan: string | null;
  id: string | null;
  detail: string;
  expires: string | null;
  holder_present: boolean;
  holder_heartbeat_at: string | null;
}

export function summarizeOrphan(r: FleetAssignmentRow): OrphanedClaimSummary {
  return {
    source: r.source,
    agent: r.agentId,
    harness: r.harnessSlug,
    plan: r.planSlug,
    id: r.itemId ?? r.workItemId,
    detail: r.detail,
    expires: r.claimExpiresTs,
    holder_present: r.holderPresent,
    holder_heartbeat_at: r.holderHeartbeatAt,
  };
}
