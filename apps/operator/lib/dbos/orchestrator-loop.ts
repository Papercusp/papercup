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
 * The carve-out (`readFeaturesPg` → `durableOwnedFeatureIdsPg`) already excludes
 * features a live pipeline owns, so a re-scan only ever picks NEW work; combined
 * with `ensureFeaturePipeline`'s dedup, the tick is idempotent and safe to re-run
 * wholesale on recovery (we WANT a fresh re-scan, not a cached replay — hence the
 * scheduled workflow calls the tick directly rather than through steps).
 */
import { join } from 'node:path';
import { DBOS } from '@dbos-inc/dbos-sdk';
import postgres from 'postgres';
import {
  readFeaturesPg,
  readConfig,
  evaluateCostCap,
  parallelMaxWorkers,
  maxFeaturesInFlight,
} from '@papercusp/orchestrator';
import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { listAllHarnesses } from '@/lib/dev-data';
import { resolveProject } from '@/lib/harness-core';
import { ensureFeaturePipeline } from './orchestrator-start';

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

/**
 * Pure selection (exported for unit testing): from the eligible (already
 * carve-out-filtered, non-owned) features, pick those needing work, bounded by
 * the free pipeline slots (`cap - liveCount`).
 */
export function selectFeaturesToDispatch(
  eligible: ReadonlyArray<{ id: string; status: string }>,
  liveCount: number,
  cap: number,
  overCostCap = false,
): string[] {
  // Cost-cap gate (P-004): a harness over its configured maxCostUsd starts NO new
  // pipelines (in-flight ones finish). Mirrors the legacy loop's spend ceiling.
  if (overCostCap) return [];
  const slots = Math.max(0, cap - liveCount);
  if (slots <= 0) return [];
  return eligible
    .filter((f) => NEEDS_WORK.has(f.status))
    .slice(0, slots)
    .map((f) => f.id);
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
 * Resolve the harness's `.harness/config.json` ONCE and derive both dispatch
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
    const stateDir = join(project.path, '.harness');
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
    const eligible = await readFeaturesPg({ pg: pg as never, workspaceId, harnessSlug: slug });
    const liveCount = await liveCountFor(slug);
    const { cap, overCostCap } = await resolveHarnessDispatchGate(slug, workspaceId);
    const toStart = selectFeaturesToDispatch(
      eligible.map((f) => ({ id: f.id, status: f.status })),
      liveCount,
      cap,
      overCostCap,
    );
    if (overCostCap) console.log(`[dbos-orchestrator] ${slug} over maxCostUsd — skipping new pipelines`);
    const started: string[] = [];
    for (const fid of toStart) {
      const r = await ensureFeaturePipeline(slug, fid);
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
 * One dispatch sweep over the opted-in harnesses (the periodic backstop). Each
 * harness fills its own slots via `dispatchOneHarness`. Returns what was newly
 * started (for logging / tests).
 */
export async function runOrchestratorTick(): Promise<OrchestratorTickResult[]> {
  const workspaceId = activeWorkspaceId();
  const slugs = await resolveTickHarnesses(workspaceId);
  if (slugs.length === 0) return [];
  const adminUrl = getHarnessAdminUrl();
  const out: OrchestratorTickResult[] = [];
  for (const slug of slugs) {
    out.push(await dispatchOneHarness(slug, workspaceId, adminUrl));
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
