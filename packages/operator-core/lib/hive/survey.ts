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
import { reconcileStartStatus } from '../agent-tools/plans/plan-start-state';
import { rankPlacements, type PlacementCandidate } from './placement-ranker';
import type { Ranked } from '../queue-ranker';

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
export function planToCandidate(row: PlanIndexRow, now: number): PlacementCandidate | null {
  if (reconcileStartStatus(row.opStatus, row.status) !== 'started') return null;
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

// ── The assembled survey ────────────────────────────────────────────────────

export interface HiveSurvey {
  home: string;
  members: string[];
  scope: 'members' | 'workspace';
  /** Started plans, ranked (which plan to pour bees into) — PLAN view. */
  plans: Ranked<PlacementCandidate>[];
  /** Unplaced work-items, ranked (which ready item to place) — FRONTIER view. */
  frontier: Ranked<PlacementCandidate>[];
}

export interface SurveyDeps {
  loadRegistry: (ws: string) => Promise<{ projects: { slug: string; hive_slug?: string }[] }>;
  listPlanRows: (harnessSlug: string) => Promise<PlanIndexRow[]>;
  fetchFrontier: (surveySlugs: readonly string[], limit: number) => Promise<FrontierRow[]>;
  now: () => number;
}

function defaultSurveyDeps(workspaceId: string): SurveyDeps {
  return {
    loadRegistry: loadHarnessRegistry,
    listPlanRows: (harnessSlug) => listPlanIndexRows({ harnessSlug }),
    fetchFrontier: (surveySlugs, limit) => {
      const { sql } = getOrgPg();
      return fetchFrontierRows(sql, workspaceId, surveySlugs, limit);
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
  opts: { frontierLimit?: number; deps?: Partial<SurveyDeps> } = {},
): Promise<HiveSurvey> {
  const deps: SurveyDeps = { ...defaultSurveyDeps(workspaceId), ...opts.deps };
  const now = deps.now();
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
      const c = planToCandidate(row, now);
      if (c) planCandidates.push(c);
    }
  }
  const frontierCandidates = frontierRows.map((r) => frontierRowToCandidate(r, now));

  const [plans, frontier] = await Promise.all([
    rankPlacements(planCandidates),
    rankPlacements(frontierCandidates),
  ]);

  return { home: membership.home, members: membership.members, scope: membership.scope, plans, frontier };
}
