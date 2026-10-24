/** D-059/D-060: bind the official host loop to the existing task/grade contract.
 * This specification grants no process, credential, request or spend authority.
 */
import { requireCurrentBenchmarkAssignment } from './reproducibility/schema';
import type { FrontierSweEnvHandle } from './frontier-swe-seam';
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CurrentBenchHostReferenceGateway } from './current-su';

export function proximusRunSpec(config: unknown, execution: Parameters<typeof requireCurrentBenchmarkAssignment>[1] & {
  handle: Pick<FrontierSweEnvHandle, 'containerId' | 'image' | 'instanceId'>;
  /** Host-measured installed dependency digest; never obtained from agent output. */
  runtimeRevision: string;
  /** Hard process deadline, including finalization. */
  maxWallClockMs: number;
  outputTokenLimit: number;
}) {
  const protocol = requireCurrentBenchmarkAssignment(config, execution);
  const arm = protocol.arms.find(arm => arm.id === execution.armId)!;
  const runtime = arm.runtime.proximus;
  if (arm.agent !== 'proximus' || !runtime || execution.runtimeRevision !== arm.runtime.runtimeRevision ||
      !execution.handle.containerId.trim() || execution.handle.instanceId !== execution.taskId ||
      execution.handle.image !== protocol.grader.images?.[execution.taskId]) {
    throw new Error('Proximus requires its exact installed runtime and immutable FrontierSWE task image.');
  }
  const rate = protocol.priceSchedule.rates.find(rate => rate.model === arm.model)!;
  if (!Number.isSafeInteger(execution.maxWallClockMs) || execution.maxWallClockMs <= 0 ||
      execution.maxWallClockMs > arm.generationBudget.maxWallClockMs ||
      !Number.isSafeInteger(execution.outputTokenLimit) || execution.outputTokenLimit <= 0 ||
      execution.outputTokenLimit > rate.outputTokenCeiling! ||
      arm.generationBudget.maxTokens !== undefined && execution.outputTokenLimit > arm.generationBudget.maxTokens) {
    throw new Error('Proximus hard time/output allowance is invalid or wider than its frozen caps.');
  }
  // The host process deadline remains exact. Upstream hard_timeout_sec adds
  // finalization headroom; it must never replace/widen this hard allowance.
  return Object.freeze({
    agent: 'harbor_proximus:Proximus' as const,
    sourceRevision: arm.runtime.sourceRevision, runtimeRevision: arm.runtime.runtimeRevision,
    clientVersion: arm.runtime.clientVersion, harborVersion: runtime.harborVersion,
    containerId: execution.handle.containerId, taskId: execution.taskId, image: execution.handle.image,
    model: arm.model, modelName: `${runtime.provider}/${arm.model}`, provider: runtime.provider,
    maxWallClockMs: execution.maxWallClockMs, maxUsd: arm.generationBudget.maxUsd,
    options: Object.freeze({
      time_budget_sec: execution.maxWallClockMs / 1000, reasoning_effort: arm.effort,
      model_info: Object.freeze({ max_input_tokens: runtime.maxInputTokens, supports_vision: runtime.supportsVision,
        ...(runtime.provider === 'openai' ? { mode: 'responses' } : {}) }),
      llm_call_kwargs: Object.freeze({ max_tokens: execution.outputTokenLimit }),
    }),
  });
}

export type ProximusRunSpec = ReturnType<typeof proximusRunSpec>;

export interface ProximusRuntimeReceipt {
  schemaVersion: 1; runtimeRevision: string; sourceRevision: string;
  clientVersion: string; harborVersion: string; fileCount: number;
}
interface ProximusHostProcessInput {
  pythonBin: string; operation: 'measure' | 'run'; maxWallClockMs: number;
  stdin?: string; signal?: AbortSignal;
}

/** Host process, with no inherited API credentials/proxies or shell. The
 * process-group kill bounds even an upstream finalizer ignoring cancellation. */
