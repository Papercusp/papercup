/**
 * survey — the Queen's plan-aware placement survey
 * (queen-autonomous-execution-2026-06-13 B-08: P-010, P-012, feeding P-031).
 *
 * The Queen prioritizes across two views of one source (autonomy-policy D-013),
 * BOTH ranked by the one placement registry (placement-ranker.ts):
 *
 *   - PLAN view (P-010): every STARTED plan across the Hive's member harnesses,
 *     ranked to answer "which plan do I pour bees into" — the plan-item / Queue
 *     side, pre-`plan_items:convert`.
 *   - FRONTIER view: every unplaced (todo, unassigned) feature-family work-item
 *     across the same harnesses, ranked to answer "which ready item do I place"
 *     — the work-item dispatch side, post-convert.
 *
 * P-012 — the member-harness survey FIX. The 2026-06-11 live wake surveyed only
 * the Hive's HOME slug (`papercup-hive`, the Queen's seat — almost always empty)
 * and slept through a freshly-filed MEMBER work-item. The robust fix is CODE,
 * not a prompt line: resolve the Hive's member harnesses from the registry and
 * survey EVERY one; and if membership isn't wired (only the home resolves), fall
 * back to a WORKSPACE-WIDE survey rather than the home slug alone — so the
 * home-only blind spot is structurally impossible. `survey.test.ts` pins it.
 *
 * The PG reads are thin + injectable (SurveyDeps) so the candidate-building and
 * ranking unit-test with no database; the real cross-member frontier query is
 * pinned by `survey.integration.test.ts`.
 */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { IMPORTANCE_LEVELS, type Importance } from '@papercusp/plan-parser';
import { activeWorkspaceId } from '../workspace-registry';
import { loadHarnessRegistry } from '../harness-registry';
import { listPlanIndexRows, type PlanIndexRow } from '../agent-tools/plans/source';
import { reconcileStartStatus, isTerminalPlanStatus } from '../agent-tools/plans/plan-start-state';
import { rankPlacements, type PlacementCandidate } from './placement-ranker';
import type { Ranked } from '../queue-ranker';
import { getFeatureBlockers } from '../dbos/feature-blockers-edges';
import { selectReady, type ReadinessNode } from '../dbos/frontier-readiness';

const MS_PER_DAY = 86_400_000;

/** Importance rank for "hottest open item" (most → least). */
const IMPORTANCE_RANK = Object.fromEntries(
  IMPORTANCE_LEVELS.map((level, i) => [level, i]),
) as Record<Importance, number>;

function daysSince(ts: unknown, now: number): number {
  if (!ts) return 0;
  const t = new Date(ts as string | number | Date).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now - t) / MS_PER_DAY);
}

// ── Membership (the P-012 fix) ──────────────────────────────────────────────

export interface HiveMembership {
  /** The Hive's home (`kind:'hive'`) harness slug. */
  home: string;
  /** Member harness slugs (registry `hive_slug` === home), excluding home. */
  members: string[];
  /**
   * The concrete slugs to survey: home + members when membership is wired, else
   * `[]` — meaning "survey the whole workspace" (the home-only blind-spot guard).
   */
  surveySlugs: string[];
  /** How the survey is scoped — surfaced so a caller can see the fallback. */
  scope: 'members' | 'workspace';
}

/**
 * Resolve a Hive's member harnesses from the registry. The home slug plus every
 * project whose `hive_slug` points at it. When no member is wired, `surveySlugs`
 * is empty so the survey runs workspace-wide instead of the (empty) home slug —
 * P-012's structural guard against the 2026-06-11 home-only miss.
 */
