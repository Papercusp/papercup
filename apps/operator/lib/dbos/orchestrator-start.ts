/**
 * Phase 3 of `dbos-durable-jobs-2026-05-31` — the START side (D-011/D-012).
 *
 * The carve-out filter (`durableOwnedFeatureIdsPg` in the orchestrator's
 * `state-pg.ts`) keeps the GLOBAL orchestrator from deciding for a feature a
 * durable pipeline owns. This module is the other half: it OPTS a feature into
 * durable ownership by starting (or resuming) its pipeline — respecting the
 * workflow-ID-as-claim so a feature is never double-dispatched.
 *
 * Runs in the operator host (where DBOS is launched). Only meaningful when
 * `PAPERCUSP_DBOS_ORCHESTRATOR=1` (the workflow is registered there); otherwise
 * `startFeaturePipeline` has nothing to enqueue on.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { startFeaturePipeline } from './orchestrator-workflow';

/** DBOS statuses that mean a pipeline still OWNS its feature (in-flight). */
const LIVE_STATUSES = new Set(['PENDING', 'ENQUEUED']);

export interface PipelineDecision {
  action: 'reuse' | 'start';
  workflowID: string;
  /** The epoch of the reused (or newly-started) pipeline lifetime. */
  epoch: number;
}

/** Parse the `:e<N>` epoch suffix off a `pipeline:<slug>:<feature>:e<N>` id. */
export function epochOf(workflowID: string): number {
  const m = workflowID.match(/:e(\d+)$/);
  return m ? Number(m[1]) : 0;
}

/**
 * Pure ownership/epoch decision (exported for unit testing). Given the prior
 * pipeline workflows for one feature:
 *  - a still-LIVE (PENDING/ENQUEUED) pipeline → **reuse** it (no double-start);
 *  - otherwise → **start** a fresh epoch = count of prior lifetimes, so the
 *    feature can be re-pipelined after a prior pipeline completed (DBOS will not
 *    re-enqueue a completed id — see `PipelineInput.epoch`).
 *
 * Concurrency is safe even when two callers both decide `start`: the workflow id
 * is deterministic (`pipeline:<slug>:<feature>:e<epoch>`) and the dedup id
 * collapses the duplicate enqueue.
 */
export function decidePipelineStart(
  prior: ReadonlyArray<{ workflowID: string; status: string }>,
  harnessSlug: string,
  featureId: string,
): PipelineDecision {
  const live = prior.find((w) => LIVE_STATUSES.has(w.status));
  if (live) {
    return { action: 'reuse', workflowID: live.workflowID, epoch: epochOf(live.workflowID) };
  }
  const epoch = prior.length;
  return { action: 'start', workflowID: `pipeline:${harnessSlug}:${featureId}:e${epoch}`, epoch };
}

export interface EnsurePipelineResult extends PipelineDecision {
  /** true → a NEW pipeline was enqueued; false → an existing live one owns it. */
  started: boolean;
}

/**
 * Ensure feature `<slug>:<featureId>` has a durable pipeline, respecting
 * ownership. Lists prior pipeline lifetimes from DBOS, reuses a live one if
 * present, else starts a fresh epoch. Idempotent under concurrency.
 */
export async function ensureFeaturePipeline(
  harnessSlug: string,
  featureId: string,
): Promise<EnsurePipelineResult> {
  // `:e` suffix on the prefix disambiguates F-1 from F-12 (F-12's id continues
  // with `2:e…`, not `:e…`), so this returns only THIS feature's pipelines.
  const prior = await DBOS.listWorkflows({
    workflow_id_prefix: `pipeline:${harnessSlug}:${featureId}:e`,
  });
  const decision = decidePipelineStart(
    prior.map((w) => ({ workflowID: w.workflowID, status: w.status })),
    harnessSlug,
    featureId,
  );
  if (decision.action === 'start') {
    // Capture the workspace NOW so the whole pipeline resolves in it, immune to a
    // later active-workspace switch (which would otherwise null `resolveProject`).
    await startFeaturePipeline({
      harnessSlug,
      featureId,
      epoch: decision.epoch,
      workspaceId: activeWorkspaceId(),
    });
  }
  return { ...decision, started: decision.action === 'start' };
}
