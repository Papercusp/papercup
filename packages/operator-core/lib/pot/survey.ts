/**
 * survey — the Mug's plan-aware placement survey
 * (queen-autonomous-execution-2026-06-13 B-08: P-010, P-012, feeding P-031).
 *
 * The Mug prioritizes across two views of one source (autonomy-policy D-013),
 * BOTH ranked by the one placement registry (placement-ranker.ts):
 *
 *   - PLAN view (P-010): every STARTED plan across the Pot's member harnesses,
 *     ranked to answer "which plan do I pour cups into" — the plan-item / Queue
 *     side, pre-`plan_items:convert`.
 *   - FRONTIER view: every unplaced (todo, unassigned) feature-family work-item
 *     across the same harnesses, ranked to answer "which ready item do I place"
 *     — the work-item dispatch side, post-convert.
 *
 * P-012 — the member-harness survey FIX. The 2026-06-11 live wake surveyed only
 * the Pot's HOME slug (`papercup-pot`, the Mug's seat — almost always empty)
 * and slept through a freshly-filed MEMBER work-item. The robust fix is CODE,
 * not a prompt line: resolve the Pot's member harnesses from the registry and
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
import { withPgRetry } from '../pg-transient-retry';
import { frontierPlacementKindClause } from '../datatype-frontier-placement';
import { autoPickableWhereSql } from '../work-items-admission';
import { loadHarnessRegistry } from '../harness-registry';
import { listPlanIndexRows, type PlanIndexRow } from '../agent-tools/plans/source';
import { reconcileStartStatus, isTerminalPlanStatus } from '../agent-tools/plans/plan-start-state';
import { rankPlacements, type PlacementCandidate } from './placement-ranker';
import type { Ranked } from '../queue-ranker';
import { defaultBlockingStore } from '../work-item-blocking';
import { selectReady, type ReadinessNode } from '../dbos/frontier-readiness';
import { placementConfig } from './placement-watchdog';

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

export interface PotMembership {
  /** The Pot's home (`kind:'hive'`) harness slug. */
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

type RegistryProjectForPotSurvey = { slug: string; hive_slug?: string; harness_kind?: string };

/**
 * Resolve a Pot's member harnesses from the registry. The home slug plus every
 * project whose `hive_slug` points at it. When no member is wired, `surveySlugs`
 * is empty so the survey runs workspace-wide instead of the (empty) home slug —
 * P-012's structural guard against the 2026-06-11 home-only miss.
 */
export async function resolvePotMembership(
  workspaceId: string,
  potHomeSlug: string,
  loadRegistry: (ws: string) => Promise<{ projects: RegistryProjectForPotSurvey[] }> = loadHarnessRegistry,
): Promise<PotMembership> {
  const reg = await loadRegistry(workspaceId);
  const members = reg.projects
    .filter((p) => p.hive_slug === potHomeSlug && p.slug !== potHomeSlug)
    .map((p) => p.slug);
  const surveySlugs = members.length > 0 ? Array.from(new Set([potHomeSlug, ...members])) : [];
  return {
    home: potHomeSlug,
    members,
    surveySlugs,
    scope: surveySlugs.length > 0 ? 'members' : 'workspace',
  };
}

// ── Scope / pause enforcement (mug-steering-panel C-2, owned here) ─────────

/**
 * Frontier scope + pause control for the Mug's survey (mug-steering-panel
 * Brief B-03 / contract C-2). The steering panel (or an overwatch nudge) sets
 * this on `surveyPot` to STEER the Mug without stopping her:
 *
 *  - `pauseNewWork` (or `now < pausedUntil`) → the FRONTIER is emptied, so the
 *    Mug places no NEW work and instead drives existing placements to terminal,
 *    then idles. Started-plan momentum is intentionally NOT paused — pause gates
 *    only NEW unplaced work, not the work already in flight.
 *  - `allowedHarnesses` → the survey (frontier AND plans) is restricted to those
 *    harness slugs — a scope boundary the Mug cannot place outside of.
 *
 * Absent / empty ⇒ a no-op (the full, unscoped survey). Pure + side-effect-free
 * so it composes into surveyPot's existing readiness pipeline + unit-tests with
 * no DB.
 */