export async function resolveHiveMembership(
  workspaceId: string,
  hiveHomeSlug: string,
  loadRegistry: (ws: string) => Promise<{ projects: { slug: string; hive_slug?: string }[] }> = loadHarnessRegistry,
): Promise<HiveMembership> {
  const reg = await loadRegistry(workspaceId);
  const members = reg.projects
    .filter((p) => p.hive_slug === hiveHomeSlug && p.slug !== hiveHomeSlug)
    .map((p) => p.slug);
  const surveySlugs = members.length > 0 ? Array.from(new Set([hiveHomeSlug, ...members])) : [];
  return {
    home: hiveHomeSlug,
    members,
    surveySlugs,
    scope: surveySlugs.length > 0 ? 'members' : 'workspace',
  };
}

// ── Scope / pause enforcement (queen-steering-panel C-2, owned here) ─────────

/**
 * Frontier scope + pause control for the Queen's survey (queen-steering-panel
 * Brief B-03 / contract C-2). The steering panel (or an overwatch nudge) sets
 * this on `surveyHive` to STEER the Queen without stopping her:
 *
 *  - `pauseNewWork` (or `now < pausedUntil`) → the FRONTIER is emptied, so the
 *    Queen places no NEW work and instead drives existing placements to terminal,
 *    then idles. Started-plan momentum is intentionally NOT paused — pause gates
 *    only NEW unplaced work, not the work already in flight.
 *  - `allowedHarnesses` → the survey (frontier AND plans) is restricted to those
 *    harness slugs — a scope boundary the Queen cannot place outside of.
 *
 * Absent / empty ⇒ a no-op (the full, unscoped survey). Pure + side-effect-free
 * so it composes into surveyHive's existing readiness pipeline + unit-tests with
 * no DB.
 */
export interface ScopeFilter {
  /** Restrict the survey to these harness slugs (frontier + plans). Omit/[] ⇒ all. */
  allowedHarnesses?: string[];
  /** Restrict the PLAN view to these plan slugs — the owner's `eligiblePlans`
   *  (owner-steering C-1): "pour bees only into these plans". Omit/[] ⇒ all. The
   *  frontier (new unplaced work) is gated by pause + allowedHarnesses, not this. */
  eligiblePlans?: string[];
  /** Hard pause: empty the frontier (the Queen places no new work). */
  pauseNewWork?: boolean;
  /** Timed pause: empty the frontier while `now < pausedUntil` (epoch ms). */
  pausedUntil?: number;
}

/** Is NEW-work placement paused right now under this filter? (pure) */
export function isNewWorkPaused(f: ScopeFilter | undefined, now: number): boolean {
  if (!f) return false;
  if (f.pauseNewWork) return true;
  return typeof f.pausedUntil === 'number' && now < f.pausedUntil;
}

/** Does `harnessSlug` pass the filter's allow-list? (pure; no list ⇒ allow all) */
export function inAllowedHarness(harnessSlug: string, f: ScopeFilter | undefined): boolean {
  if (!f?.allowedHarnesses || f.allowedHarnesses.length === 0) return true;
  return f.allowedHarnesses.includes(harnessSlug);
}

/** Does `planSlug` pass the filter's eligible-plans list? (pure; no list ⇒ allow all) */
export function inEligiblePlans(planSlug: string, f: ScopeFilter | undefined): boolean {
  if (!f?.eligiblePlans || f.eligiblePlans.length === 0) return true;
  return f.eligiblePlans.includes(planSlug);
}

// ── Candidate builders (pure) ───────────────────────────────────────────────

/** Hottest-open-item importance for a plan (done/dropped excluded), 'normal' floor. */
function planMaxImportance(row: PlanIndexRow): Importance {
  let max: Importance | null = null;
  for (const it of row.items) {
    if (it.status === 'done' || it.status === 'dropped') continue;
    const imp = (IMPORTANCE_LEVELS as readonly string[]).includes(it.importance)
      ? (it.importance as Importance)
      : 'normal';
    if (max === null || IMPORTANCE_RANK[imp] < IMPORTANCE_RANK[max]) max = imp;
  }
  return max ?? 'normal';
}

