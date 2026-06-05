/**
 * The DBOS **orchestrator** — the global, deterministic cross-feature selector
 * (formerly "the dispatcher"; renamed per dbos-system-completion-2026-06-01 D-007
 * so there is exactly ONE "orchestrator" = this code component that selects work
 * globally, while the per-feature LLM decision-maker keeps its distinct name
 * `director`). Naming convention: the component is the **orchestrator**; "dispatch"
 * survives only as a *verb* — it dispatches a durable pipeline per feature.
 *
 * When durable orchestration is enabled, this periodically scans the opted-in
 * harnesses for features that need work and starts a durable pipeline per feature
 * (up to a concurrency cap) — the production counterpart to the manual
 * `POST /admin/dbos/pipeline/start` trigger.
 *
 * Double-gated for safety:
 *   - `PAPERCUSP_DBOS_ORCHESTRATOR=1` — registers the workflow (via bootstrap).
 *   - `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES=slug,slug` — which harnesses opt in
 *     (empty → the tick is a no-op, so enabling the orchestrator flag alone
 *     never auto-starts agent work). The legacy `PAPERCUSP_DBOS_DISPATCH_HARNESSES`
 *     is still accepted as a back-compat alias (D-007).
 *   - `PAPERCUSP_DBOS_MAX_PIPELINES` — OPTIONAL global concurrency ceiling that
 *     clamps every harness (e.g. the shared dev box); unset → each harness uses
 *     its own `parallelWorkers` cap up to a hard `SAFETY_CEILING` (#1).
 *
 * Concurrency is per-harness, not a flat global (#1): each harness fills its own
 * slots up to `resolvePerHarnessCap` (from its `parallelWorkers.max` /
 * `maxFeaturesInFlight`). Two paths feed it: the periodic 30s tick (the backstop
 * that picks up newly-filed work) and `refillHarnessOnSettle` (a finished feature
 * immediately refills its freed slot — continuous dispatch rather than ≤30s lag).
 *
 * The frontier (P-042) reads the full plan-gated feature set + each feature's
 * `blocked_by` edges from the consolidated source of truth, and the carve-out
 * (`durableOwnedFeatureIdsPg`) excludes features a live pipeline owns from the
 * dispatch CANDIDATES (while keeping them in the dependency graph so an in-flight
 * blocker still blocks its dependents). So a re-scan only ever picks NEW, ready
 * work; combined with `ensureFeaturePipeline`'s dedup, the tick is idempotent and
 * safe to re-run wholesale on recovery (we WANT a fresh re-scan, not a cached
 * replay — hence the scheduled workflow calls the tick directly, not via steps).
 */
import { join } from 'node:path';
import { DBOS } from '@dbos-inc/dbos-sdk';
import postgres from 'postgres';
import {
  durableOwnedFeatureIdsPg,
  readConfig,
  evaluateCostCap,
  parallelMaxWorkers,
  maxFeaturesInFlight,
  dispatchAuditorLane,
} from '@papercusp/orchestrator';
import type { AuditorSpawnFn, CreateEscalationFn } from '@papercusp/orchestrator';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { activeWorkspaceId, readRegistry } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';
import { listAllHarnesses } from '../dev-data';
import { resolveProject } from '../harness-core';
import { convertOpenIssuesToFeatures } from '../promote-issue';
import { loadIssuesOrSeed, saveIssues } from '../harness-issues';
import type { Issue } from '../harness/issue-types';
import { ensureFeaturePipeline } from './orchestrator-start';
import { getFeatureBlockers } from './feature-blockers-edges';

// ─── G2 Auditor lane injection seam (P-007) ──────────────────────────────────
//
// The operator wires the real spawn + escalation functions via
// `setAuditorLaneFns`. Tests and the legacy path leave them null (no-op).
// Both are best-effort: a missing wiring means the auditor lane is skipped,
// which leaves remote features quarantined but never blocks dispatch.
let _auditorSpawn: AuditorSpawnFn | null = null;
let _createEscalation: CreateEscalationFn | null = null;