export function proximusHostProcess(input: ProximusHostProcessInput): Promise<unknown> {
  if (!isAbsolute(input.pythonBin) || !Number.isSafeInteger(input.maxWallClockMs) || input.maxWallClockMs <= 0 ||
      input.stdin !== undefined && Buffer.byteLength(input.stdin) > 1024 * 1024)
    return Promise.reject(new Error('Invalid Proximus host process/deadline/payload.'));
  if (input.signal?.aborted) return Promise.reject(new Error('Proximus host process was aborted.'));
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, { PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True' });
  return new Promise((resolve, reject) => {
    const child = spawn(input.pythonBin, ['-I', '-B', fileURLToPath(new URL('./proximus-host.py', import.meta.url)), input.operation],
      { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const output: Buffer[] = [];
    let bytes = 0, failed: string | undefined;
    const kill = (reason: string) => {
      failed ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const abort = () => kill('aborted');
    const timer = setTimeout(() => kill('deadline exceeded'), input.maxWallClockMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) kill('output limit exceeded');
      else if (!failed) output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      // Upstream diagnostics may contain request data. Bound and discard it;
      // the private trial artifacts retain the official trajectory.
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) kill('output limit exceeded');
    });
    child.stdin.on('error', () => { kill('stdin unavailable'); });
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    child.on('close', code => {
      clearTimeout(timer); input.signal?.removeEventListener('abort', abort);
      if (failed || spawnFailed || code !== 0) return reject(new Error(`Proximus host process failed: ${failed ?? 'execution failed'}.`));
      try { resolve(JSON.parse(Buffer.concat(output).toString('utf8'))); }
      catch { reject(new Error('Proximus host process returned invalid evidence.')); }
    });
    child.stdin.end(input.stdin ?? '');
    // Abort may race subscription; do not let that lose the hard stop.
    if (input.signal?.aborted) abort();
  });
}

function runtimeReceipt(value: unknown): ProximusRuntimeReceipt {
  const row = value as ProximusRuntimeReceipt | null;
  if (!row || row.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(row.runtimeRevision) ||
      typeof row.sourceRevision !== 'string' || typeof row.clientVersion !== 'string' ||
      typeof row.harborVersion !== 'string' || !Number.isSafeInteger(row.fileCount) || row.fileCount <= 0)
    throw new Error('Proximus installed runtime measurement is incomplete.');
  return Object.freeze({ schemaVersion: row.schemaVersion, runtimeRevision: row.runtimeRevision,
    sourceRevision: row.sourceRevision, clientVersion: row.clientVersion, harborVersion: row.harborVersion, fileCount: row.fileCount });
}

/** Preparation only: no gateway, task access, provider send or spend grant. */
export async function measureProximusRuntime(input: { pythonBin: string; signal?: AbortSignal },
  execute = proximusHostProcess): Promise<ProximusRuntimeReceipt> {
  return runtimeReceipt(await execute({ ...input, operation: 'measure', maxWallClockMs: 120_000 }));
}

/** Existing task + frozen assignment + actual installed bytes + live opaque
 * gateway. A completed host process still requires terminal bill reconciliation
 * and official grading before it is a benchmark result. */
export async function runProximusHost(config: unknown,
  execution: Omit<Parameters<typeof proximusRunSpec>[1], 'runtimeRevision'> & {
    pythonBin: string; trialDir: string; instruction: string; network: string;
    networkMode: 'no-network' | 'public' | 'allowlist';
    gateway: CurrentBenchHostReferenceGateway; signal?: AbortSignal;
  }, execute = proximusHostProcess) {
  const protocol = requireCurrentBenchmarkAssignment(config, execution);
  const { requireCurrentBenchHostReferenceGateway } = await import('./current-su');
  requireCurrentBenchHostReferenceGateway(execution.gateway, protocol, execution);
  if (!isAbsolute(execution.trialDir) || !execution.instruction.trim())
    throw new Error('Proximus requires a host trial directory and exact task instruction.');
  const measured = await measureProximusRuntime(execution, execute);
  const spec = proximusRunSpec(protocol, { ...execution, runtimeRevision: measured.runtimeRevision });
  if (spec.sourceRevision !== measured.sourceRevision || spec.clientVersion !== measured.clientVersion ||
      spec.harborVersion !== measured.harborVersion) throw new Error('Proximus installed source/version differs from its assignment.');
  // Recheck after async preparation; a revoked grant must not start the loop.
  const grant = requireCurrentBenchHostReferenceGateway(execution.gateway, protocol, execution);
  const payload = { spec, gateway: grant.gateway, trialDir: execution.trialDir, instruction: execution.instruction,
    network: execution.network, networkMode: execution.networkMode };
  const result = await execute({ pythonBin: execution.pythonBin, operation: 'run', maxWallClockMs: spec.maxWallClockMs,
    signal: execution.signal, stdin: JSON.stringify(payload) }) as {
      schemaVersion: number; status: string; runtime: unknown; diagnosticContext: unknown; billingStatus: string;
    } | null;
  if (!result || result.schemaVersion !== 1 || result.status !== 'completed' || result.billingStatus !== 'unreconciled' ||
      JSON.stringify(runtimeReceipt(result.runtime)) !== JSON.stringify(measured))
    throw new Error('Proximus host result differs from its measured runtime or lacks terminal process evidence.');
  return Object.freeze({ status: 'completed' as const, runtime: measured,
    diagnosticContext: result.diagnosticContext, billingStatus: 'unreconciled' as const });
}