/**
 * A STARTED plan → a placement candidate (PLAN view). Returns null for any plan
 * not operationally started (the Queen pours bees only into started plans).
 * `escalations` = open `needs-human` items (decisions waiting on a human);
 * `openItems` = todo+wip depth, surfaced as placement-capacity metadata.
 */
export function planToCandidate(
  row: PlanIndexRow,
  now: number,
  opts: { includeUnstarted?: boolean } = {},
): PlacementCandidate | null {
  const reconciled = reconcileStartStatus(row.opStatus, row.status);
  const started = reconciled === 'started';
  if (!started) {
    // By default the Queen pours bees only into STARTED plans, so an unstarted plan is
    // invisible — UNLESS it is owner-EXPLICITLY-eligible (includeUnstarted), in which
    // case we SURFACE it so she can start + decompose it (queen-autonomy-and-selffeed
    // C-1 / P-B1: eligible-plans is a self-FEED, not just a scope restriction). Never
    // surface a TERMINAL plan (shipped/superseded, or a reconciled-done started plan).
    if (!opts.includeUnstarted) return null;
    if (reconciled === 'done' || isTerminalPlanStatus(row.status)) return null;
  }
  let openItems = 0;
  let escalations = 0;
  for (const it of row.items) {
    if (it.status === 'todo' || it.status === 'wip') openItems += 1;
    if (it.status === 'needs-human') escalations += 1;
  }
  return {
    id: row.planSlug,
    view: 'plan',
    harness: row.harnessSlug,
    title: row.title ?? row.planSlug,
    importance: planMaxImportance(row),
    ageDays: daysSince(row.opUpdatedAt ?? row.updatedAt, now),
    opPriority: row.opPriority,
    escalations,
    openItems,
    // Surfaced-but-not-started ⇒ the Queen must start+decompose it before placing its
    // work (vs an already-running plan). She reads this to pick the right action.
    ...(started ? {} : { needsStart: true }),
  };
}

/** A row from the unplaced feature-family frontier query. */
export interface FrontierRow {
  feature_id: string;
  harness_slug: string;
  title: string | null;
  item_kind: string;
  created_ts: number | string | Date | null;
  feature_order: number | null;
}

/** An unplaced work-item row → a placement candidate (FRONTIER view). */
export function frontierRowToCandidate(row: FrontierRow, now: number): PlacementCandidate {
  return {
    id: row.feature_id,
    view: 'work-item',
    harness: row.harness_slug,
    title: row.title ?? row.feature_id,
    // Raw frontier items carry no plan-importance link yet; the PLAN view holds
    // the "which plan matters" signal. Aging + manual priority order them here.
    importance: 'normal',
    ageDays: daysSince(row.created_ts, now),
    opPriority: row.feature_order,
  };
}

// ── Readiness: honor blocked_by so the survey skips blocked lanes (W-01/P-010) ─

/**
 * One harness's feature→feature blocking graph, as the readiness filter needs it:
 * the blocker sets (reused from the orchestrator's single source of truth,
 * `getFeatureBlockers` → `coord_links rel='blocks'`) plus the statuses of the
 * referenced blockers (so terminal-ness — passed/deprecated → satisfied — is
 * resolvable). Empty maps ⇒ nothing in this harness is blocked.
 */
export interface HarnessBlockGraph {
  /** blocked feature_id → blocker feature_ids (within-harness, bare ids). */
  blockers: Map<string, string[]>;
  /** feature_id → status, for the referenced blockers (terminal resolution). */
  statuses: Map<string, string>;
}

/** Dispatchable status for the survey's frontier: an unplaced lane is a `todo` item. */
const FRONTIER_READINESS: ReadonlySet<string> = new Set(['todo']);