export function setAuditorLaneFns(
  spawnFn: AuditorSpawnFn,
  escalationFn: CreateEscalationFn,
): void {
  _auditorSpawn = spawnFn;
  _createEscalation = escalationFn;
}

/**
 * Feature statuses that warrant starting a durable pipeline. The live vocabulary
 * is `todo` (not started) / `failing` (failed validation, needs rework); the
 * `pending`/`failed` aliases from the FeatureRecord type are kept for safety.
 * `in_progress` is excluded (already being worked), as are `passed`/`blocked`/
 * `deprecated`/`proposed`.
 */
const NEEDS_WORK = new Set(['todo', 'failing', 'pending', 'failed']);

/**
 * Hard safety ceiling on per-harness pipeline concurrency when no explicit
 * `PAPERCUSP_DBOS_MAX_PIPELINES` override is set. A misconfigured harness
 * (`parallelWorkers.max: 1000`) must not be able to spawn 1000 pipelines; this
 * caps the blast radius while still honoring any sane per-harness setting.
 */
const SAFETY_CEILING = 16;

/**
 * Per-harness pipeline concurrency cap (#1 — concurrency-aware dispatch). DBOS
 * runs one pipeline per in-flight feature, so the cap on concurrent pipelines is
 * the harness's own feature-concurrency budget — NOT a flat global:
 *   - `parallelWorkers.max` is the worker budget; with one worker per feature
 *     (chunk-loop), that bounds how many features can run at once.
 *   - `parallelWorkers.maxFeaturesInFlight`, when set, tightens that further
 *     (cap distinct features below the worker budget) but never widens past it.
 *   - `envCeiling` (`PAPERCUSP_DBOS_MAX_PIPELINES`) is an optional global clamp
 *     (e.g. the shared dev box) on top of the resolved per-harness value.
 * Always at least 1 (a harness can never be dispatch-starved by config).
 */
export function resolvePerHarnessCap(opts: {
  parallelMax: number;
  maxFeaturesInFlight: number | null;
  envCeiling?: number;
}): number {
  const budget = Number.isFinite(opts.parallelMax) ? opts.parallelMax : 1;
  const base =
    opts.maxFeaturesInFlight != null && opts.maxFeaturesInFlight > 0
      ? Math.min(budget, opts.maxFeaturesInFlight)
      : budget;
  const ceiling = opts.envCeiling && opts.envCeiling > 0 ? opts.envCeiling : SAFETY_CEILING;
  return Math.max(1, Math.min(base, ceiling));
}

/** Statuses that make a feature TERMINAL — a blocker in this set is satisfied. */
const TERMINAL = new Set(['passed', 'deprecated']);

/** A feature as the frontier sees it (P-042): status + resolved blocked_by edges
 *  + which plan it belongs to + its within-plan order. */
export interface FrontierFeature {
  id: string;
  status: string;
  /** Resolved canonical blocker ids (P-046). Empty when unblocked. */
  blockedBy: readonly string[];
  /** metadata.source_plan — null for manual/legacy features. */
  sourcePlan: string | null;
  /** feature_order — null when unset (ordered last within its plan group). */
  order: number | null;
}

