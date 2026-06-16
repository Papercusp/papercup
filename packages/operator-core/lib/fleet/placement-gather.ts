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
import { isAutoPickable, loadTrustedGithubUserIds } from '../work-items-admission';
import type { PlacementBee, PlacementTask } from './placement-affinity';
// Reuse the SAME readiness the survey + DBOS orchestrator dispatch by (D-007's
// shared seam: filterReadyFrontier → selectReady over getFeatureBlockers). No
// duplicated blocked_by logic — one readiness, every consumer (queen-wave-dispatch P-030).
import {
  filterReadyFrontier,
  fetchHarnessBlockGraph,
  type HarnessBlockGraph,
  type FrontierRow,
} from '../hive/survey';

/** Feature/issue states that mean "settled" — never a placeable frontier item. */
const TERMINAL_STATES = new Set([
  'passed', 'deprecated', 'resolved', 'closed', 'cancelled', 'done', 'dropped', 'merged',
]);

/**
 * EI-865 — the set of work-item ids the placement watchdog's circuit breaker has
 * LATCHED `cursed` for this workspace (`hive_placements.status='cursed'`). A cursed
 * item is a doomed placement the breaker has halted; it must NEVER re-enter the
 * placement frontier (by explicit id OR via the harness backlog) — else the Queen
 * re-places it the moment the breaker halt wears off across a wake and failCount
 * climbs unbounded (the 356→460 regression). Workspace-scoped, matching the
 * breaker's own scope. Returns the curse only leaves when a human/Queen clears it.
 */
export async function loadCursedWorkItemIds(workspaceId: string): Promise<Set<string>> {
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ work_item_id: string }[]>`
      SELECT DISTINCT work_item_id
        FROM harness_shared.hive_placements
       WHERE workspace_id = ${workspaceId}
         AND status = 'cursed'`;
    return new Set(rows.map((r) => r.work_item_id));
  } catch (e) {
    // Fail-open: a flaky breaker-ledger read must not blank the frontier — the
    // re-fire latch in the watchdog itself is the primary halt; this exclusion is
    // belt-and-braces so a cursed item also stays out of the survey/backlog.
    console.warn(`[placement-gather] cursed-item read failed — frontier not cursed-filtered:`, e instanceof Error ? e.message : e);
    return new Set();
  }
}

interface NurseryBeeRow {
  spawn_id: string;
  session_owner: string | null;
  harness_slug: string | null;
  last_active_ms: string | null;
}

/**
 * P-015 (presence-v2 D-003): the bee's RECENT-ACTIVITY timestamp for affinity
 * scoring — genuine work, NOT the keepalive heartbeat. Prefer the presence
 * `last_active_at` (bumped only by real tool dispatch / declare-intent / inbox
 * reads, never by the 60s psu-launcher keepalive); fall back to the nursery
 * activity ts for a just-spawned bee that has no presence row yet. Reading
 * `heartbeat_at` here made a parked-but-alive bee score as recently active.
 */
export function pickBeeRecentActivityMs(
  presenceLastActiveAt: string | null | undefined,
  nurseryMs: number | null,
): number | null {
  const presMs = presenceLastActiveAt ? Date.parse(presenceLastActiveAt) : NaN;
  if (Number.isFinite(presMs)) return presMs;
  if (nurseryMs != null && Number.isFinite(nurseryMs)) return nurseryMs;
  return null;
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
           -- P-015 (presence-v2 D-003): nursery activity = GENUINE work
           -- (last_output_at), not the keepalive heartbeat_at — a parked-but-alive
           -- bee must not read as recently active. started_at is the floor: a
           -- just-spawned bee with no output yet is legitimately "recent".
           (EXTRACT(EPOCH FROM COALESCE(last_output_at, started_at)) * 1000)::bigint::text AS last_active_ms
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
    // P-015 (presence-v2 D-003): RECENT ACTIVITY for affinity = genuine work via
    // pres.lastActiveAt, never the keepalive heartbeat. Liveness (`alive`) still
    // rides pres.stale — that's heartbeat-correct (process up ≠ recently active).
    const nurseryMs = r.last_active_ms != null ? Number(r.last_active_ms) : null;
    const lastActiveMs = pickBeeRecentActivityMs(pres?.lastActiveAt, nurseryMs);
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

/** Pull the per-lane situational brief off a work-item payload (queen-wave-dispatch
 *  P-021 stamps it at `payload.brief` from a `## Promote` lane's `brief:` field). */
function briefFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const b = (payload as Record<string, unknown>).brief;
  return typeof b === 'string' && b.trim() ? b : null;
}

