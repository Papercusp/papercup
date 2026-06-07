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
 * The dispatch policy is **blueprint-driven** (`autoloop-pot-operator-rebuild-2026-06-05`
 * D-005/D-009, P-006): each harness's *effective blueprint* (the PG cache
 * `harness_shared.blueprints`, lazily projected from the git-canonical
 * `.papercusp/blueprint.yaml`) declares a `dispatch:` section
 * `{ concurrency, priority, readiness, costCapUsd, safetyCeiling }` — so a
 * `coding` harness runs 4 pipelines while `research` runs 1, all declared.
 * Per-install config (`.papercusp/config.json` `parallelWorkers.*` /
 * `maxCostUsd`) overrides the blueprint (instance refines shape); a harness
 * with no blueprint (or no `dispatch:`) keeps the legacy config-only
 * resolution. Enablement is the harness's own blueprint — there is no
 * `director-config.json` / `autoLoop:true` coupling here.
 *
 * The env switches are OVERRIDES, not the policy source (D-009 demotion):
 *   - `PAPERCUSP_DBOS_ORCHESTRATOR=1` — registers the workflow (via bootstrap).
 *   - `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES` — an override switch on WHICH
 *     harnesses are swept: unset/`'*'` → all (the default since P-009);
 *     `none`/`off` → explicit opt-out (e.g. the contended shared dev box); a
 *     comma list → a scoped allowlist. The legacy
 *     `PAPERCUSP_DBOS_DISPATCH_HARNESSES` is still accepted as an alias (D-007).
 *   - `PAPERCUSP_DBOS_MAX_PIPELINES` — OPTIONAL global concurrency ceiling that
 *     clamps every harness (e.g. the shared dev box); unset → each harness uses
 *     its blueprint/config cap up to a hard `SAFETY_CEILING` (#1, D-007: the
 *     ceiling stays imperative code a blueprint can tighten but never raise).
 *
 * Concurrency is per-harness, not a flat global (#1): each harness fills its own
 * slots up to `resolvePerHarnessCap` (from its `parallelWorkers.max` /
 * `maxFeaturesInFlight` config, falling back to the blueprint's declared
 * `dispatch.concurrency`). Two paths feed it: the periodic 30s tick (the backstop
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
import { isLocalDeployment } from '@papercusp/deployment-driver';
// Side-effect: register the cloud backends so the placement gate knows a
// `{target:'latitude'}` harness is REMOTE (skipped here — its frame's own loop owns it).
import '../deployment/configure';
import type { ProjectEntry } from '../harness-registry';
import { readEffectiveHarnessConfig } from '../harness-effective-config';
import {
  durableOwnedFeatureIdsPg,
  configGet,
  evaluateCostCap,
  parallelMaxWorkers,
  maxFeaturesInFlight,
  dispatchAuditorLane,
} from '@papercusp/orchestrator';
import type { AuditorSpawnFn, CreateEscalationFn, HarnessConfig } from '@papercusp/orchestrator';
import type { BlueprintDispatch } from '@papercusp/orchestrator/blueprint';
import { getEffectiveBlueprint } from '../blueprint/project-to-pg';
import { getHarnessAdminUrl } from '../embedded-pg-discovery';
import { backgroundWorkspaceIds } from '../workspace-registry';
import { runWithWorkspace } from '../workspace-als';
import { listAllHarnesses } from '../dev-data';
import { resolveProject } from '../harness-core';
import { convertOpenIssuesToFeatures } from '../promote-issue';
import { loadIssuesOrSeed, saveIssues } from '../harness-issues';
import type { Issue } from '../harness/issue-types';
import { ensureFeaturePipeline } from './orchestrator-start';
import { getFeatureBlockers } from './feature-blockers-edges';
import { getCachedRateLimitConfig } from '../rate-limit-config';

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
 *
 * Since D-005 this is the DEFAULT readiness set — a harness blueprint's
 * `dispatch.readiness` overrides it (and the schema's own default for a declared
 * `dispatch:` is this exact set, so declared-but-unspecified stays equivalent).
 */
const NEEDS_WORK: ReadonlySet<string> = new Set(['todo', 'failing', 'pending', 'failed']);

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
 *   - `parallelWorkers.max` (per-install config) is the worker budget; with one
 *     worker per feature (chunk-loop), that bounds how many features can run at
 *     once. Pass `null` when the config is SILENT — then the blueprint's
 *     declared `dispatch.concurrency` fills the budget (D-005), and 1 is the
 *     floor when neither declares.
 *   - `parallelWorkers.maxFeaturesInFlight`, when set, tightens that further
 *     (cap distinct features below the worker budget) but never widens past it.
 *   - `blueprintSafetyCeiling` (`dispatch.safetyCeiling`) tightens the default
 *     ceiling for this harness shape; it can never RAISE it past the imperative
 *     `SAFETY_CEILING` (D-007 — safety stays deterministic code).
 *   - `envCeiling` (`PAPERCUSP_DBOS_MAX_PIPELINES`) is an optional global clamp
 *     (e.g. the shared dev box) that replaces the resolved ceiling outright (the
 *     operator's explicit box-level override, as before).
 * Always at least 1 (a harness can never be dispatch-starved by config).
 */
export function resolvePerHarnessCap(opts: {
  /** Explicit per-install worker budget, or null when config doesn't set one. */
  parallelMax: number | null;
  maxFeaturesInFlight: number | null;
  envCeiling?: number;
  /** Blueprint-declared `dispatch.concurrency` — fills a silent config (D-005). */
  blueprintConcurrency?: number | null;
  /** Blueprint-declared `dispatch.safetyCeiling` — tighten-only (D-007). */
  blueprintSafetyCeiling?: number | null;
  /** The user's live fleet-wide `maxSimultaneousAgents` (rate-limit-layer-v2 D-004) — a
      per-harness cap can never exceed the whole fleet's budget. Omit/null = no fleet clamp. */
  fleetCap?: number | null;
}): number {
  const declared =
    opts.blueprintConcurrency != null &&
    Number.isFinite(opts.blueprintConcurrency) &&
    opts.blueprintConcurrency > 0
      ? Math.floor(opts.blueprintConcurrency)
      : null;
  const budget =
    opts.parallelMax != null && Number.isFinite(opts.parallelMax)
      ? opts.parallelMax
      : declared ?? 1;
  const base =
    opts.maxFeaturesInFlight != null && opts.maxFeaturesInFlight > 0
      ? Math.min(budget, opts.maxFeaturesInFlight)
      : budget;
  const declaredCeiling =
    opts.blueprintSafetyCeiling != null && opts.blueprintSafetyCeiling > 0
      ? Math.min(Math.floor(opts.blueprintSafetyCeiling), SAFETY_CEILING)
      : SAFETY_CEILING;
  const ceiling = opts.envCeiling && opts.envCeiling > 0 ? opts.envCeiling : declaredCeiling;
  // Fleet-wide clamp (D-004): the live maxSimultaneousAgents bounds every harness's cap (the
  // governor's global gate enforces the precise cross-harness total; this keeps the dispatcher
  // from even ENQUEUEING past the fleet budget). Floor of 1 below keeps dispatch alive.
  const fleetClamped =
    opts.fleetCap != null && Number.isFinite(opts.fleetCap) && opts.fleetCap > 0
      ? Math.min(ceiling, Math.floor(opts.fleetCap))
      : ceiling;
  return Math.max(1, Math.min(base, fleetClamped));
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
 *
 * `readiness` is the dispatchable-status set — the blueprint's declared
 * `dispatch.readiness` (D-005), defaulting to the legacy `NEEDS_WORK` set so an
 * undeclared policy is byte-equivalent to the pre-lift behavior.
 */
export function computeFrontier(
  features: readonly FrontierFeature[],
  planPriority: ReadonlyMap<string, number>,
  owned: ReadonlySet<string>,
  slots: number,
  readiness: ReadonlySet<string> = NEEDS_WORK,
): { toStart: string[]; stuck: boolean } {
  const present = new Set(features.map((f) => f.id));
  const terminal = new Set(features.filter((f) => TERMINAL.has(f.status)).map((f) => f.id));
  const satisfied = (blockerId: string): boolean => !present.has(blockerId) || terminal.has(blockerId);

  const ready = features.filter(
    (f) => readiness.has(f.status) && !owned.has(f.id) && f.blockedBy.every(satisfied),
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
  const pendingWork = features.some((f) => readiness.has(f.status) && !owned.has(f.id));
  return { toStart, stuck: pendingWork && ready.length === 0 };
}

/** Explicit opt-out sentinels (e.g. the shared dev box, to avoid flooding it). */
const DISPATCH_OFF = new Set(['none', 'off']);

/**
 * The harness-scope OVERRIDE switch (D-009: demoted from policy source — the
 * per-harness dispatch policy itself lives on the blueprint). Primary env is
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

export interface HarnessDispatchGate {
  /** Per-harness pipeline concurrency cap (config, else `dispatch.concurrency`). */
  cap: number;
  /** Whether the harness is over its cost cap (config `maxCostUsd`, else `dispatch.costCapUsd`). */
  overCostCap: boolean;
  /** Dispatchable statuses (`dispatch.readiness`; legacy NEEDS_WORK when undeclared). */
  readiness: ReadonlySet<string>;
}

/**
 * Merge the blueprint-declared `dispatch:` policy with the per-install config
 * (D-005 / P-006). Pure — the IO half (`resolveHarnessDispatchGate`) feeds it.
 * Precedence: per-install config overrides the blueprint (instance refines
 * shape); the blueprint fills where config is silent; imperative clamps
 * (`SAFETY_CEILING`, env ceiling) apply on top (D-007).
 *
 * Returns the cap + readiness plus the `effectiveCfg` the cost-cap evaluator
 * should run against: when config has no `maxCostUsd` and the blueprint
 * declares `dispatch.costCapUsd`, the cap is overlaid so `evaluateCostCap`'s
 * whole warn/pause machinery sees one consistent value.
 */
export function resolveDispatchPolicy(opts: {
  dispatch: BlueprintDispatch | null | undefined;
  cfg: HarnessConfig;
  envCeiling?: number;
  /** Live fleet-wide maxSimultaneousAgents (D-004); the IO half passes the cached config. */
  fleetCap?: number | null;
}): { cap: number; readiness: ReadonlySet<string>; effectiveCfg: HarnessConfig } {
  const { dispatch, cfg } = opts;
  // Explicitness matters: `parallelMaxWorkers(cfg)` returns 1 for BOTH "unset"
  // and "set to 1", but only an unset config should defer to the blueprint.
  const explicitParallelMax =
    configGet<number | string | null>(cfg, 'parallelWorkers.max', null) != null
      ? parallelMaxWorkers(cfg)
      : null;
  const cap = resolvePerHarnessCap({
    parallelMax: explicitParallelMax,
    maxFeaturesInFlight: maxFeaturesInFlight(cfg),
    envCeiling: opts.envCeiling,
    blueprintConcurrency: dispatch?.concurrency ?? null,
    blueprintSafetyCeiling: dispatch?.safetyCeiling ?? null,
    fleetCap: opts.fleetCap ?? null,
  });
  const effectiveCfg =
    dispatch?.costCapUsd != null && configGet<number | null>(cfg, 'maxCostUsd', null) == null
      ? ({ ...cfg, maxCostUsd: dispatch.costCapUsd } as HarnessConfig)
      : cfg;
  const readiness: ReadonlySet<string> = dispatch ? new Set(dispatch.readiness) : NEEDS_WORK;
  return { cap, readiness, effectiveCfg };
}

/**
 * Resolve a harness's dispatch gates for one tick (P-006): the harness's
 * EFFECTIVE BLUEPRINT (the PG cache `harness_shared.blueprints`, lazily
 * projected from the git-canonical `.papercusp/blueprint.yaml`) declares the
 * `dispatch:` policy; the per-install `.papercusp/config.json` refines it
 * (`resolveDispatchPolicy`); `evaluateCostCap` checks run-log spend against the
 * effective cost cap. Best-effort at every layer: a missing/corrupt blueprint →
 * the legacy config-only resolution (a non-blueprint harness behaves exactly as
 * before the lift); any resolution/read failure → the safe defaults (`cap: 1`,
 * `overCostCap: false`, legacy readiness) so a bad slug never strands work or
 * floods the box.
 */
async function resolveHarnessDispatchGate(
  pg: ReturnType<typeof postgres>,
  slug: string,
  workspaceId: string,
): Promise<HarnessDispatchGate> {
  try {
    const project = await resolveProject(slug, workspaceId);
    if (!project) return { cap: 1, overCostCap: false, readiness: NEEDS_WORK };
    const stateDir = join(project.path, '.papercusp');
    const logDir = join(stateDir, 'logs');
    // Effective config from the blueprint (⊕ workspace-PG instance overrides), not
    // config.json (deprecate-harness-config-json-2026-06-06).
    const cfg = await readEffectiveHarnessConfig(slug, workspaceId, project.path);
    const dispatch = await getEffectiveBlueprint(pg as never, {
      workspaceId,
      harnessSlug: slug,
      blueprintPath: join(stateDir, 'blueprint.yaml'),
    })
      .then((bp) => bp?.dispatch ?? null)
      .catch(() => null);
    const { cap, readiness, effectiveCfg } = resolveDispatchPolicy({
      dispatch,
      cfg,
      envCeiling: pipelineEnvCeiling(),
      // Live fleet cap (D-004): the user's maxSimultaneousAgents bounds dispatch fleet-wide.
      fleetCap: getCachedRateLimitConfig().maxSimultaneousAgents,
    });
    const overCostCap = evaluateCostCap(effectiveCfg, logDir, stateDir).overCap;
    return { cap, overCostCap, readiness };
  } catch {
    return { cap: 1, overCostCap: false, readiness: NEEDS_WORK };
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
 * P-004 (cloud-deployment-layer-2026-06-06): does the LOCAL orchestrator dispatch
 * this harness, or does its execution plane run on a remote frame (so the frame's
 * own co-located orchestrator loop owns dispatch — D-006)? Consults the deployment
 * driver's placement. Pure + testable. A null project (slug not in this workspace)
 * and every local harness → `true`, so the gate is a NO-OP for all existing
 * harnesses (none carry a non-local deployment); only a harness pinned to a
 * registered REMOTE driver returns `false`.
 */
export function harnessDispatchesLocally(project: Pick<ProjectEntry, 'deployment'> | null): boolean {
  return project == null || isLocalDeployment(project.deployment);
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
  // P-004: consult the deployment driver for placement BEFORE touching PG. A
  // remote-frame harness is dispatched by THAT frame's own orchestrator loop, so
  // the local orchestrator skips it here (the single choke point both the 30s
  // tick and refillHarnessOnSettle funnel through). LocalDriver → local → no
  // change for every existing harness.
  const placementProject = await resolveProject(slug, workspaceId).catch(() => null);
  if (!harnessDispatchesLocally(placementProject)) {
    return { harness: slug, started: [] };
  }
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
    // P-006 (D-005): the gate is blueprint-driven — cap/costCap/readiness come
    // from the harness's effective blueprint `dispatch:` policy, refined by the
    // per-install config.
    const { cap, overCostCap, readiness } = await resolveHarnessDispatchGate(pg, slug, workspaceId);
    const slots = overCostCap ? 0 : Math.max(0, cap - liveCount);
    const { toStart, stuck } = computeFrontier(features, planPriority, owned, slots, readiness);
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
 * orchestrator must decide which workspaces to sweep. The pin → shared-all →
 * global-active policy now lives in `backgroundWorkspaceIds()`
 * (workspace-registry.ts) — the canonical helper every background reader
 * shares (this dispatcher, the await-event sweeper, pot wake-rule boot
 * registration). Each harness is still gated by its own concurrency +
 * `maxCostUsd` caps, so cost scales with opted-in harnesses, not
 * workspace/window count.
 */
export function orchestratorWorkspaceIds(): string[] {
  return backgroundWorkspaceIds();
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