/**
 * The frontier dispatch selection (P-042 / D-012 / D-013), replacing the old
 * flat `eligible.filter(NEEDS_WORK).slice(slots)`. One pass, O(V+E):
 *   1. terminal = features that are passed/deprecated.
 *   2. ready    = needs-work, not already in-flight (`owned`), and every
 *                 blocked_by SATISFIED — a blocker is satisfied iff it is
 *                 terminal OR absent from the set (an absent id never deadlocks;
 *                 a `failing` blocker is non-terminal, so its dependents
 *                 correctly stay blocked).
 *   3. group ready by plan; order groups by `planPriority` (lower first; a plan
 *      with no resolved priority, and the manual/no-plan group, sort LAST),
 *      tie-break by plan slug; within a group by (order ASC NULLS LAST, id).
 *   4. fill greedily up to `slots`: a higher-priority plan monopolizes the
 *      harness until its ready features can't fill the cap, then the next plan
 *      fills the gap (avi's strict-priority spec) — the blocked_by frontier
 *      naturally lets a lower plan fill when a higher plan's features are all
 *      blocked. `slots <= 0` (cap full, or over the cost cap) → start nothing.
 * Also returns `stuck`: work remains but nothing is ready (all remaining are
 * blocked/failing) — the P-044 stuck-wave signal the retired sweep used to raise.
 */