/** Map a WorkItem to the planner's PlacementTask shape. */
export function workItemToTask(wi: WorkItem): PlacementTask {
  return {
    id: wi.id,
    harness: wi.harness,
    title: wi.title,
    files: filesFromPayload(wi.payload),
    planSlug: planSlugFromPayload(wi.payload),
    brief: briefFromPayload(wi.payload),
  };
}

export interface GatherFrontierOpts {
  /** Explicit ordered work-item ids (importance order) — the ranked frontier. */
  ids?: string[];
  /** Else, pull the OPEN unassigned backlog from this harness (priority order). */
  harness?: string;
  limit: number;
  /** Workspace for the blocked_by readiness filter (P-030). */
  workspaceId: string;
}

export interface GatherFrontierResult {
  tasks: PlacementTask[];
  /** Ids the caller named that are missing / already-assigned / settled / blocked (skipped). */
  skipped: { id: string; reason: string }[];
}

/**
 * Partition placement candidates by blocked_by readiness — the SAME predicate the
 * survey + DBOS orchestrator dispatch by (`filterReadyFrontier` → `selectReady`;
 * D-007's shared readiness seam). A lane is ready iff every blocker is TERMINAL
 * (passed/deprecated) or absent, so a wave's tier2 can NEVER be placed before
 * tier1 completes — the brief-discipline made structural at the placement
 * chokepoint (queen-wave-dispatch P-030 / D-006). Pure: the caller supplies the
 * per-harness blocking graph so this unit-tests with no database.
 */
export function partitionTasksByReadiness(
  tasks: PlacementTask[],
  graphByHarness: ReadonlyMap<string, HarnessBlockGraph>,
): { ready: PlacementTask[]; blocked: PlacementTask[] } {
  if (tasks.length === 0) return { ready: [], blocked: [] };
  const rows: FrontierRow[] = tasks.map((t) => ({
    feature_id: t.id,
    harness_slug: t.harness ?? '',
    title: t.title,
    item_kind: 'feature',
    created_ts: null,
    feature_order: null,
  }));
  const { ready } = filterReadyFrontier(rows, graphByHarness);
  const readyIds = new Set(ready.map((r) => r.feature_id));
  return {
    ready: tasks.filter((t) => readyIds.has(t.id)),
    blocked: tasks.filter((t) => !readyIds.has(t.id)),
  };
}

/**
 * Resolve each candidate harness's blocking graph (fail-open per harness — a flaky
 * blocker read treats that harness's lanes as unblocked rather than blanking the
 * frontier) and partition the tasks by readiness. The thin PG wrapper around the
 * pure `partitionTasksByReadiness`.
 */
async function filterFrontierReadiness(
  tasks: PlacementTask[],
  workspaceId: string,
): Promise<{ ready: PlacementTask[]; blocked: PlacementTask[] }> {
  const harnesses = [...new Set(tasks.map((t) => t.harness).filter((h): h is string => !!h))];
  if (harnesses.length === 0) return { ready: tasks, blocked: [] };
  const { sql } = getOrgPg();
  const graphByHarness = new Map<string, HarnessBlockGraph>();
  await Promise.all(
    harnesses.map(async (h) => {
      try {
        graphByHarness.set(h, await fetchHarnessBlockGraph(sql, workspaceId, h));
      } catch (e) {
        console.warn(
          `[placement-gather] block-graph read failed for '${h}' — lanes treated unblocked:`,
          e instanceof Error ? e.message : e,
        );
      }
    }),
  );
  return partitionTasksByReadiness(tasks, graphByHarness);
}

