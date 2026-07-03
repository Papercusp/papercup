/**
 * provisioner/provision — orchestrates the wizard's full flow (local-concurrent-inference-
 * 2026-07-02 P-009, D-006): detect → recommend → resolve weights → render backend config →
 * register in the gateway pool.
 *
 * Split into two phases on purpose:
 *   - `planProvision()` is PURE besides the (injectable, read-only) weights lookup — safe to
 *     call anytime, including while another agent is GPU-resident (it never starts a process).
 *   - `applyProvision()` is the side-effecting phase: writes the systemd unit + registers the
 *     backend in the durable gateway pool (`local-backend-store.ts` — also just a DB write,
 *     no GPU I/O). Actually STARTING the backend (which loads the model onto the GPU) is
 *     gated behind `opts.start`, which defaults to **false**. Nothing in this module's default
 *     path touches the GPU — a caller must opt in explicitly to `start: true`.
 */
import { dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectHardware, type DetectedHardware, type HardwareDetectDeps } from './hardware-detect';
import { recommendCombo, type Recommendation } from './recommend';
import { resolveOllamaWeights, type WeightsPlan, type OllamaResolveDeps } from './weights';
import { renderLlamaServerUnit } from './backend-config';
import {
  detectContainerRuntime,
  resolveVllmImage,
  renderVllmContainerUnit,
  VLLM_PINNED_IMAGE,
  type ContainerRuntimeInfo,
  type VllmImageDeps,
} from './vllm-container';
import {
  registerLocalBackend,
  type RegisterLocalBackendInput,
  type LocalBackendRecord,
} from '../inference-gateway/local-backend-store';
import type { CatalogEntry } from './catalog';

const execFileAsync = promisify(execFile);

export interface ProvisionPlan {
  hardware: DetectedHardware;
  recommendation: Recommendation;
  weights: WeightsPlan | null;
  /** Container-runtime probe result (D-009 #3) — only populated when the detected hardware is
   *  NVIDIA (the only tier a vLLM candidate can ever target, D-004); `null` on Apple/AMD/CPU
   *  hardware where the probe would be moot. Feeds `recommendCombo`'s "downgrade to
   *  llama-server when no working Docker/Podman runtime" gate. */
  containerRuntime: ContainerRuntimeInfo | null;
  backendId: string;
  unitFileContent: string | null;
  unitFilePath: string;
  gatewayRegisterInput: RegisterLocalBackendInput | null;
  /** Non-null iff the plan cannot be applied as-is (no combo fits, or weights need a download
   *  the wizard hasn't been told to perform). Surfaced verbatim by the CLI/UI. */
  blocked: string | null;
}

export interface PlanProvisionOptions {
  catalog?: readonly CatalogEntry[];
  hardwareDeps?: HardwareDetectDeps;
  ollamaDeps?: OllamaResolveDeps;
  backendId?: string;
  home?: string;
  unitFilePath?: string;
  logPath?: string;
  /** Absolute path to an ALREADY-provisioned `llama-server` binary (from
   *  `llama-binary.ts`'s `resolveLlamaBinary` — a separate, opt-in, network/build-capable
   *  step; deliberately NOT called from inside this function, which stays fast/read-only per
   *  its own contract below). Omitted -> `renderLlamaServerUnit`'s default of relying on a
   *  bare `llama-server` already being on PATH, unchanged from before WI-1617. */
  binPath?: string;
  /** Exec injection for the container-runtime probe (D-009 #3/P-013) — tests only; production
   *  callers rely on the default (real `docker`/`podman` exec). */
  vllmDeps?: VllmImageDeps;
  /** Override the vLLM image pin — tests / a future multi-image catalog. Defaults to
   *  `VLLM_PINNED_IMAGE`. */
  vllmImage?: string;
  /** Host directory bind-mounted to the vLLM container's `/root/.cache/huggingface`. Defaults
   *  to `${home}/.cache/huggingface`. */
  hfCacheDir?: string;
}

function defaultHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '';
}

/**
 * Detect hardware, pick a combo, and resolve its weights + render its config — all read-only
 * besides a filesystem probe for already-downloaded weights. Safe to call at any time.
 */
