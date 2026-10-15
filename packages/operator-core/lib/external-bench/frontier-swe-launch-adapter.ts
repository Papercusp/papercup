/** D-026..D-033: the FrontierSWE runAgent composes the maintained native su driver.
 * The host registers an observer checkout; the pinned Codex binary edits /app INSIDE the
 * task container. Grading remains owned by the FrontierSWE seam, never this adapter.
 */
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { createCurrentSuBenchHarness, CURRENT_STOCK_CODEX_BLUEPRINT, type CurrentSuBenchObservations, type CurrentSuBenchOptions } from './current-su';
import { createCurrentStockBenchHarness } from './native-harness-runner';
import { startBenchEgress, sweepBenchEgress, type BenchEgress, type BenchEgressConfig } from './bench-egress';
import { startCodexHookBridge, type CodexHookBridge } from './codex-hook-bridge';
import { validateDockerExecTarget, type DockerExecTarget } from './container-exec-target';
import { makeFrontierSweCloneGradeSeam, type FrontierSweEnvHandle, type FrontierSweSeamConfig } from './frontier-swe-seam';
import { FULL_SPINE_BLUEPRINT, type BenchHarnessDriver } from './run-loop';
import { generationStatusForStopReason, type GenerationBudget, type TaskCheckout } from './types';
import type { AgentRunOutput, RunAgentInput } from './run-topology';
import type { CurrentBenchTaskRequestCensus } from './run-launcher';
import { assertBenchWorkspace } from './bench-workspace';

export interface FrontierSweNativeAssignment {
  options: CurrentSuBenchOptions;
  observations: CurrentSuBenchObservations;
  /** Observer-only host checkout for the existing registry/context lifecycle; agent tools use /app. */
  checkout: TaskCheckout;
  /** Exact pre-registered caps. Remaining wall headroom uses options.driveTimeoutMs. */
  generationBudget?: GenerationBudget;
  /** Complete controller-issued reservation/capture population. Repeated
   * sessions consume deltas from this value; they never re-sum a cumulative
   * request count or widen the frozen assignment budget. */
  readRequestCensus?(): Promise<CurrentBenchTaskRequestCensus>;
  /** Exact native request count from this assignment's accounting ledger, including failed requests. */
  readModelCalls(): Promise<number>;
  stop(): Promise<void>;
}

export interface FrontierSweLaunchAdapterConfig {
  runId: string;
  /** Protocol identity can span multiple separately owned arm/seed runtime runs. */
  protocolRunId?: string;
  signal?: AbortSignal;
  context: PapercuspUnifiedToolContext;
  /** The exact origin psu writes into Codex config; the relay reaches this loopback service. */
  mcpOrigin: string;
  /** Trusted hook records, outside every container mount. */
  hookRecordDir: string;
  /** Reuses currentBenchGatewayController and the frozen assignment/accounting/context planes. */
  startAssignment(input: RunAgentInput<FrontierSweEnvHandle>): Promise<FrontierSweNativeAssignment>;
  seam?: Omit<FrontierSweSeamConfig, 'egress' | 'inContainerCodex'>;
  egress?: Pick<BenchEgressConfig, 'exec' | 'sidecarImage' | 'workRoot' | 'readyTimeoutMs' | 'readyPollMs'>;
}

export interface FrontierSweLaunchAdapterPorts {
  startBridge: typeof startCodexHookBridge;
  startEgress: typeof startBenchEgress;
  sweep: typeof sweepBenchEgress;
  createDriver: (options: CurrentSuBenchOptions, context: PapercuspUnifiedToolContext,
    observations: CurrentSuBenchObservations) => BenchHarnessDriver;
}
const livePorts: FrontierSweLaunchAdapterPorts = {
  startBridge: startCodexHookBridge, startEgress: startBenchEgress,
  sweep: sweepBenchEgress,
  createDriver: (options, context, observations) => options.armId === 'baseline'
    ? createCurrentStockBenchHarness(options, context, observations)
    : createCurrentSuBenchHarness(options, context, observations),
};