/**
 * Drop frontier rows whose `blocked_by` isn't satisfied — the same predicate the
 * DBOS orchestrator dispatches by (`selectReady`, frontier-readiness.ts): a lane
 * is ready iff every blocker is TERMINAL (passed/deprecated) or absent. So a wave's
 * tier2 stays out of the Queen's frontier until tier1 completes (D-002: one
 * readiness, two consumers). Feature ids aren't globally unique, so readiness is
 * computed per-harness. Returns the kept (ready) rows and the count dropped.
 */
export function filterReadyFrontier(
  rows: readonly FrontierRow[],
  graphByHarness: ReadonlyMap<string, HarnessBlockGraph>,
): { ready: FrontierRow[]; blockedCount: number } {
  const byHarness = new Map<string, FrontierRow[]>();
  for (const r of rows) {
    const g = byHarness.get(r.harness_slug);
    if (g) g.push(r);
    else byHarness.set(r.harness_slug, [r]);
  }
  const ready: FrontierRow[] = [];
  let blockedCount = 0;
  for (const [harness, hRows] of byHarness) {
    const graph = graphByHarness.get(harness);
    if (!graph || graph.blockers.size === 0) {
      ready.push(...hRows); // nothing blocked in this harness
      continue;
    }
    // Build the node set selectReady scores: each candidate (a `todo` lane) plus
    // its referenced blockers (carrying their real status so terminal blockers
    // satisfy). A blocker with no resolved status is simply absent ⇒ satisfied.
    const nodes = new Map<string, ReadinessNode>();
    for (const r of hRows) {
      nodes.set(r.feature_id, { id: r.feature_id, status: 'todo', blockedBy: graph.blockers.get(r.feature_id) ?? [] });
    }
    for (const r of hRows) {
      for (const blocker of graph.blockers.get(r.feature_id) ?? []) {
        if (nodes.has(blocker)) continue; // already a candidate node
        const status = graph.statuses.get(blocker);
        if (status != null) nodes.set(blocker, { id: blocker, status, blockedBy: [] });
      }
    }
    const { ready: readyNodes } = selectReady([...nodes.values()], new Set(), FRONTIER_READINESS);
    const readyIds = new Set(readyNodes.map((n) => n.id));
    for (const r of hRows) {
      if (readyIds.has(r.feature_id)) ready.push(r);
      else blockedCount += 1;
    }
  }
  return { ready, blockedCount };
}

// ── PG reads (thin) ─────────────────────────────────────────────────────────

/**
 * The unplaced FRONTIER across the given harnesses: feature-family work-items
 * that are `todo` and unassigned — exactly what placement would dispatch.
 * `surveySlugs` empty ⇒ workspace-wide (the P-012 fallback). Oldest-first,
 * capped. One query (no per-slug loop).
 */
export async function fetchFrontierRows(
  sql: postgres.Sql,
  workspaceId: string,
  surveySlugs: readonly string[],
  limit = 50,
): Promise<FrontierRow[]> {
  const rows = await sql<FrontierRow[]>`
    SELECT feature_id, harness_slug, title, item_kind, created_ts, feature_order
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${workspaceId}
       AND item_kind IN ('feature', 'research-task', 'chunk')
       AND status = 'todo'
       AND (taken_by IS NULL OR taken_by = '')
       ${surveySlugs.length > 0 ? sql`AND harness_slug = ANY(${surveySlugs as string[]})` : sql``}
     ORDER BY created_ts ASC
     LIMIT ${limit}`;
  return rows;
}

/**
 * One harness's blocking graph for the readiness filter: the blocker sets (the
 * orchestrator's single source of truth, `getFeatureBlockers`) plus the statuses
 * of the referenced blockers (one indexed lookup; skipped when nothing blocks).
 */
export async function fetchHarnessBlockGraph(
  sql: postgres.Sql,
  workspaceId: string,
  harness: string,
): Promise<HarnessBlockGraph> {
  const blockers = await getFeatureBlockers(harness);
  const blockerIds = new Set<string>();
  for (const arr of blockers.values()) for (const b of arr) blockerIds.add(b);
  let statuses = new Map<string, string>();
  if (blockerIds.size > 0) {
    const rows = await sql<{ feature_id: string; status: string }[]>`
      SELECT feature_id, status
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${workspaceId}
         AND harness_slug = ${harness}
         AND feature_id = ANY(${Array.from(blockerIds)})`;
    statuses = new Map(rows.map((r) => [r.feature_id, r.status]));
  }
  return { blockers, statuses };
}