export interface ScopeFilter {
  /** Restrict the survey to these harness slugs (frontier + plans). Omit/[] ⇒ all. */
  allowedHarnesses?: string[];
  /** STOP-LIST: exclude frontier + plan work whose harness/pot is in this set —
   *  the per-pot Stop (per-pot start-stop 2026-06-30). A stop-list (NOT an
   *  allow-list) so standalone / unhived / started work is never regressed: only
   *  work belonging to an explicitly-STOPPED pot is withheld. Omit/[] ⇒ none. */
  stoppedHarnesses?: string[];
  /** Restrict the PLAN view to these plan slugs — the owner's `eligiblePlans`
   *  (owner-steering C-1): "pour cups only into these plans". Omit/[] ⇒ all. The
   *  frontier (new unplaced work) is gated by pause + allowedHarnesses, not this. */
  eligiblePlans?: string[];
  /** Hard pause: empty the frontier (the Mug places no new work). */
  pauseNewWork?: boolean;
  /** Timed pause: empty the frontier while `now < pausedUntil` (epoch ms). */
  pausedUntil?: number;
  /** Whether plan-LESS ("loose") frontier work-items — directly-filed features,
   *  benchmark/sandbox items, anything with no source plan — are placed. The
   *  owner's "Non-plan work items" steering toggle. Default (undefined) ⇒ TRUE
   *  (loose work is placed); set false to have the Mug work ONLY plan-tied
   *  items. Independent of eligiblePlans: loose work is gated by THIS, plan-tied
   *  work by eligiblePlans. */
  includeUnplannedWork?: boolean;
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

/** Is `harnessSlug` NOT in the stop-list (a stopped pot)? per-pot Stop gate.
 *  (pure; no list ⇒ pass — a stop-list only WITHHOLDS explicitly-stopped work.) */
export function notStopped(harnessSlug: string, f: ScopeFilter | undefined): boolean {
  if (!f?.stoppedHarnesses || f.stoppedHarnesses.length === 0) return true;
  return !f.stoppedHarnesses.includes(harnessSlug);
}

/** Does `planSlug` pass the filter's eligible-plans list? (pure; no list ⇒ allow all) */
export function inEligiblePlans(planSlug: string, f: ScopeFilter | undefined): boolean {
  if (!f?.eligiblePlans || f.eligiblePlans.length === 0) return true;
  return f.eligiblePlans.includes(planSlug);
}

/**
 * Frontier-row work eligibility — two INDEPENDENT owner controls, so plan focus
 * and loose-work handling no longer conflate (mug-steering-panel D-004 → P-008;
 * decoupled by owner directive 2026-06-30). A frontier work-item passes iff:
 *   - it is PLAN-LESS ("loose": a directly-filed feature, a benchmark/sandbox
 *     item) → included IFF `includeUnplannedWork` (the "Non-plan work items"
 *     toggle; default undefined ⇒ TRUE, i.e. loose work is placed); OR
 *   - it is PLAN-TIED → passes when there is no eligiblePlans restriction, else
 *     only when its source plan is in the eligible set.
 * Before this the two were coupled: setting eligiblePlans silently DROPPED all
 * loose work. Now the owner controls loose work explicitly (turn it off to have
 * the Mug work ONLY plan-tied items), and eligiblePlans focuses only plan-tied
 * work. Clearing both restores the full, unscoped frontier.
 * Distinct from {@link inEligiblePlans} (the PLAN view, where every candidate
 * always carries a plan slug). (pure)
 */
export function frontierInEligiblePlans(
  planSlug: string | null | undefined,
  f: ScopeFilter | undefined,
): boolean {
  if (!planSlug) return f?.includeUnplannedWork !== false; // loose work: gated by the toggle (default include)
  if (!f?.eligiblePlans || f.eligiblePlans.length === 0) return true; // plan-tied, no restriction ⇒ pass
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
 * not operationally started (the Mug pours cups only into started plans).
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
    // By default the Mug pours cups only into STARTED plans, so an unstarted plan is
    // invisible — UNLESS it is owner-EXPLICITLY-eligible (includeUnstarted), in which
    // case we SURFACE it so she can start + decompose it (mug-autonomy-and-selffeed
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
    // Surfaced-but-not-started ⇒ the Mug must start+decompose it before placing its
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
  /** Source plan slug (hfc.source_plan_slug) this frontier item was minted from,
   *  or null for unplanned/standalone work. Lets the survey HARD-filter the frontier
   *  by the owner's `eligiblePlans` (mug-steering-panel P-008). Optional so callers
   *  that build a FrontierRow without provenance (e.g. placement-gather) still compile. */
  plan_slug?: string | null;
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
 * tier2 stays out of the Mug's frontier until tier1 completes (D-002: one
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
 * Ephemeral benchmark / throwaway harness instances — the xbench fleet
 * (`xbench-su-*`, `xbq…` pot hashes), memory-capacity probes, per-task
 * `*-instance_*` churn. EI-1525: when a pot's membership isn't wired,
 * {@link resolvePotMembership}'s P-012 workspace-wide fallback (`surveySlugs
 * === []`) has NO harness filter at all — so this ephemeral debris was being
 * surveyed as real frontier work, going Mug-unresolvable, and escalating
 * (~13k false escalations from ~253 torn-down xbench/instance work-items on
 * 2026-06-18). Excluding it here closes that hole regardless of whether
 * membership ever gets wired. Mirrors the watchdog's EPHEMERAL_BENCHMARK_SLUG_RE
 * (watchdog.ts P-006) — kept as a local copy (same convention as
 * git-sync-eligibility.ts's EPHEMERAL_INSTANCE_SLUG_RE) so this hot Mug-wake
 * path gains no dependency on the heavy watchdog module. Real harness slugs
 * (papercup, papercup-org, papercup-pot, sheets, …) never match.
 */
const EPHEMERAL_BENCHMARK_SLUG_SQL_RE =
  '(^|[^a-z0-9])(xbench|xbq[a-z0-9]{6}|hiveloop|memcap|memrun)|-instance[_-]|_instance[_-]|deleteme|^e2e-imp|^sb-gym|gym-eval|^bench-|smoke-p[0-9]';

/**
 * The unplaced FRONTIER across the given harnesses: feature-family work-items
 * that are `todo` and unassigned — exactly what placement would dispatch.
 * `surveySlugs` empty ⇒ workspace-wide (the P-012 fallback), MINUS ephemeral
 * benchmark/instance debris (EI-1525 — see {@link EPHEMERAL_BENCHMARK_SLUG_SQL_RE}).
 * Oldest-first, capped. One query (no per-slug loop).
 *
 * EI-865 / WI-677 — PATHOLOGY-CURSED items are excluded. A watchdog `cursed`
 * row only hard-blocks the frontier when its fail_count reached the real
 * pathology breaker threshold. A fail_count=0 infra curse (host restart /
 * drain / zombie with no task failure) stays re-placeable, matching
 * place_batch's loadCursedWorkItemIds gate; otherwise Mug sees an empty
 * survey frontier while place_batch would have accepted the work.
 *
 * EI-8498 — G2-ADMISSION excluded. `fleet:place_batch`'s gatherFrontier
 * (placement-gather.ts) has applied the G2 admission predicate
 * (`isAutoPickable`/`autoPickableWhereSql`) since shared-pot-trust-admission
 * P-001: a remote, un-admitted item is quarantined and never placed. This
 * survey frontier grew up alongside that path and never inherited the
 * predicate, so a quarantined item (e.g. WI-2601) showed up here as "ready"
 * even though place_batch would refuse it — indistinguishable from a
 * genuinely-stuck placeable item, and the watchdog/escalation surfaces built
 * on this survey kept re-raising "frontier stuck, Mug/Mug nudge not
 * landing" false alarms for it wake after wake. Applying the SAME predicate
 * here (ws-scoped, includes the P-010 trust fast-path) closes that gap so the
 * survey's "ready" frontier matches what placement can actually pick up.
 */
export async function fetchFrontierRows(
  sql: postgres.Sql,
  workspaceId: string,
  surveySlugs: readonly string[],
  limit = 50,
): Promise<FrontierRow[]> {
  const breakerThreshold = placementConfig().breakerThreshold;
  const rows = await sql<FrontierRow[]>`
    SELECT feature_id, harness_slug, title, item_kind, created_ts, feature_order,
           source_plan_slug AS plan_slug
      FROM harness_shared.harness_features_consolidated f
     WHERE workspace_id = ${workspaceId}
       AND ${frontierPlacementKindClause(sql, workspaceId)}
       AND status = 'todo'
       AND (taken_by IS NULL OR taken_by = '')
       AND ${autoPickableWhereSql(sql, workspaceId)}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.pot_placements p
          WHERE p.workspace_id = f.workspace_id
            AND p.work_item_id = f.feature_id
            AND p.status = 'cursed'
            AND p.fail_count >= ${breakerThreshold}
            -- Scope the curse to THIS pot's own installs (papercup→papercusp migration follow-up,
            -- 2026-06-20): a curse from a RETIRED/foreign install must not hide the item from the
            -- home pot's frontier. Unscoped only in the workspace-wide fallback (surveySlugs empty).
            ${surveySlugs.length > 0 ? sql`AND p.install_slug = ANY(${surveySlugs as string[]})` : sql``}
       )
       ${surveySlugs.length > 0 ? sql`AND harness_slug = ANY(${surveySlugs as string[]})` : sql``}
       AND harness_slug !~* ${EPHEMERAL_BENCHMARK_SLUG_SQL_RE}
     ORDER BY created_ts ASC
     LIMIT ${limit}`;
  return rows;
}

/**
 * COUNT of the pot's REAL placeable frontier — the same row set
 * {@link fetchFrontierRows} returns (feature-family, `todo`, unassigned, not
 * cursed), scoped to the pot's member harnesses. This is the depth a per-pot
 * STARVATION signal must gate on (WI-267).
 *
 * The throughput breach previously read `potDemandCheck.todoItems` — a
 * WORKSPACE-WIDE `harness_features_consolidated status='todo'` count that ignored
 * `item_kind`, `taken_by`, the cursed exclusion, AND pot membership. So one
 * workspace-wide number fired identical false "fleet saturated with work still
 * queued" alarms across every pot in the workspace at once (a pot whose own
 * placement frontier is empty/all-taken/cursed was flagged "starved" off another
 * pot's queued work it could never place).
 *
 * MUST mirror fetchFrontierRows' WHERE clause. (Pre-readiness: a `blocked_by`
 * lane is still counted here — the survey's {@link filterReadyFrontier} refines
 * that; a cheap per-tick count omits the block-graph fetch. This already kills
 * the dominant scope/kind/taken/cursed false-positive set; the residual
 * all-blocked-frontier edge is a follow-up.)
 */
export async function countPlaceableFrontier(
  sql: postgres.Sql,
  workspaceId: string,
  surveySlugs: readonly string[],
): Promise<number> {
  const breakerThreshold = placementConfig().breakerThreshold;
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
      FROM harness_shared.harness_features_consolidated f
     WHERE workspace_id = ${workspaceId}
       AND ${frontierPlacementKindClause(sql, workspaceId)}
       AND status = 'todo'
       AND (taken_by IS NULL OR taken_by = '')
       AND ${autoPickableWhereSql(sql, workspaceId)}
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.pot_placements p
          WHERE p.workspace_id = f.workspace_id
            AND p.work_item_id = f.feature_id
            AND p.status = 'cursed'
            AND p.fail_count >= ${breakerThreshold}
            -- Scope the curse to THIS pot's own installs (papercup→papercusp migration follow-up,
            -- 2026-06-20): a curse from a RETIRED/foreign install must not hide the item from the
            -- home pot's frontier. Unscoped only in the workspace-wide fallback (surveySlugs empty).
            ${surveySlugs.length > 0 ? sql`AND p.install_slug = ANY(${surveySlugs as string[]})` : sql``}
       )
       ${surveySlugs.length > 0 ? sql`AND harness_slug = ANY(${surveySlugs as string[]})` : sql``}
       AND harness_slug !~* ${EPHEMERAL_BENCHMARK_SLUG_SQL_RE}`;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Resolve a pot's membership and return its placeable-frontier depth (WI-267) —
 * the count a per-pot starvation breach should use instead of the workspace-wide
 * `potDemandCheck.todoItems`. Member-scoped when membership is wired, else the
 * workspace-wide P-012 fallback (mirrors {@link surveyPot}'s own scope choice).
 */
export async function potPlaceableFrontierDepth(
  workspaceId: string,
  potHomeSlug: string,
): Promise<number> {
  const { sql } = getOrgPg();
  const membership = await resolvePotMembership(workspaceId, potHomeSlug);
  return countPlaceableFrontier(sql, workspaceId, membership.surveySlugs);
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
  const blockers = await defaultBlockingStore.blockersFor(harness);
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

export interface PotSurvey {
  home: string;
  members: string[];
  scope: 'members' | 'workspace';
  /** Started plans, ranked (which plan to pour cups into) — PLAN view. */
  plans: Ranked<PlacementCandidate>[];
  /** Unplaced + READY work-items, ranked (which ready item to place) — FRONTIER view. */
  frontier: Ranked<PlacementCandidate>[];
  /** Frontier rows dropped because their `blocked_by` wasn't satisfied (W-01/P-010). */
  frontierBlocked: number;
}

export interface SurveyDeps {
  loadRegistry: (ws: string) => Promise<{ projects: RegistryProjectForPotSurvey[] }>;
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
    // emptying the Mug's frontier so she placed nothing. The survey already scopes
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
 * Survey a Pot's member harnesses and return BOTH ranked views (P-010 + the
 * P-012 fix). The plan-survey harness set mirrors the frontier scope: the
 * member slugs when wired, else every registered project (workspace-wide).
 */
export async function surveyPot(
  workspaceId: string,
  potHomeSlug: string,
  opts: {
    frontierLimit?: number;
    scopeFilter?: ScopeFilter;
    deps?: Partial<SurveyDeps>;
    /** Extra harness slugs to UNION into a members-wired survey scope — the
     *  workspace Mug passes the STARTED-pot set here (owner model 2026-07-01:
     *  "the Mug works ANY started pot"). Without this, a home pot with
     *  members wired narrowed the survey to home+members and every OTHER
     *  started pot's work was invisible to her (the stop-list only SUBTRACTS
     *  stopped hives; nothing added started ones back). A workspace-wide
     *  fallback scope (`surveySlugs: []`) already sees everything, so the
     *  union only applies when membership is wired. */
    extraSurveySlugs?: string[];
  } = {},
): Promise<PotSurvey> {
  const deps: SurveyDeps = { ...defaultSurveyDeps(workspaceId), ...opts.deps };
  const now = deps.now();
  const sf = opts.scopeFilter; // scope/pause filter (C-2) — used by both the plan loop + the frontier filter
  const membership = await resolvePotMembership(workspaceId, potHomeSlug, deps.loadRegistry);
  const surveySlugs =
    membership.surveySlugs.length > 0 && (opts.extraSurveySlugs?.length ?? 0) > 0
      ? Array.from(new Set([...membership.surveySlugs, ...opts.extraSurveySlugs!]))
      : membership.surveySlugs;

  // Which harnesses to read plans from: the survey slugs, or pot HOME slugs
  // when membership isn't wired. The frontier fallback is workspace-wide, but
  // plans are Pot-scoped; ordinary project slugs make resolvePlanScope reject
  // and caused a live Mug wake to spend its floor gather on hundreds of
  // repeated "not a Pot home" warnings. So the plan side falls back only to
  // real kind:'hive' homes (plus this home for legacy registries), while the
  // frontier keeps the workspace-wide blind-spot guard.
  let planSlugs: string[];
  if (surveySlugs.length > 0) {
    planSlugs = surveySlugs;
  } else {
    const reg = await deps.loadRegistry(workspaceId);
    planSlugs = Array.from(new Set([potHomeSlug, ...reg.projects.filter((p) => p.harness_kind === 'hive').map((p) => p.slug)]));
  }

  const [planRowsPerHarness, frontierRows] = await Promise.all([
    Promise.all(
      planSlugs.map(async (slug) => {
        try {
          // Bounded retry on a transient CONNECT_TIMEOUT (WI-2776): a read-only plan
          // list, safe to re-issue. Absorbs the self-healing pooler blip that made a
          // live Mug wake skip a member's plan; a sustained outage still logs below.
          return await withPgRetry(() => deps.listPlanRows(slug), { label: 'pot-survey.listPlanRows' });
        } catch (err) {
          console.warn(`[pot-survey] plan read failed for '${slug}' — skipped:`, err instanceof Error ? err.message : err);
          return [] as PlanIndexRow[];
        }
      }),
    ),
    deps.fetchFrontier(surveySlugs, opts.frontierLimit ?? 50),
  ]);

  const planCandidates: PlacementCandidate[] = [];
  for (const rows of planRowsPerHarness) {
    for (const row of rows) {
      // mug-autonomy-and-selffeed C-1 (P-B1): an owner-EXPLICITLY-eligible plan is
      // surfaced even when unstarted (flagged needsStart) so the Mug can start +
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
        console.warn(`[pot-survey] block-graph read failed for '${h}' — lanes treated unblocked:`, err instanceof Error ? err.message : err);
      }
    }),
  );
  const { ready: readyFrontierRowsAll, blockedCount } = filterReadyFrontier(frontierRows, graphByHarness);
  if (blockedCount > 0) {
    console.log(`[pot-survey] frontier: ${blockedCount} lane(s) held back by unsatisfied blocked_by; ${readyFrontierRowsAll.length} ready`);
  }
  // mug-steering-panel C-2 + P-008 — scope/pause/plan enforcement (applied AFTER
  // the readiness filter so it never resurrects a blocked lane): a PAUSE empties the
  // frontier so the Mug places no NEW work (and instead drives existing placements
  // to terminal, then idles); `allowedHarnesses` restricts the harness scope; and the
  // P-008 plan HARD-filter drops any frontier row minted from a plan that is NOT in
  // the owner's `eligiblePlans` (unplanned rows pass — they are not plan-gated). So
  // "work on these plans only" is structurally binding at the frontier, not advisory.
  // Started-plan momentum is intentionally NOT paused — pause gates only new work.
  const paused = isNewWorkPaused(sf, now);
  const readyFrontierRows = paused
    ? []
    : readyFrontierRowsAll.filter(
        (r) => inAllowedHarness(r.harness_slug, sf) && notStopped(r.harness_slug, sf) && frontierInEligiblePlans(r.plan_slug, sf),
      );
  if (paused) {
    console.log(
      `[pot-survey] new-work PAUSED (scopeFilter) — frontier emptied (${readyFrontierRowsAll.length} ready item(s) withheld); Mug drives existing placements to terminal.`,
    );
  }
  const frontierCandidates = readyFrontierRows.map((r) => frontierRowToCandidate(r, now));

  const [plans, frontier] = await Promise.all([
    rankPlacements(planCandidates.filter((c) => inAllowedHarness(c.harness, sf) && notStopped(c.harness, sf) && inEligiblePlans(c.id, sf))),
    rankPlacements(frontierCandidates),
  ]);

  return { home: membership.home, members: membership.members, scope: membership.scope, plans, frontier, frontierBlocked: blockedCount };
}

