/**
 * dev:worker_chunk_loop_metrics — the monitoring surface for the operator-hosted
 * `worker:chunk-loop` rollout (worker-chunk-loop-operator-hosted-2026-06-14 P-020).
 *
 * Reads the per-run outcome records (harness_shared.worker_chunk_loop_outcomes, migration
 * 397 + 428) and returns ALL SIX P-020 metrics split by execution PATH — the subprocess
 * path vs the operator-hosted op — plus the op−subprocess completion-rate delta:
 *   1. feature COMPLETION RATE
 *   2. outcome DISTRIBUTION (completed/escalated/planning_failed/aborted)
 *   3. file-lock CONTENTION (lockContentionCount/Rate — aborted runs that hit
 *      CHUNK_LOCK_TIMEOUT_MS waiting on a chunk's file claim)
 *   4. REPLAN frequency across ALL runs, not just escalated ones (avgTotalReplans,
 *      replanRate — the share of runs needing >=1 replan)
 *   5. crash-RESUME success (resumedCount, resumedCompletionRate — completion rate
 *      among runs that resumed a persisted plan after a crash/restart)
 *   6. per-chunk DURABILITY (perChunkDurability — committed/planned chunk ratio across
 *      every run that reported a plan size, even ones that didn't fully complete)
 * This is what the Phase-1 dark-launch parity diff reads and what the Phase-2 ramp gates
 * on (advance only when op metrics are at-or-better than the subprocess baseline).
 *
 * Best-effort / degrade-clean: pre-migration (table absent, 42P01) returns the zeroed
 * empty metrics, not an error — so the tool is safe to call before the dark-launch has
 * produced any rows. Rows written before migration 428 simply read null/0 for the three
 * newer metrics rather than skewing the ratios.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  readWorkerChunkOutcomes,
  summarizeWorkerChunkOutcomes,
  decideRampAdvance,
  type ChunkLoopOutcomeRecord,
  type OrchestratorPg,
  type RampStep,
} from '@papercusp/orchestrator';

export default defineTool({
  name: 'dev:worker_chunk_loop_metrics',
  description:
    'Monitoring metrics for the operator-hosted worker:chunk-loop rollout (P-020), all six gate metrics: feature completion RATE, outcome DISTRIBUTION (completed/escalated/planning_failed/aborted), file-lock CONTENTION rate, replan FREQUENCY across all runs, crash-RESUME success rate, and per-chunk DURABILITY — split by execution PATH (subprocess vs the operator-hosted op) — plus the op−subprocess completion-rate delta. Reads harness_shared.worker_chunk_loop_outcomes for the active workspace over a lookback window. EMPTY (zeroed) until the dark-launch (per-harness workerChunkLoop knob) has run real features through the op path. Use to diff op vs subprocess parity before/while ramping.',
  guidance: {
    when: 'Watch worker:chunk-loop dark-launch / ramp health — is the operator-hosted op at parity with the subprocess path on completion-rate + outcome distribution? Read before approving a ramp step.',
    notWhen: 'Live rate-limit pacing — dev:rate_governor_status. Per-feature chunk progress — the harness UI / harness_chunk_plans. Whether the op path is ROUTED on a harness — check the per-harness workerChunkLoop config knob.',
  },
  capability: 'intel:read',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger', 'overwatch', 'bee'],
  args: z.object({
    windowHours: z
      .number()
      .min(0.1)
      .max(24 * 90)
      .optional()
      .describe('Lookback window in hours over which to aggregate outcomes (default 168 = 1 week).'),
    harnessSlug: z
      .string()
      .optional()
      .describe('Restrict to one harness (the dark-launched one). Omit for all harnesses in the workspace.'),
    sampleLimit: z
      .number()
      .int()
      .min(0)
      .max(50)
      .optional()
      .describe('Include up to N most-recent raw records for inspection (default 0).'),
    rampStep: z
      .union([z.literal(0), z.literal(25), z.literal(50), z.literal(100)])
      .optional()
      .describe('Current ramp cohort % (0|25|50|100). When set, include the deterministic ramp-gate recommendation (advance/hold/rollback, P-021) for this step.'),
  }),
  async handler(args) {
    const windowHours = args.windowHours ?? 168;
    const sinceMs = Date.now() - windowHours * 3_600_000;
    const { routeWithWorkspace } = await import('../../route-workspace');
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const ws = activeWorkspaceId();

    let rows: ChunkLoopOutcomeRecord[] = [];
    try {
      rows = await routeWithWorkspace(async (tx) =>
        readWorkerChunkOutcomes(
          { pg: tx as unknown as OrchestratorPg, workspaceId: ws },
          { sinceMs, harnessSlug: args.harnessSlug },
        ),
      );
    } catch (err) {
      // Pre-migration the table doesn't exist (42P01) → the clean empty state, not a 500.
      const code = (err as { code?: string })?.code;
      const msg = err instanceof Error ? err.message : String(err);
      if (code !== '42P01' && !/does not exist/i.test(msg)) {
        console.warn('[dev:worker_chunk_loop_metrics] read failed:', msg);
      }
    }

    const metrics = summarizeWorkerChunkOutcomes(rows);
    const sampleLimit = args.sampleLimit ?? 0;
    const rampRecommendation =
      args.rampStep !== undefined ? decideRampAdvance(metrics, args.rampStep as RampStep) : undefined;
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            workspaceId: ws,
            windowHours,
            harnessSlug: args.harnessSlug ?? null,
            totalRows: rows.length,
            metrics,
            rampRecommendation,
            sample: sampleLimit > 0 ? rows.slice(0, sampleLimit) : undefined,
          }),
        },
      ],
    };
  },
});