// ── The assembled survey ────────────────────────────────────────────────────

export interface HiveSurvey {
  home: string;
  members: string[];
  scope: 'members' | 'workspace';
  /** Started plans, ranked (which plan to pour bees into) — PLAN view. */
  plans: Ranked<PlacementCandidate>[];
  /** Unplaced + READY work-items, ranked (which ready item to place) — FRONTIER view. */
  frontier: Ranked<PlacementCandidate>[];
  /** Frontier rows dropped because their `blocked_by` wasn't satisfied (W-01/P-010). */
  frontierBlocked: number;
}

export interface SurveyDeps {
  loadRegistry: (ws: string) => Promise<{ projects: { slug: string; hive_slug?: string }[] }>;
  listPlanRows: (harnessSlug: string) => Promise<PlanIndexRow[]>;
  fetchFrontier: (surveySlugs: readonly string[], limit: number) => Promise<FrontierRow[]>;
  /** Resolve one harness's blocking graph for the readiness filter (W-01/P-010). */
  fetchBlockGraph: (harness: string) => Promise<HarnessBlockGraph>;
  now: () => number;
}

function defaultSurveyDeps(workspaceId: string): SurveyDeps {
  return {
    loadRegistry: loadHarnessRegistry,
    // Pass the survey's known workspaceId so resolvePlanScope short-circuits on it
    // instead of throwing for a harness not (yet) in harness_shared.projects — the
    // WI-148 survey-starvation: an unregistered harness made the plan-read throw,
    // emptying the Queen's frontier so she placed nothing. The survey already scopes
    // to this workspace's harnesses, so its workspaceId IS the correct plan scope
    // (the error's sanctioned "or pass an explicit workspaceId" path).
    listPlanRows: (harnessSlug) => listPlanIndexRows({ harnessSlug, workspaceId }),
    fetchFrontier: (surveySlugs, limit) => {
      const { sql } = getOrgPg();
      return fetchFrontierRows(sql, workspaceId, surveySlugs, limit);
    },
    fetchBlockGraph: (harness) => {
      const { sql } = getOrgPg();
      return fetchHarnessBlockGraph(sql, workspaceId, harness);
    },
    now: () => Date.now(),
  };
}

/**
 * Survey a Hive's member harnesses and return BOTH ranked views (P-010 + the
 * P-012 fix). The plan-survey harness set mirrors the frontier scope: the
 * member slugs when wired, else every registered project (workspace-wide).
 */
