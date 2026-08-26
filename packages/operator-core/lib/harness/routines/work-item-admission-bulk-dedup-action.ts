/** Durable one-shot system action for work-item admission P-006 bulk convergence. */
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { gatewayLlmEnv } from '../../inference-gateway/spawn-env';
import { notifySyncInvalidate } from '../../sync-sse';
import {
  runWorkItemAdmissionBulkDedup,
  WORK_ITEM_ADMISSION_BULK_DEDUP,
  type BulkDedupRunResult,
} from '../../work-items-admission-bulk-dedup';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`bulk dedup expected a positive integer, received ${String(value)}`);
  }
  return n;
}

export interface AdmissionBulkDedupActionDeps {
  run: (ctx: SystemActionCtx) => Promise<BulkDedupRunResult>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

async function productionRun(ctx: SystemActionCtx): Promise<BulkDedupRunResult> {
  if (process.env.VITEST) throw new Error('production bulk dedup action must not run from a unit test');
  const payload = ctx.payloadTemplate ?? {};
  const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
  if (!runId) throw new Error('work-item admission bulk dedup action requires payload.runId');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const { llmCall } = await import('../../llm-testing/llm-client');
  return runWorkItemAdmissionBulkDedup({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId,
    maxStages: optionalPositiveInteger(payload.maxStages),
    pairsPerCall: optionalPositiveInteger(payload.pairsPerCall),
    shardConcurrency: optionalPositiveInteger(payload.shardConcurrency),
    census: {
      targetTokens: optionalPositiveInteger(payload.targetTokens),
      ceilingTokens: optionalPositiveInteger(payload.ceilingTokens),
      chunkCount: optionalPositiveInteger(payload.chunkCount),
      fullCorpusPairThreshold: optionalPositiveInteger(payload.fullCorpusPairThreshold),
    },
    llmCall: (input) => llmCall({ ...input, priority: 'scout' }),
  });
}

async function invalidateAdmissionRuns(): Promise<void> {
  await notifySyncInvalidate('workItemAdmission.runs');
}

export function makeWorkItemAdmissionBulkDedupAction(overrides: Partial<AdmissionBulkDedupActionDeps> = {}) {
  const deps: AdmissionBulkDedupActionDeps = {
    run: productionRun,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_BULK_DEDUP}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    await deps.invalidate();
    deps.log(
      `${ctx.installSlug}: run=${result.runId} scope=${result.scope} stages=${result.stages.length} ` +
        `census=${result.initialCensus}->${result.finalCensus} convergence=${result.convergenceReason}`,
    );
  };
}

registerSystemAction(WORK_ITEM_ADMISSION_BULK_DEDUP, makeWorkItemAdmissionBulkDedupAction(), {
  scheduling: 'on-demand',
});