export async function planProvision(opts: PlanProvisionOptions = {}): Promise<ProvisionPlan> {
  const hardware = await detectHardware(opts.hardwareDeps);
  // Container-runtime probing only matters where a vLLM candidate could ever match (NVIDIA —
  // D-004: vLLM is CUDA-only) — skip the two extra subprocess spawns on Apple/AMD/CPU hardware.
  const containerRuntime: ContainerRuntimeInfo | null =
    hardware.gpu?.vendor === 'nvidia' ? await detectContainerRuntime(opts.vllmDeps?.exec) : null;
  const recommendation = recommendCombo(hardware, opts.catalog, {
    containerRuntimeAvailable: containerRuntime ? containerRuntime.runtime !== null : undefined,
  });

  if (!recommendation.entry) {
    return {
      hardware,
      recommendation,
      weights: null,
      containerRuntime,
      backendId: '',
      unitFileContent: null,
      unitFilePath: '',
      gatewayRegisterInput: null,
      blocked: recommendation.reason,
    };
  }

  const entry = recommendation.entry;
  const vllmImage = opts.vllmImage ?? VLLM_PINNED_IMAGE;
  const weights: WeightsPlan =
    entry.backend === 'llama-server'
      ? await resolveOllamaWeights(entry.model.ollamaRef, opts.ollamaDeps)
      : entry.backend === 'vllm'
        ? await resolveVllmImage(vllmImage, { ...opts.vllmDeps, runtimeInfo: containerRuntime ?? undefined })
        : { needsDownload: true, detail: `download flow for backend kind '${entry.backend}' is not implemented yet`, pullHint: undefined };

  const backendId = opts.backendId ?? `provisioner-${entry.id}`;
  const home = opts.home ?? defaultHome();
  const unitFilePath = opts.unitFilePath ?? `${home}/.config/systemd/user/${backendId}.service`;
  const logPath = opts.logPath ?? `${home}/.papercusp/${backendId}.log`;

  const unitFileContent =
    !weights.needsDownload && weights.weightsPath
      ? entry.backend === 'vllm' && containerRuntime?.runtime
        ? renderVllmContainerUnit({
            runtime: containerRuntime.runtime,
            containerName: backendId,
            image: weights.weightsPath,
            hfModelRepo: entry.model.hfRepo ?? entry.model.ollamaRef,
            servedModelName: entry.model.ollamaRef,
            quantization: entry.model.quantization ?? 'awq',
            host: entry.serve.host,
            port: entry.serve.portDefault,
            maxModelLen: entry.serve.ctxTotal,
            gpuMemoryUtilization: entry.serve.gpuMemoryUtilization ?? 0.9,
            hfCacheDir: opts.hfCacheDir ?? `${home}/.cache/huggingface`,
            logPath,
          })
        : entry.backend === 'llama-server'
          ? renderLlamaServerUnit({
              alias: entry.model.ollamaRef,
              weightsPath: weights.weightsPath,
              host: entry.serve.host,
              port: entry.serve.portDefault,
              parallelSlots: entry.serve.parallelSlots,
              ctxTotal: entry.serve.ctxTotal,
              kvCacheType: entry.serve.kvCacheType,
              flashAttn: entry.serve.flashAttn,
              jinja: entry.serve.jinja,
              reasoningBudget: entry.serve.reasoningBudget,
              logPath,
              binPath: opts.binPath,
            })
          : null
      : null;

  const gatewayRegisterInput: RegisterLocalBackendInput | null =
    !weights.needsDownload && weights.weightsPath
      ? {
          id: backendId,
          kind: entry.backend,
          baseUrl: `http://${entry.serve.host}:${entry.serve.portDefault}`,
          models: [entry.model.ollamaRef],
          maxConcurrent: entry.serve.parallelSlots,
        }
      : null;

  const blocked = weights.needsDownload
    ? `${entry.backend === 'vllm' ? 'container image' : 'weights'} not present locally — ${weights.pullHint ?? weights.detail ?? 'a download is required'}`
    : null;

  return { hardware, recommendation, weights, containerRuntime, backendId, unitFileContent, unitFilePath, gatewayRegisterInput, blocked };
}

export interface ApplyProvisionOptions {
  writeFile?: (path: string, content: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
  registerBackend?: (input: RegisterLocalBackendInput) => Promise<LocalBackendRecord>;
  /** Enable + start the systemd unit and health-check it. **Defaults to false — this is the
   *  ONLY thing in this whole module that loads a model onto the GPU.** Never set true while
   *  another process needs the card (check coord:presence / coord:ask first). */
  start?: boolean;
  runSystemctl?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  healthCheck?: (baseUrl: string) => Promise<boolean>;
}

export interface ApplyProvisionResult {
  ok: boolean;
  wroteUnit: boolean;
  registered: boolean;
  started: boolean;
  error?: string;
}

async function defaultSystemctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync('systemctl', args, { timeout: 15000 });
  return { stdout: r.stdout, stderr: r.stderr };
}

async function defaultHealthCheck(baseUrl: string): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Apply a plan: write the unit file + register the backend in the gateway pool's durable
 * registry. With `opts.start` left at its default (`false`), this NEVER starts a process or
 * touches the GPU — it only writes a config file and a Postgres row.
 */
export async function applyProvision(plan: ProvisionPlan, opts: ApplyProvisionOptions = {}): Promise<ApplyProvisionResult> {
  if (plan.blocked) {
    return { ok: false, wroteUnit: false, registered: false, started: false, error: plan.blocked };
  }

  const doWriteFile = opts.writeFile ?? ((p: string, c: string) => writeFile(p, c, 'utf8'));
  const doMkdir = opts.mkdir ?? ((p: string) => mkdir(p, { recursive: true }).then(() => undefined));

  let wroteUnit = false;
  if (plan.unitFileContent) {
    await doMkdir(dirname(plan.unitFilePath));
    await doWriteFile(plan.unitFilePath, plan.unitFileContent);
    wroteUnit = true;
  }

  let registered = false;
  if (plan.gatewayRegisterInput) {
    const register = opts.registerBackend ?? registerLocalBackend;
    await register(plan.gatewayRegisterInput);
    registered = true;
  }

  let started = false;
  if (opts.start && plan.unitFileContent) {
    const systemctl = opts.runSystemctl ?? defaultSystemctl;
    const healthCheck = opts.healthCheck ?? defaultHealthCheck;
    await systemctl(['--user', 'daemon-reload']);
    await systemctl(['--user', 'enable', '--now', `${plan.backendId}.service`]);
    started = await healthCheck(plan.gatewayRegisterInput!.baseUrl);
  }

  return { ok: true, wroteUnit, registered, started };
}
