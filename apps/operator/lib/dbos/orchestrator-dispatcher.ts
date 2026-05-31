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
import { ensureFeaturePipeline } from './orchestrator-start';

/** Feature statuses that warrant starting (or continuing) a durable pipeline. */
const NEEDS_WORK = new Set(['pending', 'failed']);
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
): string[] {
  const slots = Math.max(0, cap - liveCount);
  if (slots <= 0) return [];
  return eligible
    .filter((f) => NEEDS_WORK.has(f.status))
    .slice(0, slots)
    .map((f) => f.id);
}

function dispatchHarnesses(): string[] {
  return (process.env.PAPERCUSP_DBOS_DISPATCH_HARNESSES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
  const slugs = dispatchHarnesses();
  if (slugs.length === 0) return [];
  const cap = maxPipelines();
  const workspaceId = activeWorkspaceId();
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
// Only SCHEDULE the tick when at least one harness is opted in — otherwise the
// no-op tick would still record a SUCCESS workflow row every 30s, cluttering the
// DBOS system DB / `/admin/dbos`. With the orchestrator flag on but no harnesses
// opted in (the rollout-ready state), the workflow stays registered (so the
// manual trigger + recovery work) but nothing fires on a timer.
if (dispatchHarnesses().length > 0) {
  DBOS.registerScheduled(orchestratorDispatchWorkflow, {
    name: 'orchestratorDispatch',
    crontab: '*/30 * * * * *',
  });
}