function localOrigin(value: string): { origin: string; port: number } {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('FrontierSWE adapter requires an exact loopback HTTP origin.');
  }
  return { origin: url.origin, port: Number(url.port || 80) };
}

/** Exported so fail-closed wrapper wiring is tested independently of model spend. */
export function frontierSweDockerTarget(handle: FrontierSweEnvHandle, bridge: CodexHookBridge,
  egress: BenchEgress, gatewayOrigin: string, mcpOrigin: string, stockNative = false): DockerExecTarget {
  const mounts = handle.inContainerCodex;
  if (!mounts || !handle.taskNetwork) throw new Error('FrontierSWE native assignment requires its Codex mounts and task network.');
  const target: DockerExecTarget = {
    kind: 'docker-exec', containerId: handle.containerId, workdir: '/app', binPath: mounts.binPath,
    sessionRelocation: { sessionEnv: 'CODEX_HOME', roots: mounts.roots },
    ...(stockNative ? {} : { hookBridge: { url: egress.originFor('hooks'), recordDir: bridge.recordDir } }),
    originRewrites: [
      { from: localOrigin(gatewayOrigin).origin, to: egress.originFor('gw') },
      ...(stockNative ? [] : [{ from: localOrigin(mcpOrigin).origin, to: egress.originFor('mcp') }]),
    ],
  };
  validateDockerExecTarget(target);
  return target;
}