/**
 * Build the ready frontier. With explicit `ids`, resolve each (preserving the
 * caller's importance order) and skip anything missing, already-claimed, or
 * settled. Otherwise pull the harness's OPEN unassigned backlog ordered by the
 * shared priority (feature_order asc, then recency).
 */
export async function gatherFrontier(opts: GatherFrontierOpts): Promise<GatherFrontierResult> {
  const skipped: { id: string; reason: string }[] = [];
  let candidates: PlacementTask[];

  // P-008 trust fast-path (consumer side of P-010): a remote+un-admitted item is
  // also placeable when its VERIFIED author is in this workspace's local trust
  // list. Loaded once, workspace-scoped (D-004) — the SQL claim paths already do
  // the equivalent via autoPickableWhereSql(sql, workspaceId).
  const trustedAuthors = await loadTrustedGithubUserIds(opts.workspaceId);

  // EI-865 — the cursed-item exclusion: items the breaker has latched `cursed` are
  // never re-placed (by explicit id or via the backlog). Loaded once, workspace-scoped.
  const cursedIds = await loadCursedWorkItemIds(opts.workspaceId);

  if (opts.ids && opts.ids.length > 0) {
    candidates = [];
    for (const id of opts.ids.slice(0, opts.limit)) {
      if (cursedIds.has(id)) {
        skipped.push({ id, reason: 'cursed — the placement breaker has halted re-placing this item' });
        continue;
      }
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
      // G2 admission (shared-hive-trust-admission P-005): the Queen must not place a remote,
      // un-admitted item even by explicit id — it stays quarantined until the auditor admits
      // it (or its author is trusted, Phase 3).
      if (!isAutoPickable(wi.origin, wi.auditVerdict, wi.verifiedAuthorGithubUserId, trustedAuthors)) {
        skipped.push({ id, reason: 'remote work not yet auditor-admitted (quarantined)' });
        continue;
      }
      candidates.push(workItemToTask(wi));
    }
  } else {
    // Harness backlog: OPEN unassigned items, priority-ordered.
    const items = await listWorkItems({ harness: opts.harness, limit: Math.min(opts.limit * 3, 500) });
    candidates = items
      // G2 admission (P-005): exclude remote, un-admitted work from placement candidates.
      // EI-865: also exclude any item the breaker has latched `cursed`.
      .filter(
        (wi) =>
          !wi.assignee &&
          !TERMINAL_STATES.has(wi.state) &&
          !cursedIds.has(wi.id) &&
          isAutoPickable(wi.origin, wi.auditVerdict, wi.verifiedAuthorGithubUserId, trustedAuthors),
      )
      .sort((a, b) => {
        const pa = a.priority ?? Number.POSITIVE_INFINITY;
        const pb = b.priority ?? Number.POSITIVE_INFINITY;
        if (pa !== pb) return pa - pb;
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      })
      .slice(0, opts.limit)
      .map(workItemToTask);
  }

  // Honor blocked_by (P-030): a blocked lane (tier2 before tier1 completes) is
  // NEVER a placement candidate — the SAME readiness the survey/orchestrator use,
  // applied to BOTH the explicit-ids and harness-backlog paths so the Queen can't
  // place a blocked wave lane by any route (D-006: structural, not by convention).
  const { ready, blocked } = await filterFrontierReadiness(candidates, opts.workspaceId);
  for (const t of blocked) {
    skipped.push({ id: t.id, reason: 'blocked — an upstream lane (blocked_by) is not yet complete' });
  }
  return { tasks: ready, skipped };
}
