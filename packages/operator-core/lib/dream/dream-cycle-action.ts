/** `system:dream-cycle` routine action (REM dreaming P-005 / D-001). */
import { randomUUID } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { registerSystemAction, type SystemActionCtx } from '../harness/routines/system-actions';
import { idleActivityAllowed } from '../owner-steering';
import { readHiveIdleRatio } from '../scout/cadence-signals';
import type { ScoutLlmCall } from '../scout/types';
import { resolveDreamCycleConfig, type DreamCycleConfig } from './dream-config';
import { runDreamCycle, type DreamCycleInput, type DreamCycleResult } from './dream-cycle';
import type { DreamRunMode } from './dream-run-store';

export const DREAM_CYCLE_ACTION = 'dream-cycle';

export interface DreamCycleActionConfig extends Pick<DreamCycleInput, 'cycle' | 'sampler' | 'pass' | 'review'> {
  mode: DreamRunMode;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function parseDreamCycleActionConfig(payload: Record<string, unknown> | null): DreamCycleActionConfig {
  const root = object(payload) ?? {};
  const mode = root.mode ?? 'manual';
  if (mode !== 'manual' && mode !== 'auto') throw new RangeError(`unsupported dream-cycle mode ${String(mode)}`);
  return {
    mode,
    ...(object(root.cycle) ? { cycle: object(root.cycle) as Partial<DreamCycleConfig> } : {}),
    ...(object(root.sampler) ? { sampler: object(root.sampler)! } : {}),
    ...(object(root.pass) ? { pass: object(root.pass)! } : {}),
    ...(object(root.review) ? { review: object(root.review)! } : {}),
  };
}

export interface DreamCycleActionDeps {
  featureEnabled: () => Promise<boolean>;
  idleAllowed: (workspaceId: string, potSlug: string) => Promise<boolean>;
  readIdleRatio: (workspaceId: string) => Promise<number>;
  runCycle: (ctx: SystemActionCtx, config: DreamCycleActionConfig) => Promise<DreamCycleResult>;
  log: (message: string) => void;
}

const defaultActionDeps: DreamCycleActionDeps = {
  featureEnabled: () => getFlag(FLAGS.DREAM_CYCLE, 'dream-cycle'),
  idleAllowed: (workspaceId, potSlug) => idleActivityAllowed(workspaceId, 'dream', potSlug),
  readIdleRatio: (workspaceId) => readHiveIdleRatio({ workspaceId }),
  runCycle: productionDreamCycle,
  log: (message) => console.log(`[dream-cycle] ${message}`),
};

export function makeDreamCycleAction(overrides: Partial<DreamCycleActionDeps> = {}) {
  const deps = { ...defaultActionDeps, ...overrides };
  return async function dreamCycleAction(ctx: SystemActionCtx): Promise<void> {
    if (!(await deps.featureEnabled())) {
      deps.log(`${ctx.installSlug}: skipped — DREAM_CYCLE feature flag is OFF`);
      return;
    }
    const config = parseDreamCycleActionConfig(ctx.payloadTemplate);
    if (config.mode === 'auto') {
      if (!(await deps.idleAllowed(ctx.workspaceId, ctx.installSlug))) {
        deps.log(`${ctx.installSlug}: skipped — owner idle-activity toggle (dream) is OFF`);
        return;
      }
      const idleRatio = await deps.readIdleRatio(ctx.workspaceId);
      const floor = resolveDreamCycleConfig(config.cycle).autoIdleRatioFloor;
      if (idleRatio < floor) {
        deps.log(`${ctx.installSlug}: skipped — idle ratio ${idleRatio.toFixed(2)} < ${floor.toFixed(2)}`);
        return;
      }
    }
    const result = await deps.runCycle(ctx, config);
    deps.log(
      `${ctx.installSlug}: ${result.reason} cycle=${result.cycleId} attempts=${result.attempts} accepted=${result.accepted} cost=$${result.costUsd.toFixed(4)}`,
    );
  };
}

function stableCycleId(ctx: SystemActionCtx): string {
  return DBOS.workflowID?.trim() || `dream-cycle:${ctx.workspaceId}:${ctx.installSlug}:${randomUUID()}`;
}

/** Lazily assemble production adapters so boot-time registration stays IO-free. */
export async function productionDreamCycle(
  ctx: SystemActionCtx,
  config: DreamCycleActionConfig,
): Promise<DreamCycleResult> {
  if (await getFlag(FLAGS.INFERENCE_GATEWAY, 'system')) {
    const { gatewayLlmEnv } = await import('../inference-gateway/spawn-env');
    for (const [key, value] of Object.entries(gatewayLlmEnv(true))) {
      if (!process.env[key]) process.env[key] = value;
    }
  }
  const [{ getOrgPg }, llm, sources, governor, store, corpus] = await Promise.all([
    import('@papercusp/db-org'),
    import('../llm-testing/llm-client'),
    import('./dream-sources'),
    import('./dream-governor'),
    import('./dream-run-store'),
    import('../scout/cycle-deps'),
  ]);
  const { sql } = getOrgPg();
  const cycleId = stableCycleId(ctx);
  const llmCall: ScoutLlmCall = (input) =>
    llm.llmCall({ ...input, priority: 'scout', harnessSlug: ctx.installSlug });

  return runDreamCycle(
    {
      workspaceId: ctx.workspaceId,
      potSlug: ctx.installSlug,
      mode: config.mode,
      cycleId,
      cycle: config.cycle,
      sampler: config.sampler,
      pass: config.pass,
      review: config.review,
    },
    {
      llmCall,
      preflight: () =>
        governor.preflightDreamCycle(sql, {
          workspaceId: ctx.workspaceId,
          potSlug: ctx.installSlug,
          config: config.cycle,
        }),
      loadSources: () =>
        sources.readDreamSources({
          sql,
          workspaceId: ctx.workspaceId,
          potSlug: ctx.installSlug,
          sampler: config.sampler,
        }),
      readCorpus: async (fragments) => {
        const combined = [...(await corpus.readNoveltyCorpus()), ...sources.dreamCorpusFromFragments(fragments)];
        return [...new Map(combined.map((entry) => [entry.ref, entry])).values()];
      },
      beginRun: ({ runId }) =>
        store.beginDreamRun(sql, {
          workspaceId: ctx.workspaceId,
          runId,
          cycleId,
          potSlug: ctx.installSlug,
          mode: config.mode,
        }),
      recordSelection: ({ runId, pair, dreamerModel }) =>
        store.recordDreamRunSelection(sql, {
          workspaceId: ctx.workspaceId,
          runId,
          pair,
          dreamerModel,
        }),
      finalizeRun: (input) =>
        store.finalizeDreamRun(sql, {
          ...input,
          workspaceId: ctx.workspaceId,
        }),
      recordSpend: (run) =>
        governor.recordDreamRunSpend(sql, {
          workspaceId: ctx.workspaceId,
          runId: run.runId,
          potSlug: ctx.installSlug,
        }),
    },
  );
}

registerSystemAction(DREAM_CYCLE_ACTION, makeDreamCycleAction());
