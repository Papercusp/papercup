/** Durable system actions for work-item admission P-003/P-004. */
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { captureImprovement } from '../improvements/capture-core';
import { notifySyncInvalidate } from '../../sync-sse';
import {
  DEFAULT_PROMOTER_BATCH_SIZE,
  DEFAULT_PROMOTER_LIVENESS_MINUTES,
  DEFAULT_PROMOTER_TICK_MINUTES,
  runWorkItemAdmissionFailOpen,
  runWorkItemAdmissionPromoter,
  WORK_ITEM_ADMISSION_FAIL_OPEN,
  WORK_ITEM_ADMISSION_PROMOTER,
  type FailOpenRunResult,
  type PromoterRunResult,
} from '../../work-items-admission-promoter';
import { registerSystemAction, type SystemActionCtx } from './system-actions';

function positiveInteger(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function runId(action: string): string {
  return DBOS.workflowID?.trim() || `${action}:${randomUUID()}`;
}

export interface AdmissionPromoterActionDeps {
  run: (ctx: SystemActionCtx) => Promise<PromoterRunResult>;
  alarm: (ctx: SystemActionCtx, result: PromoterRunResult) => Promise<void>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

async function productionPromoter(ctx: SystemActionCtx): Promise<PromoterRunResult> {
  if (process.env.VITEST) throw new Error('production admission promoter must not run from a unit test');
  const payload = ctx.payloadTemplate ?? {};
  if (process.env.PAPERCUSP_WORK_ITEM_ADMISSION_PROMOTER === 'off') {
    throw new Error('work-item admission promoter is disabled by PAPERCUSP_WORK_ITEM_ADMISSION_PROMOTER=off');
  }
  const { getFlag } = await import('@papercusp/flags/server');
  const { FLAGS } = await import('@papercusp/flags');
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    const { gatewayLlmEnv } = await import('../../inference-gateway/spawn-env');
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const { llmCall } = await import('../../llm-testing/llm-client');
  return runWorkItemAdmissionPromoter({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId: runId(WORK_ITEM_ADMISSION_PROMOTER),
    batchSize: positiveInteger(payload.batchSize, DEFAULT_PROMOTER_BATCH_SIZE),
    recentTerminalDays: positiveInteger(payload.recentTerminalDays, 30),
    llmCall: (input) => llmCall({ ...input, priority: 'scout' }),
  });
}

async function productionCensusRiseAlarm(ctx: SystemActionCtx, result: PromoterRunResult): Promise<void> {
  if (result.censusAfter <= result.censusBefore) return;
  const delta = result.censusAfter - result.censusBefore;
  await captureImprovement({
    title: `Work-item admission census rose for ${ctx.installSlug}`,
    kind: 'bug',
    severity: 'major',
    body:
      `The unadjudicated >=0.90 pair census rose by ${delta} during promoter run ${result.runId} ` +
      `(${result.censusBefore} -> ${result.censusAfter}). This violates the monotone non-increase ` +
      `contract: every adjudication should retire a pair permanently. Inspect the run in ` +
      `/admin/admission and repair the writer or adjudication coverage before the next bulk pass.`,
    foundDuring: `${WORK_ITEM_ADMISSION_PROMOTER} routine`,
    dedupScope: 'open',
    watchdogKey: `work-item-admission-census-rise:${ctx.installSlug}`,
  });
}

async function invalidateAdmissionRuns(): Promise<void> {
  await notifySyncInvalidate('workItemAdmission.runs');
}

export function makeWorkItemAdmissionPromoterAction(overrides: Partial<AdmissionPromoterActionDeps> = {}) {
  const deps: AdmissionPromoterActionDeps = {
    run: productionPromoter,
    alarm: productionCensusRiseAlarm,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_PROMOTER}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    await deps.invalidate();
    if (result.censusAfter > result.censusBefore) await deps.alarm(ctx, result);
    deps.log(
      `${ctx.installSlug}: run=${result.runId} batch=${result.batchSize} pairs=${result.flaggedPairs} ` +
        `promoted=${result.promoted} merged=${result.merged} held=${result.held}`,
    );
  };
}

export interface AdmissionFailOpenActionDeps {
  run: (ctx: SystemActionCtx) => Promise<FailOpenRunResult>;
  alarm: (ctx: SystemActionCtx, result: FailOpenRunResult) => Promise<void>;
  invalidate: () => Promise<void>;
  log: (message: string) => void;
}

async function productionFailOpen(ctx: SystemActionCtx): Promise<FailOpenRunResult> {
  const payload = ctx.payloadTemplate ?? {};
  return runWorkItemAdmissionFailOpen({
    workspaceId: ctx.workspaceId,
    harnessSlug: ctx.installSlug,
    runId: runId(WORK_ITEM_ADMISSION_FAIL_OPEN),
    tickMinutes: positiveInteger(payload.tickMinutes, DEFAULT_PROMOTER_TICK_MINUTES),
    staleMinutes: positiveInteger(payload.staleMinutes, DEFAULT_PROMOTER_LIVENESS_MINUTES),
  });
}

async function productionLivenessAlarm(ctx: SystemActionCtx, result: FailOpenRunResult): Promise<void> {
  if (!result.liveness.stale) return;
  await captureImprovement({
    title: `Work-item admission promoter is stale for ${ctx.installSlug}`,
    kind: 'bug',
    severity: 'major',
    body:
      `${result.liveness.reason}. The independent fail-open action remains live and admitted ` +
      `${result.autoPromoted.length} row(s) as admission='unreviewed' on this tick, so queue ` +
      `distribution is not silently starved. Restore the durable ${WORK_ITEM_ADMISSION_PROMOTER} ` +
      `routine and verify a detail.mode='promoter', detail.status='complete' admission_runs row.`,
    foundDuring: `${WORK_ITEM_ADMISSION_FAIL_OPEN} routine`,
    dedupScope: 'open',
    watchdogKey: `work-item-admission-promoter-liveness:${ctx.installSlug}`,
  });
}

export function makeWorkItemAdmissionFailOpenAction(overrides: Partial<AdmissionFailOpenActionDeps> = {}) {
  const deps: AdmissionFailOpenActionDeps = {
    run: productionFailOpen,
    alarm: productionLivenessAlarm,
    invalidate: invalidateAdmissionRuns,
    log: (message) => console.log(`[${WORK_ITEM_ADMISSION_FAIL_OPEN}] ${message}`),
    ...overrides,
  };
  return async (ctx: SystemActionCtx): Promise<void> => {
    const result = await deps.run(ctx);
    await deps.invalidate();
    if (result.liveness.stale) await deps.alarm(ctx, result);
    deps.log(
      `${ctx.installSlug}: run=${result.runId} auto-promoted=${result.autoPromoted.length} ` +
        `liveness=${result.liveness.stale ? 'STALE' : 'healthy'} (${result.liveness.reason})`,
    );
  };
}

registerSystemAction(WORK_ITEM_ADMISSION_PROMOTER, makeWorkItemAdmissionPromoterAction());
registerSystemAction(WORK_ITEM_ADMISSION_FAIL_OPEN, makeWorkItemAdmissionFailOpenAction());