export function computeFrontier(
  features: readonly FrontierFeature[],
  planPriority: ReadonlyMap<string, number>,
  owned: ReadonlySet<string>,
  slots: number,
): { toStart: string[]; stuck: boolean } {
  const present = new Set(features.map((f) => f.id));
  const terminal = new Set(features.filter((f) => TERMINAL.has(f.status)).map((f) => f.id));
  const satisfied = (blockerId: string): boolean => !present.has(blockerId) || terminal.has(blockerId);

  const ready = features.filter(
    (f) => NEEDS_WORK.has(f.status) && !owned.has(f.id) && f.blockedBy.every(satisfied),
  );

  // Group ready by plan ('' = manual / no source_plan).
  const groups = new Map<string, FrontierFeature[]>();
  for (const f of ready) {
    const key = f.sourcePlan ?? '';
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  const prioOf = (key: string): number =>
    key === '' ? Number.POSITIVE_INFINITY : planPriority.get(key) ?? Number.POSITIVE_INFINITY;
  const orderedGroups = [...groups.keys()].sort((a, b) => {
    const pa = prioOf(a);
    const pb = prioOf(b);
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const ordered: string[] = [];
  for (const key of orderedGroups) {
    const g = groups.get(key)!.slice().sort((x, y) => {
      const ox = x.order ?? Number.POSITIVE_INFINITY;
      const oy = y.order ?? Number.POSITIVE_INFINITY;
      if (ox !== oy) return ox - oy;
      return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
    });
    for (const f of g) ordered.push(f.id);
  }

  const toStart = slots > 0 ? ordered.slice(0, slots) : [];
  const pendingWork = features.some((f) => NEEDS_WORK.has(f.status) && !owned.has(f.id));
  return { toStart, stuck: pendingWork && ready.length === 0 };
}

/** Explicit opt-out sentinels (e.g. the shared dev box, to avoid flooding it). */
const DISPATCH_OFF = new Set(['none', 'off']);

/**
 * Which harnesses the orchestrator serves, from the environment. Primary env is
 * `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES`; the legacy `PAPERCUSP_DBOS_DISPATCH_HARNESSES`
 * is still honored as a back-compat alias (D-007 rename). Same grammar either way.
 */
function orchestratorHarnessesEnv(): string | undefined {
  return (
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES ??
    process.env.PAPERCUSP_DBOS_DISPATCH_HARNESSES
  );
}

/**
 * Resolve which harnesses the orchestrator serves from the env value + the full
 * workspace harness list (P-006/P-009). Pure (testable). Since P-009, DBOS is the
 * DEFAULT orchestrator for every harness:
 *   - empty / unset / `'*'` → ALL harnesses in the workspace (the default);
 *   - `'none'` / `'off'` → disabled (explicit opt-out — the legacy path is retired,
 *     so this just means "don't auto-dispatch here", e.g. a contended shared box);
 *   - an explicit comma list → that allowlist (scoped override).
 */
export function resolveOrchestratorHarnesses(
  envRaw: string | undefined,
  allSlugs: string[],
): string[] {
  const v = (envRaw ?? '').trim();
  if (DISPATCH_OFF.has(v.toLowerCase())) return [];
  if (v === '' || v === '*') return allSlugs;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether to arm the 30s scheduled tick: anything but an explicit opt-out (P-009). */
export function shouldScheduleOrchestrator(envRaw: string | undefined): boolean {
  const v = (envRaw ?? '').trim();
  return !DISPATCH_OFF.has(v.toLowerCase());
}

/**
 * The concrete harness slugs to sweep this tick. In all-mode (`'*'`) enumerate
 * every harness in the active workspace; otherwise use the explicit allowlist.
 */
async function resolveTickHarnesses(workspaceId: string): Promise<string[]> {
  const envRaw = orchestratorHarnessesEnv();
  if ((envRaw ?? '').trim() !== '*') {
    return resolveOrchestratorHarnesses(envRaw, []);
  }
  try {
    const { harnesses } = await listAllHarnesses([workspaceId]);
    return harnesses.map((h) => h.slug);
  } catch {
    return [];
  }
}

/** Optional global concurrency ceiling (`PAPERCUSP_DBOS_MAX_PIPELINES`). When set
 * it clamps every harness's resolved cap (e.g. on the shared dev box); unset →
 * `undefined`, so `resolvePerHarnessCap` falls back to its `SAFETY_CEILING`. */
function pipelineEnvCeiling(): number | undefined {
  const n = Number(process.env.PAPERCUSP_DBOS_MAX_PIPELINES);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

interface HarnessDispatchGate {
  /** Per-harness pipeline concurrency cap from `parallelWorkers` (#1). */
  cap: number;
  /** Whether the harness is over its configured `maxCostUsd` (P-004). */
  overCostCap: boolean;
}

/**
 * Resolve the harness's `.papercusp/config.json` ONCE and derive both dispatch
 * gates from it: the per-harness concurrency `cap` (from `parallelWorkers`) and
 * the cost-cap (`maxCostUsd` vs run-log spend). Any resolution/read failure →
 * the safe defaults (`cap: 1`, `overCostCap: false`) so a bad slug never strands
 * work or floods the box.
 */
async function resolveHarnessDispatchGate(
  slug: string,
  workspaceId: string,
): Promise<HarnessDispatchGate> {
  try {
    const project = await resolveProject(slug, workspaceId);
    if (!project) return { cap: 1, overCostCap: false };
    const stateDir = join(project.path, '.papercusp');
    const logDir = join(stateDir, 'logs');
    const cfg = readConfig(stateDir);
    const cap = resolvePerHarnessCap({
      parallelMax: parallelMaxWorkers(cfg),
      maxFeaturesInFlight: maxFeaturesInFlight(cfg),
      envCeiling: pipelineEnvCeiling(),
    });
    const overCostCap = evaluateCostCap(cfg, logDir, stateDir).overCap;
    return { cap, overCostCap };
  } catch {
    return { cap: 1, overCostCap: false };
  }
}

/** Count live (PENDING/ENQUEUED) pipelines for one harness. */
async function liveCountFor(harnessSlug: string): Promise<number> {
  const live = await DBOS.listWorkflows({
    workflow_id_prefix: `pipeline:${harnessSlug}:`,
    status: ['PENDING', 'ENQUEUED'],
  });
  return live.length;
}

export interface OrchestratorTickResult {
  harness: string;
  started: string[];
}

/**
 * P-011 (D-004 / D-016): the automated CONVERT_ISSUES sweep. Promote every open
 * `critical`/`major` issue with no linked feature to an `F-FIX` feature so the
 * substrate fixes it under DBOS (the legacy `CONVERTED` verb was just an
 * agent-side receipt; this is deterministic code). Best-effort and isolated —
 * any failure is swallowed so it can never sink the dispatch path — and the
 * sweep's own per-`(workspace, harness)` in-process mutex makes the 30s-tick +
 * on-settle-refill double-fire idempotent (no double-mint).
 */
async function convertIssuesForHarness(slug: string, workspaceId: string): Promise<void> {
  const project = await resolveProject(slug, workspaceId);
  if (!project) return;
  const { promoted } = await convertOpenIssuesToFeatures(project, { workspaceId });
  if (promoted.length > 0) {
    console.log(
      `[dbos-orchestrator] ${slug} converted ${promoted.length} issue(s) → F-FIX: ` +
        promoted.map((p) => `${p.issueId}→${p.featureId}`).join(', '),
    );
  }
}

/** The persistent stuck-frontier issue id (one per harness; idempotent). */
const STUCK_ISSUE_ID = 'I-STUCK';
const OPEN_STATUSES = new Set(['open', 'acknowledged', 'fixing']);

/**
 * P-044: surface the frontier `stuck` state as a persistent harness issue — the
 * observability the retired wave-advance sweep's `onBlocked` (I-WAVE-*) provided.
 * Idempotent: raises one open `I-STUCK` while stuck (no re-save if already open),
 * and auto-closes it when work becomes ready again. Best-effort.
 */
async function raiseOrClearStuckSignal(slug: string, workspaceId: string, stuck: boolean): Promise<void> {
  const project = await resolveProject(slug, workspaceId);
  if (!project) return;
  const file = await loadIssuesOrSeed(project);
  const existing = file.issues.find((i) => i.id === STUCK_ISSUE_ID);
  const isOpen = !!existing && OPEN_STATUSES.has(existing.status);
  const now = new Date().toISOString();
  if (stuck) {
    if (isOpen) return; // already raised — idempotent, no write
    if (existing) {
      existing.status = 'open';
      existing.notes.push({ ts: now, by: 'orchestrator', text: 'Frontier stuck again — work remains but nothing is ready.' });
    } else {
      file.issues.unshift({
        id: STUCK_ISSUE_ID,
        title: 'Dispatch frontier stuck — work remains but nothing is ready',
        severity: 'major',
        source: 'system',
        foundAt: now,
        status: 'open',
        evidence:
          `Harness "${slug}" has features needing work, but every remaining one is blocked ` +
          `(its blocked_by isn't satisfied) or failing, so the dependency frontier can't advance. ` +
          `Resolve a failing/blocking feature (or deprecate it), or fix a dependency cycle.`,
        attempts: 0,
        notes: [],
      } as Issue);
    }
    await saveIssues(project, file);
  } else {
    if (!isOpen) return; // nothing to clear
    existing!.status = 'closed';
    existing!.notes.push({ ts: now, by: 'orchestrator', text: 'Frontier no longer stuck — work became ready.' });
    await saveIssues(project, file);
  }
}

/**
 * Dispatch for ONE harness: read eligible (non-owned) features, fill the free
 * slots up to the harness's own concurrency `cap`, and `ensureFeaturePipeline`
 * each. Used by both the periodic sweep and the on-completion refill seam (#1).
 * A failure is isolated (returns `started: []`, never throws).
 */
export async function dispatchOneHarness(
  slug: string,
  workspaceId: string,
  adminUrl: string = getHarnessAdminUrl(),
): Promise<OrchestratorTickResult> {
  const pg = postgres(adminUrl, {
    max: 1,
    connect_timeout: 5,
    connection: { search_path: `harness_${slug},harness_shared,public` },
  });
  try {
    // P-011: auto-promote qualifying open issues → F-FIX features BEFORE the
    // feature read, so a freshly-minted fix is eligible this same tick. Its own
    // try/catch guarantees a convert failure never sinks dispatch.
    await convertIssuesForHarness(slug, workspaceId).catch(() => {});
    // G2 P-007: screen any remote+pending features through the auditor BEFORE the
    // pick loop considers them. The P-008 gate already blocks them from being
    // picked while pending; this lane resolves the verdict so admitted features
    // become eligible this same tick. Best-effort: a missing wiring or failure
    // leaves features quarantined (fail-safe) and never sinks dispatch.
    if (_auditorSpawn && _createEscalation) {
      await dispatchAuditorLane(
        {
          pg: pg as never,
          workspaceId,
          spawnAuditor: _auditorSpawn,
          createEscalation: _createEscalation,
          log: (m) => console.log(m),
        },
        slug,
      ).catch((err) => {
        console.warn(`[dbos-orchestrator] ${slug} auditor lane error (non-fatal):`, (err as Error).message);
      });
    }
    // P-042: the frontier reads the FULL gated feature set (incl. its blocked_by
    // edges + plan + order) from the consolidated source of truth — NOT the
    // carved-out view set — so an in-flight blocker correctly still blocks its
    // dependents. The carve-out (`owned`) is applied to dispatch CANDIDATES, not
    // to the dependency graph.
    const [features, owned, planPriority] = await Promise.all([
      readFrontierFeatures(pg, workspaceId, slug),
      durableOwnedFeatureIdsPg({ pg: pg as never, workspaceId, harnessSlug: slug }),
      readPlanPriority(pg, workspaceId, slug),
    ]);
    const liveCount = await liveCountFor(slug);
    const { cap, overCostCap } = await resolveHarnessDispatchGate(slug, workspaceId);
    const slots = overCostCap ? 0 : Math.max(0, cap - liveCount);
    const { toStart, stuck } = computeFrontier(features, planPriority, owned, slots);
    if (overCostCap) console.log(`[dbos-orchestrator] ${slug} over maxCostUsd — skipping new pipelines`);
    if (stuck) {
      console.warn(
        `[dbos-orchestrator] ${slug} frontier STUCK — work remains but nothing is ready ` +
          `(all remaining features are blocked or failing)`,
      );
    }
    // P-044: the retired wave-advance sweep used to raise an I-WAVE-* issue when a
    // wave couldn't drain. Preserve that observability in the frontier model — a
    // persistent (idempotent) I-STUCK issue while stuck, auto-cleared when work
    // becomes ready again. Best-effort; never sinks dispatch.
    if (!overCostCap) await raiseOrClearStuckSignal(slug, workspaceId, stuck).catch(() => {});
    const started: string[] = [];
    for (const fid of toStart) {
      // Pass the tick's own workspaceId so the pipeline pins THIS workspace rather
      // than the volatile active one (which can differ from the harness's home).
      const r = await ensureFeaturePipeline(slug, fid, workspaceId);
      if (r.started) started.push(fid);
    }
    return { harness: slug, started };
  } catch {
    // Per-harness isolation: a bad slug / unreachable schema doesn't sink the sweep.
    return { harness: slug, started: [] };
  } finally {
    await pg.end({ timeout: 2 }).catch(() => {});
  }
}

/**
 * Read the full plan-gated feature set for the frontier (P-042) from the
 * consolidated source of truth: each feature's status + `feature_order` +
 * `source_plan` (from the `work_items` view, scoped to kind=feature), and its
 * blocker set from the coord_links rel='blocks' edges (EI-1 / D-027 — the legacy
 * `blocked_by` column is dropped). Reads the consolidated surface directly (not the
 * SELECT*-frozen per-harness view, which doesn't expose feature_order — D-017),
 * applying the same started-plan gate `readFeaturesPg` uses (features with no plan
 * are always eligible; plan features only when their plan is 'started'). No
 * carve-out here — the caller passes `owned` to the frontier.
 */
export async function readFrontierFeatures(
  pg: ReturnType<typeof postgres>,
  workspaceId: string,
  slug: string,
): Promise<FrontierFeature[]> {
  const rows = await pg<
    Array<{
      feature_id: string;
      status: string;
      feature_order: number | null;
      source_plan: string | null;
    }>
  >`
    SELECT feature_id, status, feature_order,
           metadata->>'source_plan' AS source_plan
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${slug}
       -- work_items unification (unify-work-items-2026-06-04, D-005): the feature
       -- pipeline frontier reads the canonical work_items surface, scoped to
       -- kind=feature. Other kinds (bug/change run inline, research-task/chunk run
       -- their own blueprint) are NOT dispatched onto the feature pipeline. The
       -- work_items view is SELECT * over harness_features_consolidated, so this is
       -- view-transparent (same columns, same indexes) — a pure surface repoint.
       AND item_kind = 'feature'
       AND (
         (metadata->>'source_plan') IS NULL
         OR (metadata->>'source_plan') IN (
           SELECT plan_slug
             FROM harness_shared.harness_plans
            WHERE workspace_id = ${workspaceId}
              AND harness_slug = ${slug}
              AND op_status = 'started'
         )
       )
       -- Auditor gate (G2 / P-008): a remote-authored feature is NOT pickable
       -- until the auditor admits it. This MUST be enforced here on the live
       -- DBOS frontier read (not only in the legacy readFeaturesPg) so the
       -- pick path independently quarantines un-admitted remote features even
       -- if the auditor dispatch lane is unwired/errors/lags — fail-safe.
       -- (origin NULL = local, for pre-G1 back-compat; mirrors isAutoPickable.)
       AND (origin = 'local' OR origin IS NULL OR audit_verdict = 'admit')
  `;
  // EI-1 (D-027/D-028): feature→feature blocking IS the coord_links rel='blocks'
  // edge — the single source of truth. The legacy `blocked_by` column + its GIN
  // index were dropped (migration 155); getFeatureBlockers reads the harness's
  // blocker sets in one indexed query (the cheap dispatch read D-027 specifies).
  // computeFrontier is unaffected — only the data source for `blockedBy` changed.
  const edgeBlockers = await getFeatureBlockers(slug);
  return rows.map((r) => ({
    id: r.feature_id,
    status: r.status,
    blockedBy: edgeBlockers.get(r.feature_id) ?? [],
    sourcePlan: r.source_plan,
    order: r.feature_order,
  }));
}

/**
 * Resolve each started plan's effective cross-plan dispatch priority (P-042 step
 * 4 / D-013): the explicit `priority` column (P-045's drag order) when set, else
 * a large base + a `started_at` rank so unset plans fall AFTER all explicit ones
 * in started-order. Lower number = dispatched first.
 */
async function readPlanPriority(
  pg: ReturnType<typeof postgres>,
  workspaceId: string,
  slug: string,
): Promise<Map<string, number>> {
  const rows = await pg<Array<{ plan_slug: string; eff_priority: number | bigint }>>`
    SELECT plan_slug,
           COALESCE(
             op_priority,
             1000000 + (ROW_NUMBER() OVER (ORDER BY op_started_at ASC NULLS LAST, plan_slug))::int
           ) AS eff_priority
      FROM harness_shared.harness_plans
     WHERE workspace_id = ${workspaceId}
       AND harness_slug = ${slug}
       AND op_status = 'started'
  `;
  return new Map(rows.map((r) => [r.plan_slug, Number(r.eff_priority)]));
}

/**
 * The workspace(s) a single sweep covers (Phase E, P-020).
 *
 * One shared operator serves every workspace (D-008), so the single background
 * orchestrator must decide which workspaces to sweep:
 *   - `PAPERCUSP_WORKSPACE_ID` pinned (a dedicated single-workspace process) →
 *     just that one.
 *   - else, in the shared-operator model (`PAPERCUSP_SHARED_OPERATOR=1`, set
 *     only by the new desktop shell) → EVERY registered workspace. Each harness
 *     is still gated by its own concurrency + `maxCostUsd` caps, so cost scales
 *     with opted-in harnesses, not workspace/window count.
 *   - else (dev / legacy) → the single global active workspace — today's
 *     behavior, unchanged (D-009: don't flip the fleet's dispatch scope in dev).
 */
export function orchestratorWorkspaceIds(): string[] {
  const pin = process.env.PAPERCUSP_WORKSPACE_ID?.trim();
  if (pin) return [pin];
  if (process.env.PAPERCUSP_SHARED_OPERATOR === '1') {
    const ids = readRegistry().workspaces.map((w) => w.id).filter(Boolean);
    if (ids.length) return ids;
  }
  return [activeWorkspaceId()];
}

/**
 * One dispatch sweep over the opted-in harnesses (the periodic backstop). In the
 * shared-operator model this sweeps EVERY workspace (P-020); each workspace's
 * harnesses fill their own slots via `dispatchOneHarness`, run inside that
 * workspace's ALS scope so any internal `activeWorkspaceId()` read (e.g.
 * `ensureFeaturePipeline` → `orchestrator-start`) resolves correctly. Returns
 * what was newly started (for logging / tests).
 */
export async function runOrchestratorTick(): Promise<OrchestratorTickResult[]> {
  const adminUrl = getHarnessAdminUrl();
  const out: OrchestratorTickResult[] = [];
  for (const workspaceId of orchestratorWorkspaceIds()) {
    await runWithWorkspace(workspaceId, async () => {
      const slugs = await resolveTickHarnesses(workspaceId);
      for (const slug of slugs) {
        out.push(await dispatchOneHarness(slug, workspaceId, adminUrl));
      }
    });
  }
  return out;
}

/**
 * On-completion refill seam (#1 — continuous dispatch). When a feature pipeline
 * settles, the freed concurrency slot should be filled IMMEDIATELY rather than
 * waiting up to 30s for the next periodic tick. The pipeline workflow calls
 * `setPipelineSettledHook` → this, which re-dispatches just that harness on a
 * fresh event-loop turn (`setImmediate` escapes the completing workflow's
 * async-context so the new pipeline starts as a normal top-level workflow, not a
 * child). Fire-and-forget; the 30s tick remains the backstop if this is missed.
 */
export function refillHarnessOnSettle(slug: string, workspaceId: string): void {
  setImmediate(() => {
    void dispatchOneHarness(slug, workspaceId).catch(() => {});
  });
}

// ── Scheduled workflow ────────────────────────────────────────────────────────
// Registered only when bootstrap imports this module (PAPERCUSP_DBOS_ORCHESTRATOR=1).
// Called directly (no steps): a crashed tick should re-scan fresh on recovery,
// and ensureFeaturePipeline's dedup makes the wholesale re-run safe.
async function orchestratorTickImpl(): Promise<void> {
  const results = await runOrchestratorTick();
  const started = results.flatMap((r) => r.started.map((f) => `${r.harness}:${f}`));
  if (started.length > 0) {
    console.log(`[dbos-orchestrator] started ${started.length} pipeline(s): ${started.join(', ')}`);
  }
}

export const orchestratorTickWorkflow = DBOS.registerWorkflow(orchestratorTickImpl, {
  name: 'orchestratorTick',
  maxRecoveryAttempts: 2,
});

// Every 30s (6-field crontab with seconds). Skip-missed by default — a closed
// desktop doesn't stampede a backlog of ticks on reboot.
//
// Only SCHEDULE the tick in all-mode (`'*'`) or when an explicit allowlist is set
// — otherwise the no-op tick would still record a SUCCESS workflow row every 30s,
// cluttering the DBOS system DB / `/admin/dbos`. With the orchestrator flag on but
// no harnesses opted in, the workflow stays registered (so the manual trigger +
// recovery work) but nothing fires on a timer.
if (shouldScheduleOrchestrator(orchestratorHarnessesEnv())) {
  DBOS.registerScheduled(orchestratorTickWorkflow, {
    name: 'orchestratorTick',
    crontab: '*/30 * * * * *',
  });
}