// ── Cross-pot workspace survey (P-003 / D-002 — the central dispatcher) ───────

/**
 * The workspace-wide survey the ONE central-dispatcher Mug reads when
 * FLAGS.WORKSPACE_COORDINATION is ON (workspace-scoped-coordination-2026-06-20
 * P-003 / D-002): every pot in the workspace, surveyed individually so ideation
 * stays focused (`perPot` — the per-pot sections, mitigating the D-004
 * cross-domain-dilution risk), PLUS one cross-pot ranked backlog
 * (`crossPot`) merged from all hives and re-ranked by the SAME placement
 * registry so the Mug prioritizes across hives and dispatches by cross-pot
 * priority. Every candidate carries its `hive` tag (the source/target-pot
 * routing of P-001) so the placement path lands work on the right pot's cups.
 */
export interface WorkspaceSurvey {
  /** Per-pot sections — one {@link PotSurvey} per pot, tagged by home slug. */
  perPot: Array<{ pot: string; survey: PotSurvey }>;
  /** The cross-pot ranked backlog (all hives merged + re-ranked, pot-tagged). */
  crossPot: {
    plans: Ranked<PlacementCandidate>[];
    frontier: Ranked<PlacementCandidate>[];
    frontierBlocked: number;
  };
  /** The pot home slugs surveyed (registry order). */
  hives: string[];
}