export async function surveyHive(
  workspaceId: string,
  hiveHomeSlug: string,
  opts: { frontierLimit?: number; scopeFilter?: ScopeFilter; deps?: Partial<SurveyDeps> } = {},
): Promise<HiveSurvey> {
  const deps: SurveyDeps = { ...defaultSurveyDeps(workspaceId), ...opts.deps };
  const now = deps.now();
  const sf = opts.scopeFilter; // scope/pause filter (C-2) — used by both the plan loop + the frontier filter
  const membership = await resolveHiveMembership(workspaceId, hiveHomeSlug, deps.loadRegistry);

  // Which harnesses to read plans from: the survey slugs, or every project +
  // home when membership isn't wired (mirrors the frontier's workspace-wide
  // fallback so neither view can regress to the home-only blind spot).
  let planSlugs: string[];
  if (membership.surveySlugs.length > 0) {
    planSlugs = membership.surveySlugs;
  } else {
    const reg = await deps.loadRegistry(workspaceId);
    planSlugs = Array.from(new Set([hiveHomeSlug, ...reg.projects.map((p) => p.slug)]));
  }

  const [planRowsPerHarness, frontierRows] = await Promise.all([
    Promise.all(
      planSlugs.map(async (slug) => {
        try {
          return await deps.listPlanRows(slug);
        } catch (err) {
          console.warn(`[hive-survey] plan read failed for '${slug}' — skipped:`, err instanceof Error ? err.message : err);
          return [] as PlanIndexRow[];
        }
      }),
    ),
    deps.fetchFrontier(membership.surveySlugs, opts.frontierLimit ?? 50),
  ]);

  const planCandidates: PlacementCandidate[] = [];
  for (const rows of planRowsPerHarness) {
    for (const row of rows) {
      // queen-autonomy-and-selffeed C-1 (P-B1): an owner-EXPLICITLY-eligible plan is
      // surfaced even when unstarted (flagged needsStart) so the Queen can start +
      // decompose it. Only for plans in a non-empty eligiblePlans list — an un-steered
      // survey is unchanged (started plans only). The later inEligiblePlans filter then
      // keeps the eligible set; a started-but-not-eligible plan still gets filtered out.
      const includeUnstarted =
        (sf?.eligiblePlans?.length ?? 0) > 0 && !!sf?.eligiblePlans?.includes(row.planSlug);
      const c = planToCandidate(row, now, { includeUnstarted });
      if (c) planCandidates.push(c);
    }
  }

  // Honor blocked_by (W-01/P-010): resolve each surveyed harness's blocking graph
  // and drop frontier lanes whose blockers aren't satisfied — the SAME readiness
  // the orchestrator dispatches by. Per-harness because feature ids aren't global.
  const frontierHarnesses = [...new Set(frontierRows.map((r) => r.harness_slug))];
  const graphByHarness = new Map<string, HarnessBlockGraph>();
  await Promise.all(
    frontierHarnesses.map(async (h) => {
      try {
        graphByHarness.set(h, await deps.fetchBlockGraph(h));
      } catch (err) {
        // Fail-open: a flaky blocker read must not blank the frontier — treat as
        // unblocked (an empty graph) so placement still proceeds, but say so.
        console.warn(`[hive-survey] block-graph read failed for '${h}' — lanes treated unblocked:`, err instanceof Error ? err.message : err);
      }
    }),
  );
  const { ready: readyFrontierRowsAll, blockedCount } = filterReadyFrontier(frontierRows, graphByHarness);
  if (blockedCount > 0) {
    console.log(`[hive-survey] frontier: ${blockedCount} lane(s) held back by unsatisfied blocked_by; ${readyFrontierRowsAll.length} ready`);
  }
  // queen-steering-panel C-2 — scope/pause enforcement (applied AFTER the
  // readiness filter so it never resurrects a blocked lane): a PAUSE empties the
  // frontier so the Queen places no NEW work (and instead drives existing
  // placements to terminal, then idles); `allowedHarnesses` restricts the scope.
  // Started-plan momentum is intentionally NOT paused — pause gates only new work.
  const paused = isNewWorkPaused(sf, now);
  const readyFrontierRows = paused
    ? []
    : readyFrontierRowsAll.filter((r) => inAllowedHarness(r.harness_slug, sf));
  if (paused) {
    console.log(
      `[hive-survey] new-work PAUSED (scopeFilter) — frontier emptied (${readyFrontierRowsAll.length} ready item(s) withheld); Queen drives existing placements to terminal.`,
    );
  }
  const frontierCandidates = readyFrontierRows.map((r) => frontierRowToCandidate(r, now));

  const [plans, frontier] = await Promise.all([
    rankPlacements(planCandidates.filter((c) => inAllowedHarness(c.harness, sf) && inEligiblePlans(c.id, sf))),
    rankPlacements(frontierCandidates),
  ]);

  return { home: membership.home, members: membership.members, scope: membership.scope, plans, frontier, frontierBlocked: blockedCount };
}
