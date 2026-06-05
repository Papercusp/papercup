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
  /** THE signal: an active claim whose holder is gone/stale = abandoned work. */
  orphaned: boolean;
  /** Holder's self-declared plan matches the claim's plan (null when n/a). */
  declaredPlanMatches: boolean | null;
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
        ? sql`(workspace_id = ${opts.workspaceId} OR workspace_id = ${GLOBAL_WORKSPACE})`
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
      declaredPlanMatches: (r.declared_plan_matches as boolean | null) ?? null,
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
  /** Any active claim whose holder (this agent) is gone/stale. */
  orphaned: boolean;
  /** Declared a plan but holds no claim/assignment on it — the D-002 smell. */
  declaredUnclaimed: boolean;
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
  };
}

/**
 * Group view rows into per-agent assignments. Claim-primary: an agent with
 * claims but NO presence row still gets a group (present=false — the orphan).
 * Name-keyed assignment rows merge into the ownerId group whose claims carry
 * that owner_name; otherwise they stand alone keyed by the name.
 */
export function groupByAgent(rows: FleetAssignmentRow[]): AgentAssignment[] {
  const groups = new Map<string, AgentAssignment>();
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
        declaredUnclaimed: false,
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
      if (r.orphaned) g.orphaned = true;
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
  for (const g of groups.values()) {
    g.declaredUnclaimed = Boolean(
      g.declaredPlanSlug && !g.claims.some((c) => c.planSlug === g.declaredPlanSlug),
    );
  }

  // Live agents first, then orphan-holders, newest heartbeat first.
  return [...groups.values()].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    if (a.orphaned !== b.orphaned) return a.orphaned ? -1 : 1;
    return (b.heartbeatAt ?? '').localeCompare(a.heartbeatAt ?? '');
  });
}

/** Active claims whose holder is gone/stale — the abandoned-work list. */
export function orphanedClaims(rows: FleetAssignmentRow[]): FleetAssignmentRow[] {
  return rows.filter((r) => r.orphaned && r.claimActive !== false);
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