type SurveyScope = PotSurvey['scope'];

function crossPotCandidateKey(c: PlacementCandidate): string {
  return `${c.view}:${c.harness}:${c.id}`;
}

function addCrossPotCandidate(
  acc: Map<string, { candidate: PlacementCandidate; scope: SurveyScope }>,
  candidate: PlacementCandidate,
  scope: SurveyScope,
) {
  const key = crossPotCandidateKey(candidate);
  const existing = acc.get(key);
  if (!existing || (existing.scope === 'workspace' && scope === 'members')) {
    acc.set(key, { candidate, scope });
  }
}

/**
 * Survey the WHOLE workspace for the central-dispatcher Mug (P-003). Resolves
 * every pot (registry `kind:'hive'` projects), surveys each individually (the
 * focused per-pot sections), then merges + RE-RANKS the combined candidate sets
 * into one cross-pot backlog so cross-pot priority is a single ordering. Each
 * candidate carries its `hive` tag so {@link surveyPot}'s `harness` field +
 * this tag together route a placement onto the right pot's cups.
 *
 * Falls back to surveying the supplied home pot alone when no pot resolves (a
 * never-registered box stays sane). The caller decides whether to call this
 * (WORKSPACE_COORDINATION ON) or {@link surveyPot} (OFF, byte-identical to today).
 */
