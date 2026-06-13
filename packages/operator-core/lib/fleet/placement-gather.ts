/**
 * fleet/placement-gather — the I/O layer that maps live fleet state into the
 * pure PlacementTask / PlacementBee inputs the batch planner consumes
 * (queen-autonomous-execution-2026-06-13, B-07 / P-001).
 *
 * Three reads, joined on the bee's coord owner id:
 *   • the nursery (harness_shared.spawned_agents) → live `bee`-role spawns + their
 *     home harness + last activity;
 *   • coord:presence → intent / current_files / current_plan / liveness;
 *   • fleet:assignments (groupByAgent) → load + the ordered work-list harnesses.
 *
 * Kept separate from the tool so the planner path stays free of PG and the tool
 * handler reads as gather → plan → execute.
 */
import { getOrgPg } from '@papercusp/db-org';
import { listPresence } from '../agent-tools/coordination/presence';
import { groupByAgent, listFleetAssignments } from './assignments';
import { getWorkItem, listWorkItems, type WorkItem } from '../work-items';
import type { PlacementBee, PlacementTask } from './placement-affinity';

/** Feature/issue states that mean "settled" — never a placeable frontier item. */
const TERMINAL_STATES = new Set([
  'passed', 'deprecated', 'resolved', 'closed', 'cancelled', 'done', 'dropped', 'merged',
]);

interface NurseryBeeRow {
  spawn_id: string;
  session_owner: string | null;
  harness_slug: string | null;
  last_active_ms: string | null;
}

/**
 * The live `bee`-role spawns for a workspace, mapped to PlacementBee with their
 * presence + assignment signals merged in. Non-bee roster entries (SU / operator /
 * human) are excluded by construction — only nursery rows with child_role='bee'.
 */
export async function gatherLiveBees(workspaceId: string): Promise<PlacementBee[]> {
  const { sql } = getOrgPg();
  const beeRows = await sql<NurseryBeeRow[]>`
    SELECT spawn_id, session_owner, harness_slug,
           (EXTRACT(EPOCH FROM GREATEST(
              COALESCE(last_output_at, heartbeat_at, started_at),
              COALESCE(heartbeat_at, started_at)
            )) * 1000)::bigint::text AS last_active_ms
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND status IN ('running', 'restarting')
       AND child_role = 'bee'`;
  if (beeRows.length === 0) return [];

  // Presence (intent / files / plan / liveness), keyed by owner id.
  const presence = await listPresence({ workspaceId }).catch(() => []);
  const presById = new Map(presence.map((p) => [p.ownerId, p]));

  // Assignment groups (load + the ordered work-list + per-claim harness), keyed by agent id.
  const rows = await listFleetAssignments({ workspaceId }).catch(() => []);
  const groups = groupByAgent(rows);
  const groupById = new Map(groups.map((g) => [g.agentId, g]));
  // Per-claim work-item harness, so we can label the bee's doing/queued harnesses.
  const claimHarness = new Map<string, string | null>();
  for (const g of groups) {
    for (const c of g.claims) {
      if (c.type === 'work-item' && c.id) claimHarness.set(c.id, c.harnessSlug);
    }
  }

  const bees: PlacementBee[] = [];
  for (const r of beeRows) {
    const ownerId = r.session_owner ?? r.spawn_id;
    const pres = presById.get(ownerId);
    const group = groupById.get(ownerId);
    // A present-but-stale bee is wedged/dead — not a warm-inject target. With no
    // presence row yet (just spawned) we still treat the running nursery row as
    // live; the woken-check at execution is the real reachability gate.
    const alive = pres ? !pres.stale : true;
    const heartbeatMs = pres?.heartbeatAt ? Date.parse(pres.heartbeatAt) : NaN;
    const nurseryMs = r.last_active_ms != null ? Number(r.last_active_ms) : NaN;
    const lastActiveMs = Number.isFinite(heartbeatMs)
      ? heartbeatMs
      : Number.isFinite(nurseryMs)
        ? nurseryMs
        : null;
    const queuedHarnesses = group
      ? [...new Set((group.queued ?? []).map((q) => claimHarness.get(q.id) ?? null).filter((h): h is string => !!h))]
      : [];
    const doingHarness = group?.doing ? claimHarness.get(group.doing.id) ?? null : null;
    bees.push({
      ownerId,
      label: pres?.ownerLabel ?? group?.label ?? null,
      harness: r.harness_slug,
      intent: pres?.intent ?? group?.intent ?? '',
      currentFiles: pres?.currentFiles ?? [],
      currentPlanSlug: pres?.currentPlanSlug ?? group?.declaredPlanSlug ?? null,
      doingHarness,
      queuedHarnesses,
      load: group?.load ?? 0,
      lastActiveMs,
      alive,
    });
  }
  return bees;
}

/** Pull repo-relative file hints off a work-item payload, if any. */
function filesFromPayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const raw = p.files ?? p.fileScope ?? p.primaryFiles;
  if (Array.isArray(raw)) return raw.filter((f): f is string => typeof f === 'string');
  return [];
}

function planSlugFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const s = p.planSlug ?? p.plan_slug ?? p.plan;
  return typeof s === 'string' && s ? s : null;
}

/** Map a WorkItem to the planner's PlacementTask shape. */
export function workItemToTask(wi: WorkItem): PlacementTask {
  return {
    id: wi.id,
    harness: wi.harness,
    title: wi.title,
    files: filesFromPayload(wi.payload),
    planSlug: planSlugFromPayload(wi.payload),
  };
}

export interface GatherFrontierOpts {
  /** Explicit ordered work-item ids (importance order) — the ranked frontier. */
  ids?: string[];
  /** Else, pull the OPEN unassigned backlog from this harness (priority order). */
  harness?: string;
  limit: number;
}

export interface GatherFrontierResult {
  tasks: PlacementTask[];
  /** Ids the caller named that are missing / already-assigned / settled (skipped). */
  skipped: { id: string; reason: string }[];
}

/**
 * Build the ready frontier. With explicit `ids`, resolve each (preserving the
 * caller's importance order) and skip anything missing, already-claimed, or
 * settled. Otherwise pull the harness's OPEN unassigned backlog ordered by the
 * shared priority (feature_order asc, then recency).
 */
export async function gatherFrontier(opts: GatherFrontierOpts): Promise<GatherFrontierResult> {
  const skipped: { id: string; reason: string }[] = [];

  if (opts.ids && opts.ids.length > 0) {
    const tasks: PlacementTask[] = [];
    for (const id of opts.ids.slice(0, opts.limit)) {
      const wi = await getWorkItem(id).catch(() => null);
      if (!wi) {
        skipped.push({ id, reason: 'not found' });
        continue;
      }
      if (wi.assignee) {
        skipped.push({ id, reason: `already claimed by ${wi.assignee}` });
        continue;
      }
      if (TERMINAL_STATES.has(wi.state)) {
        skipped.push({ id, reason: `settled (${wi.state})` });
        continue;
      }
      tasks.push(workItemToTask(wi));
    }
    return { tasks, skipped };
  }

  // Harness backlog: OPEN unassigned items, priority-ordered.
  const items = await listWorkItems({ harness: opts.harness, limit: Math.min(opts.limit * 3, 500) });
  const ready = items
    .filter((wi) => !wi.assignee && !TERMINAL_STATES.has(wi.state))
    .sort((a, b) => {
      const pa = a.priority ?? Number.POSITIVE_INFINITY;
      const pb = b.priority ?? Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    })
    .slice(0, opts.limit);
  return { tasks: ready.map(workItemToTask), skipped };
}
