/**
 * Phase 3 AUTO-dispatcher (dbos-durable-jobs-2026-05-31). When durable
 * orchestration is enabled, this periodically scans the opted-in harnesses for
 * features that need work and starts a durable pipeline per feature (up to a
 * concurrency cap) — the production counterpart to the manual
 * `POST /admin/dbos/pipeline/start` trigger.
 *
 * Double-gated for safety:
 *   - `PAPERCUSP_DBOS_ORCHESTRATOR=1` — registers the workflow (via bootstrap).
 *   - `PAPERCUSP_DBOS_DISPATCH_HARNESSES=slug,slug` — which harnesses opt in
 *     (empty → the tick is a no-op, so enabling the orchestrator flag alone
 *     never auto-starts agent work).
 *   - `PAPERCUSP_DBOS_MAX_PIPELINES` — concurrency cap (default 4).
 *
 * The carve-out (`readFeaturesPg` → `durableOwnedFeatureIdsPg`) already excludes
 * features a live pipeline owns, so a re-scan only ever picks NEW work; combined
 * with `ensureFeaturePipeline`'s dedup, the tick is idempotent and safe to re-run
 * wholesale on recovery (we WANT a fresh re-scan, not a cached replay — hence the
 * scheduled workflow calls the tick directly rather than through steps).
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import postgres from 'postgres';
import { readFeaturesPg } from '@papercusp/orchestrator';
import { getHarnessAdminUrl } from '@/lib/embedded-pg-discovery';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { listAllHarnesses } from '@/lib/dev-data';
import { ensureFeaturePipeline } from './orchestrator-start';

/**
 * Feature statuses that warrant starting a durable pipeline. The live vocabulary
 * is `todo` (not started) / `failing` (failed validation, needs rework); the
 * `pending`/`failed` aliases from the FeatureRecord type are kept for safety.
 * `in_progress` is excluded (already being worked), as are `passed`/`blocked`/
 * `deprecated`/`proposed`.
 */
const NEEDS_WORK = new Set(['todo', 'failing', 'pending', 'failed']);
const DEFAULT_CAP = 4;

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

/**
 * Resolve which harnesses the dispatcher serves from the env value + the full
 * workspace harness list (P-006). Pure (testable):
 *   - `'*'` → ALL harnesses in the workspace (the default-on-for-all rollout);
 *   - an explicit comma list → that allowlist (scoped testing override);
 *   - empty / unset → none (safe until the Phase-G flip makes `'*'` the default).
 */
export function resolveDispatchHarnesses(
  envRaw: string | undefined,
  allSlugs: string[],
): string[] {
  const v = (envRaw ?? '').trim();
  if (v === '*') return allSlugs;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Whether to arm the 30s scheduled tick: all-mode (`'*'`) or a non-empty allowlist. */
export function shouldScheduleDispatch(envRaw: string | undefined): boolean {
  const v = (envRaw ?? '').trim();
  return v === '*' || v.split(',').some((s) => s.trim().length > 0);
}

/**
 * The concrete harness slugs to sweep this tick. In all-mode (`'*'`) enumerate
 * every harness in the active workspace; otherwise use the explicit allowlist.
 */
async function resolveTickHarnesses(workspaceId: string): Promise<string[]> {
  const envRaw = process.env.PAPERCUSP_DBOS_DISPATCH_HARNESSES;
  if ((envRaw ?? '').trim() !== '*') {
    return resolveDispatchHarnesses(envRaw, []);
  }
  try {
    const { harnesses } = await listAllHarnesses([workspaceId]);
    return harnesses.map((h) => h.slug);
  } catch {
    return [];
  }
}

function maxPipelines(): number {
  const n = Number(process.env.PAPERCUSP_DBOS_MAX_PIPELINES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CAP;
}

/** Count live (PENDING/ENQUEUED) pipelines for one harness. */
async function liveCountFor(harnessSlug: string): Promise<number> {
  const live = await DBOS.listWorkflows({
    workflow_id_prefix: `pipeline:${harnessSlug}:`,
    status: ['PENDING', 'ENQUEUED'],
  });
  return live.length;
}

export interface DispatchTickResult {
  harness: string;
  started: string[];
}

/**
 * One dispatch sweep over the opted-in harnesses. Per harness: read eligible
 * (non-owned) features, pick the ones needing work within the free slots, and
 * `ensureFeaturePipeline` each. Returns what was newly started (for logging /
 * tests). A per-harness failure is isolated (logged-as-empty, never throws).
 */
export async function runDispatchTick(): Promise<DispatchTickResult[]> {
  const workspaceId = activeWorkspaceId();
  const slugs = await resolveTickHarnesses(workspaceId);
  if (slugs.length === 0) return [];
  const cap = maxPipelines();
  const adminUrl = getHarnessAdminUrl();
  const out: DispatchTickResult[] = [];

  for (const slug of slugs) {
    const pg = postgres(adminUrl, {
      max: 1,
      connect_timeout: 5,
      connection: { search_path: `harness_${slug},harness_shared,public` },
    });
    try {
      const eligible = await readFeaturesPg({ pg: pg as never, workspaceId, harnessSlug: slug });
      const liveCount = await liveCountFor(slug);
      const toStart = selectFeaturesToDispatch(
        eligible.map((f) => ({ id: f.id, status: f.status })),
        liveCount,
        cap,
      );
      const started: string[] = [];
      for (const fid of toStart) {
        const r = await ensureFeaturePipeline(slug, fid);
        if (r.started) started.push(fid);
      }
      out.push({ harness: slug, started });
    } catch {
      // Per-harness isolation: a bad slug / unreachable schema doesn't sink the sweep.
      out.push({ harness: slug, started: [] });
    } finally {
      await pg.end({ timeout: 2 }).catch(() => {});
    }
  }
  return out;
}

// ── Scheduled workflow ────────────────────────────────────────────────────────
// Registered only when bootstrap imports this module (PAPERCUSP_DBOS_ORCHESTRATOR=1).
// Called directly (no steps): a crashed tick should re-scan fresh on recovery,
// and ensureFeaturePipeline's dedup makes the wholesale re-run safe.
async function dispatchTickWorkflow(): Promise<void> {
  const results = await runDispatchTick();
  const started = results.flatMap((r) => r.started.map((f) => `${r.harness}:${f}`));
  if (started.length > 0) {
    console.log(`[dbos-dispatch] started ${started.length} pipeline(s): ${started.join(', ')}`);
  }
}

export const orchestratorDispatchWorkflow = DBOS.registerWorkflow(dispatchTickWorkflow, {
  name: 'orchestratorDispatch',
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
if (shouldScheduleDispatch(process.env.PAPERCUSP_DBOS_DISPATCH_HARNESSES)) {
  DBOS.registerScheduled(orchestratorDispatchWorkflow, {
    name: 'orchestratorDispatch',
    crontab: '*/30 * * * * *',
  });
}