export async function surveyWorkspace(
  workspaceId: string,
  opts: {
    frontierLimit?: number;
    scopeFilter?: ScopeFilter;
    deps?: Partial<SurveyDeps>;
    /** Resolve the workspace's pot home slugs. Default: the registry's
     *  `kind:'hive'` projects (injectable so this unit-tests without PG). */
    listPotSlugs?: (ws: string) => Promise<string[]>;
    /** Fallback home when no pot resolves (the per-pot survey seat). */
    fallbackHome?: string;
  } = {},
): Promise<WorkspaceSurvey> {
  const listPotSlugs =
    opts.listPotSlugs ??
    (async (ws: string): Promise<string[]> => {
      const { listPots } = await import('../agent-tools/pot/_resolve');
      return (await listPots(ws)).map((h) => h.slug);
    });

  let potSlugs = await listPotSlugs(workspaceId).catch(() => [] as string[]);
  if (potSlugs.length === 0 && opts.fallbackHome) potSlugs = [opts.fallbackHome];
  // De-dup + stable order (registry order); a workspace==pot shape is one entry.
  potSlugs = Array.from(new Set(potSlugs));

  const perPot = await Promise.all(
    potSlugs.map(async (pot) => ({
      pot,
      survey: await surveyPot(workspaceId, pot, {
        frontierLimit: opts.frontierLimit,
        scopeFilter: opts.scopeFilter,
        deps: opts.deps,
      }),
    })),
  );

  // Merge every pot's candidates (each tagged with its source/target pot — the
  // P-001 routing tag) and re-rank through the ONE placement registry, so the
  // cross-pot priority is a SINGLE ordering, never a per-pot sort concatenated.
  // The ranker is pot-agnostic and re-derives the rank from the candidate fields,
  // so re-ranking the union is correct; the `hive` tag rides through as metadata
  // the placement path routes on.
  const planCandidates = new Map<string, { candidate: PlacementCandidate; scope: SurveyScope }>();
  const frontierCandidates = new Map<string, { candidate: PlacementCandidate; scope: SurveyScope }>();
  let frontierBlocked = 0;
  for (const { pot, survey } of perPot) {
    for (const c of survey.plans) addCrossPotCandidate(planCandidates, { ...c, pot }, survey.scope);
    for (const c of survey.frontier) addCrossPotCandidate(frontierCandidates, { ...c, pot }, survey.scope);
    frontierBlocked += survey.frontierBlocked;
  }
  const [plans, frontier] = await Promise.all([
    rankPlacements([...planCandidates.values()].map((v) => v.candidate)),
    rankPlacements([...frontierCandidates.values()].map((v) => v.candidate)),
  ]);

  return {
    perPot,
    crossPot: { plans, frontier, frontierBlocked },
    hives: potSlugs,
  };
}