/** One bridge/egress per run; one gateway binding at a time, on the seam's per-task network. */
export async function startFrontierSweLaunchAdapter(config: FrontierSweLaunchAdapterConfig,
  ports: FrontierSweLaunchAdapterPorts = livePorts) {
  const mcp = localOrigin(config.mcpOrigin);
  if (!config.context.workspaceId?.trim()) throw new Error('FrontierSWE adapter needs its concrete benchmark workspace.');
  assertBenchWorkspace(config.context.workspaceId);
  if (!config.runId.trim()) throw new Error('FrontierSWE adapter needs a stable run id.');
  const bridge = await ports.startBridge({ recordDir: config.hookRecordDir });
  let egress: BenchEgress;
  try {
    egress = await ports.startEgress({ ...config.egress, runId: config.runId, endpoints: [
      { name: 'gw', listenPort: 8788, perTask: true },
      { name: 'mcp', listenPort: 9071, targetPort: mcp.port },
      { name: 'hooks', listenPort: 9081, targetPort: bridge.port },
    ] });
  } catch (error) {
    try { await ports.sweep(config.runId, config.egress?.exec); } finally { await bridge.stop(); }
    throw error;
  }
  let seam: ReturnType<typeof makeFrontierSweCloneGradeSeam>;
  try {
    seam = makeFrontierSweCloneGradeSeam({ ...config.seam, egress, inContainerCodex: true });
  } catch (error) {
    try { await egress.stop(); } finally {
      try { await ports.sweep(config.runId, config.egress?.exec); } finally { await bridge.stop(); }
    }
    throw error;
  }
  let closed = false;
  let inFlight: Promise<AgentRunOutput> | undefined;
  let stopping: Promise<{ errors: string[] }> | undefined;
  const runAgent = (input: RunAgentInput<FrontierSweEnvHandle>): Promise<AgentRunOutput> => {
    if (closed || config.signal?.aborted) return Promise.reject(new Error('FrontierSWE adapter is stopped or cancelled.'));
    if (inFlight) return Promise.reject(new Error('FrontierSWE adapter permits one metered assignment at a time.'));
    const run = async (): Promise<AgentRunOutput> => {
      if (!['worker', 'solver'].includes(input.role) || input.candidates?.length) {
        throw new Error('Current FrontierSWE native adapter runs a single solver; judge/leader/pair roles are not supported.');
      }
      if (!input.handle.inContainerCodex || !input.handle.taskNetwork) {
        throw new Error('FrontierSWE adapter refuses a host-only task handle.');
      }
      let assignment: FrontierSweNativeAssignment | undefined;
      let unbind: (() => void) | undefined;
      try {
        assignment = await config.startAssignment(input);
        const { options, observations } = assignment;
        if (options.runId !== (config.protocolRunId ?? config.runId) || options.armId !== input.arm ||
          !['papercusp', 'baseline'].includes(options.armId) || options.agent !== 'codex' ||
          options.workspaceId !== config.context.workspaceId || !observations.nativeGateway) {
          throw new Error('FrontierSWE assignment differs from its run/arm/workspace or lacks its native gateway.');
        }
        const gateway = localOrigin(observations.nativeGateway.baseURL);
        unbind = egress.bindTaskEndpoint(input.handle.taskNetwork, 'gw', gateway.port);
        const stockNative = options.armId === 'baseline';
        const target = frontierSweDockerTarget(input.handle, bridge, egress, gateway.origin, mcp.origin, stockNative);
        const driver = ports.createDriver(options, config.context, { ...observations, containerExec: target });
        const result = await driver.spinRunAndCost({ blueprintId: stockNative ? CURRENT_STOCK_CODEX_BLUEPRINT : FULL_SPINE_BLUEPRINT, task: input.task,
          checkout: assignment.checkout, budget: assignment.generationBudget ?? {
            ...(input.attemptBudget.maxCostUsd !== undefined ? { maxUsd: input.attemptBudget.maxCostUsd } : {}),
            ...(input.attemptBudget.maxTokens !== undefined ? { maxTokens: input.attemptBudget.maxTokens } : {}),
            ...(input.attemptBudget.maxWallMs !== undefined ? { maxWallClockMs: input.attemptBudget.maxWallMs } : {}),
          } });
        const usage = result.telemetry;
        let modelCalls = 0, measurementError: string | undefined;
        try {
          if (assignment.readRequestCensus) {
            const census = await assignment.readRequestCensus();
            modelCalls = census.requests.length;
          } else modelCalls = await assignment.readModelCalls();
          if (!Number.isSafeInteger(modelCalls) || modelCalls < 0) throw new Error('FrontierSWE native model-call count is unmeasured.');
        } catch (error) {
          modelCalls = 0; measurementError = error instanceof Error ? error.message : String(error);
        }
        return {
          submission: { containerId: input.handle.containerId, instanceId: input.task.instanceId },
          status: usage.armMeta?.costUsdMeasurementMissing || measurementError ? 'error' : generationStatusForStopReason(usage.stopReason),
          modelCalls, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, costUsd: usage.costUsd,
          turns: usage.turns, capped: usage.stopReason === 'budget-exhausted', error: measurementError ?? usage.generationError,
          armMeta: { ...usage.armMeta, nativeUsage: { stopReason: usage.stopReason,
            tokensCacheRead: usage.tokensCacheRead ?? 0, tokensCacheWrite: usage.tokensCacheWrite ?? 0 },
            ...(measurementError ? { modelCallsMeasurementMissing: true } : {}) },
          traceRef: usage.trajectoryRef, executionPath: stockNative ? 'stock-native-reference' : 'modernization-launch-adapter',
        };
      } finally {
        unbind?.();
        if (assignment) {
          try { await assignment.stop(); } finally { await assignment.checkout.cleanup(); }
        }
      }
    };
    const promise = run();
    inFlight = promise;
    // Do not create an unhandled rejection from a detached finally chain.
    void promise.then(() => { inFlight = undefined; }, () => { inFlight = undefined; });
    return promise;
  };
  return {
    seam, runAgent, egress,
    stop(): Promise<{ errors: string[] }> {
      if (stopping) return stopping;
      closed = true;
      stopping = (async () => {
        const errors: string[] = [];
        try { await inFlight; } catch { /* trial error is returned to its caller; cleanup still runs */ }
        for (const operation of [() => egress.stop(), () => ports.sweep(config.runId, config.egress?.exec)]) {
          try { errors.push(...(await operation()).errors); } catch (e) { errors.push(String(e)); }
        }
        try { await bridge.stop(); } catch (e) { errors.push(String(e)); }
        return { errors };
      })();
      return stopping;
    },
  };
}
