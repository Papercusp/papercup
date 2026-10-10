/** Current native su execution over the existing benchmark lifecycle and task ledger. */
import { createHash } from 'node:crypto';
import type launchAgentTool from '../agent-tools/capability/launch-agent';
import { snapshotScopedInferenceGateway, type ScopedInferenceGateway } from '@papercusp/orchestrator/codex-gateway-config';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import type { TaskRow } from '../task-manager/types';
import type { ControlOutcome } from '../task-manager/control';
import { resolveBenchWorkspace } from './bench-workspace';
import { liveBenchHarnessDriver, liveBenchHarnessOps, type BenchHarnessOps, type BenchHarnessHandle, type DriveResult, type LiveBenchHarnessOpts } from './bench-harness-live';
import { FULL_SPINE_BLUEPRINT, setBenchHarnessDriver } from './run-loop';
import type { BenchTask, GenerationBudget } from './types';
import type { DbScope } from './reproducibility/db';
import { requireCurrentBenchmarkAssignment } from './reproducibility/schema';
import { normalizeFeatureStateInput } from '../work-item-dispatch-states';
import type { GatewayRequestTimeline } from '../inference-gateway/request-stage-telemetry';
import { measureRuntimeVintageEnvironment, type RuntimeVintageRow } from '../runtime-vintage';
import { currentBenchmarkProtocolSchema, type CurrentBenchmarkProtocol } from './reproducibility/schema';
import { canonicalJson } from './reproducibility/canonical-json';
import { createNativeGymGatewayController, type NativeGymProviderAuthorization } from '../gym/proposer';
import type { GovernorGlueDeps } from '../learning-governor/registrants';
import type { GatewayCarryTrialAttempt } from '../inference-gateway/gateway';
import type { LearningReservationResourceBudget } from '../learning-governor/store';

/** Stable assignment identity shared by every solver/reviewer/retry. It is an
 * extension of the existing governor arm resource key, never a new ledger. */
export function currentBenchAssignmentId(runId: string, armId: string, taskId: string, seed: number): string {
  if ([runId, armId, taskId].some(value => !value.trim()) || !Number.isSafeInteger(seed) || seed < 0) {
    throw new Error('Benchmark budget requires an exact assignment identity.');
  }
  return `bench-assignment:${createHash('sha256').update(canonicalJson([runId, armId, taskId, seed])).digest('hex')}`;
}

/** Private host authority authenticates the FINAL credential, payer and native
 * input bound. A configured account alias or a caller bearer is insufficient.
 * The request still has to match the frozen model, effort, output and prices. */
export function currentBenchGatewayController(input: {
  workspaceId: string; loopId: string; token: string; preregHash: string;
  protocol: CurrentBenchmarkProtocol; armId: string; taskId: string; seed: number;
  resources: LearningReservationResourceBudget;
  authenticateProvider: (attempt: GatewayCarryTrialAttempt) => Promise<NativeGymProviderAuthorization | null>;
}, governor?: GovernorGlueDeps): ReturnType<typeof createNativeGymGatewayController> {
  const protocol = currentBenchmarkProtocolSchema.parse(input.protocol);
  const arm = protocol.arms.find(arm => arm.id === input.armId);
  resolveBenchWorkspace(input.workspaceId);
  if (!arm || !protocol.taskIds.includes(input.taskId) || !protocol.seeds.includes(input.seed) ||
      !/^[a-f0-9]{64}$/.test(input.preregHash) || typeof input.authenticateProvider !== 'function') {
    throw new Error('Benchmark gateway requires its frozen assignment and authenticated provider.');
  }
  const { workspaceId, loopId, token, preregHash, authenticateProvider } = input;
  const assignmentId = currentBenchAssignmentId(protocol.runId, input.armId, input.taskId, input.seed);
  const assignmentIds = protocol.arms.flatMap(arm => protocol.taskIds.flatMap(taskId =>
    protocol.seeds.map(seed => currentBenchAssignmentId(protocol.runId, arm.id, taskId, seed)))).sort();
  const resources = { ...input.resources, armIds: [...input.resources.armIds] };
  // The host may choose tighter token, request and global-time bounds, but
  // cannot widen any monetary/assignment limit or omit another frozen arm.
  if (canonicalJson([...resources.armIds].sort()) !== canonicalJson(assignmentIds) ||
      resources.usdPerArm !== arm.generationBudget.maxUsd || resources.maxOpenUsd !== protocol.maxInFlightUsd ||
      resources.wallClockMsPerArm !== arm.generationBudget.maxWallClockMs ||
      !Number.isSafeInteger(resources.wallClockMs) || resources.wallClockMs! <= 0) {
    throw new Error('Benchmark gateway resource policy differs from the frozen protocol.');
  }
  const rate = protocol.priceSchedule.rates.find(rate => rate.model === arm.model)!;
  return createNativeGymGatewayController({ workspaceId, loopId, token, manifestSha256: preregHash, armId: assignmentId,
    outputTokenLimit: Math.min(resources.outputTokens, arm.generationBudget.maxTokens ?? resources.outputTokens),
    exact: { binding: preregHash, budgetUsd: protocol.aggregateBudgetUsd, resourceBudget: resources },
    async authorizeProviderAttempt(attempt) {
      // Copy before authentication so an async callback cannot retarget the
      // body whose native output ceiling and monetary exposure were checked.
      const request = Object.freeze({ ...attempt });
      try {
        const body = JSON.parse(request.body);
        const output = request.transport === 'anthropic-http' ? body.max_tokens : body.max_output_tokens;
        const effort = request.transport === 'anthropic-http' ? body.output_config?.effort : body.reasoning?.effort;
        if ((arm.agent === 'codex') !== (request.transport !== 'anthropic-http') ||
            !['auto', 'default'].includes(arm.account) && request.accountId !== arm.account ||
            body.model !== arm.model || effort !== arm.effort ||
            !Number.isSafeInteger(output) || output <= 0 ||
            arm.generationBudget.maxTokens !== undefined && output > arm.generationBudget.maxTokens) return null;
        const authenticated = await authenticateProvider(request);
        if (!authenticated) return null;
        const authority = { ...authenticated };
        if (authority.outputTokens !== output || !Number.isSafeInteger(authority.inputTokens) || authority.inputTokens < 0) return null;
        // Round each frozen rate upward to microUSD per million tokens, then
        // use integer arithmetic. Floating subtraction must never grant extra
        // exposure. Full uncached input is the conservative OpenAI bound.
        // Anthropic cache-write pricing needs a separately frozen ceiling;
        // the current schema cannot authorize it by the ordinary input rate.
        if (request.transport === 'anthropic-http') return null;
        const inputRateMicros = Math.ceil(Math.max(rate.inputUsdPerMillion, rate.cachedInputUsdPerMillion) * 1_000_000);
        const outputRateMicros = Math.ceil(rate.outputUsdPerMillion * 1_000_000);
        if (![inputRateMicros, outputRateMicros].every(Number.isSafeInteger)) return null;
        const inputRate = BigInt(inputRateMicros), outputRate = BigInt(outputRateMicros);
        const requiredMicros = (BigInt(authority.inputTokens) * inputRate + BigInt(output) * outputRate + 999_999n) / 1_000_000n;
        const grantMicros = Math.round(authority.requestedUsd * 1_000_000);
        if (!Number.isSafeInteger(grantMicros) || grantMicros <= 0 || grantMicros / 1_000_000 !== authority.requestedUsd ||
            BigInt(grantMicros) < requiredMicros || authority.requestedUsd > arm.generationBudget.maxUsd) return null;
        return authority;
      } catch { return null; }
    },
  }, governor);
}

type LaunchArgs = Parameters<typeof launchAgentTool.handler>[0];
export type CurrentBenchTask = Pick<TaskRow, 'taskId' | 'workspaceId' | 'state' | 'exitCode' | 'detail'> &
  Partial<Pick<TaskRow, 'sessionId' | 'startedAt'>>;
export interface CurrentBenchIdentity {
  measuredBy: 'runtime-observation';
  runtimeRevision: string;
  sourceRevision: string;
  model: string;
  effort: string;
  clientVersion: string;
  promptHash: string;
  toolsHash: string;
  observedAt: string;
  evidenceRefs: string[];
  effortSource?: 'provider-response' | 'forwarded-request';
  accountId?: string;
  nativeSessionId?: string;
  providerResponseId?: string;
}
/** Loaded-runtime receipts come from the execution host, never current HEAD or
 * requested launch options. The native transcript and gateway row are private
 * inputs; the resulting identity retains only hashes and evidence references. */
export interface CurrentBenchIdentityObservation {
  worker: {
    taskId: string; workspaceId: string; ownerId: string; nativeSessionId: string;
    runtimeRevision: string; sourceRevision: string; evidenceRef: string;
  };
  nativeTranscript: string;
  gateway: { processRef: string; timeline: GatewayRequestTimeline };
}

/** Existing native session, runtime-vintage and gateway readers are the IO
 * authority. A bounded gateway ring establishes a particular request identity,
 * never complete all-attempt usage or a historical runtime census. */
export interface CurrentBenchObservationReaderPorts {
  readBinding(task: CurrentBenchTask): Promise<{ ownerId: string; nativeSessionId: string; codexHome: string } | null>;
  readRuntimes(): Promise<RuntimeVintageRow[]>;
  measureRuntimes(rows: RuntimeVintageRow[], units: string[]): string | null;
  readTranscript(nativeSessionId: string, codexHome: string): Promise<string | null>;
  readGateway(ownerId: string): Promise<{ owner: string; process: { pid: number; identity: string | null; startedAt: number };
    stageTelemetry: { ownerId: string; recent: GatewayRequestTimeline[] } } | null>;
}
export interface CurrentBenchObservationReaderOptions extends DbScope {
  workspaceId: string;
  /** Boot ledger scope of the shared execution host, distinct from the
   * isolated task workspace. Read-only observation does not grant it authority. */
  runtimeWorkspaceId: string;
  workerUnit: string;
  gatewayUnit: string;
  gatewayBaseUrl: string;
}
export function currentBenchObservationReader(
  options: CurrentBenchObservationReaderOptions,
  ports: CurrentBenchObservationReaderPorts = liveCurrentBenchObservationReaderPorts(options),
): (task: CurrentBenchTask) => Promise<CurrentBenchIdentityObservation | null> {
  // Copy before asynchronous reads; an options mutation cannot retarget proof.
  const opts = { ...options };
  resolveBenchWorkspace(opts.workspaceId);
  const endpoint = new URL(opts.gatewayBaseUrl);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      !opts.runtimeWorkspaceId.trim() || !opts.workerUnit.trim() || !opts.gatewayUnit.trim() || opts.workerUnit === opts.gatewayUnit) {
    throw new Error('Benchmark observation requires explicit local execution and gateway runtimes.');
  }
  const gatewayPort = Number(endpoint.port || 80);
  const io = { ...ports };
  return async task => {
    try {
      if (task.workspaceId !== opts.workspaceId || !task.sessionId || typeof task.detail.coordOwnerId !== 'string') return null;
      const binding = await io.readBinding(task);
      if (!binding || binding.nativeSessionId !== task.sessionId || binding.ownerId !== task.detail.coordOwnerId) return null;
      const rows = await io.readRuntimes();
      const units = [opts.workerUnit, opts.gatewayUnit];
      const environment = io.measureRuntimes(rows, units), runtimeRevision = io.measureRuntimes(rows, [opts.workerUnit]);
      const workers = rows.filter(row => row.unit === opts.workerUnit);
      const gateways = rows.filter(row => row.unit === opts.gatewayUnit);
      if (!environment || !runtimeRevision || workers.length !== 1 || gateways.length !== 1) return null;
      const worker = workers[0], gateway = gateways[0];
      if (worker.workspaceId !== opts.runtimeWorkspaceId || gateway.workspaceId !== opts.runtimeWorkspaceId ||
          !worker.treeSha || !/^[a-f0-9]{40}$/.test(worker.treeSha) || gateway.extra.port !== gatewayPort ||
          typeof gateway.extra.kernelProcessIdentity !== 'string') return null;
      const [nativeTranscript, report] = await Promise.all([
        io.readTranscript(binding.nativeSessionId, binding.codexHome), io.readGateway(binding.ownerId),
      ]);
      if (!nativeTranscript || !report || report.owner !== binding.ownerId || report.stageTelemetry.ownerId !== binding.ownerId ||
          report.process.pid !== gateway.pid || report.process.identity !== gateway.extra.kernelProcessIdentity ||
          !Number.isFinite(report.process.startedAt)) return null;
      const bootAt = Date.parse(worker.reportedAt);
      const taskAt = Date.parse(task.startedAt ?? '');
      if (!Number.isFinite(bootAt) || !Number.isFinite(taskAt)) return null;
      const candidates = report.stageTelemetry.recent.filter(row => row.nativeCorrelation.status === 'observed' &&
        row.nativeCorrelation.threadId === binding.nativeSessionId && row.startedAt >= Math.max(bootAt, taskAt, report.process.startedAt));
      const timeline = candidates.sort((a, b) => b.finalizedAt - a.finalizedAt)[0];
      if (!timeline || io.measureRuntimes(await io.readRuntimes(), units) !== environment) return null;
      const observation: CurrentBenchIdentityObservation = {
        worker: { taskId: task.taskId, workspaceId: task.workspaceId, ownerId: binding.ownerId,
          nativeSessionId: binding.nativeSessionId, runtimeRevision, sourceRevision: worker.treeSha,
          evidenceRef: `runtime-vintage:${worker.unit}:${worker.host}:${worker.extra.kernelProcessIdentity}:${environment}` },
        nativeTranscript, gateway: { processRef: `gateway:${report.process.identity}`, timeline },
      };
      return currentBenchIdentityFromObservation(task, observation) ? observation : null;
    } catch { return null; }
  };
}

/** Read host-owned bindings and full native bytes. Never search another home,
 * restamp from HEAD, or use requested launch configuration as an observation. */
export function liveCurrentBenchObservationReaderPorts(opts: CurrentBenchObservationReaderOptions): CurrentBenchObservationReaderPorts {
  const scope = { ...opts };
  return {
    readBinding: async task => {
      const { resolveDb } = await import('./reproducibility/db');
      const { codexHomeForSessionKey } = await import('@papercusp/orchestrator/session-launch-dirs');
      const { sql } = resolveDb(scope);
      const rows = await sql<{ id: number; coord_owner_id: string; session_id: string }[]>`
        SELECT a.id, a.coord_owner_id, a.session_id FROM harness_shared.adv_sessions a
        JOIN harness_shared.task_ledger t ON t.workspace_id = a.workspace_id
          AND t.session_id = a.session_id AND t.detail->>'coordOwnerId' = a.coord_owner_id
        WHERE t.task_id = ${task.taskId} AND t.workspace_id = ${scope.workspaceId}
          AND a.agent = 'codex' AND a.coord_owner_id = ${String(task.detail.coordOwnerId)}
          AND a.session_id = ${task.sessionId ?? null}
        ORDER BY a.started_at DESC LIMIT 2
      `;
      if (rows.length !== 1) return null;
      return { ownerId: rows[0].coord_owner_id, nativeSessionId: rows[0].session_id, codexHome: codexHomeForSessionKey(rows[0].id) };
    },
    readRuntimes: async () => {
      const { listRuntimeVintage } = await import('../runtime-vintage');
      return listRuntimeVintage(scope.runtimeWorkspaceId, scope.sql, [scope.workerUnit, scope.gatewayUnit]);
    },
    // Keep the existing kernel-pin measurement synchronous for before/after proof.
    measureRuntimes: (rows, units) => measureRuntimeVintageEnvironment(rows, units),
    readTranscript: async (nativeSessionId, codexHome) => {
      const [{ promises: fs, constants }, path, { findCodexRolloutPathByUuid }] = await Promise.all([
        import('node:fs'), import('node:path'), import('../session-transcript-resolvers'),
      ]);
      const file = await findCodexRolloutPathByUuid(nativeSessionId, { homeOverride: codexHome });
      if (!file) return null;
      const root = await fs.realpath(path.join(codexHome, 'sessions')), realFile = await fs.realpath(file);
      const relative = path.relative(root, realFile);
      if (file !== realFile || !relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) return null;
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size <= 0 || before.size > 8_388_608) return null;
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) return null; offset += read.bytesRead;
        }
        const after = await handle.stat(), text = bytes.toString('utf8');
        return before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs &&
          Buffer.from(text, 'utf8').equals(bytes) ? text : null;
      } finally { await handle.close(); }
    },
    readGateway: async ownerId => {
      const url = new URL('/admin/owner-report', scope.gatewayBaseUrl); url.searchParams.set('owner', ownerId);
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok || !response.body) return null;
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength; if (size > 8_388_608) throw new Error('Benchmark gateway observation exceeded its byte bound.');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
  };
}

export function currentBenchIdentityFromObservation(
  task: CurrentBenchTask, observation: CurrentBenchIdentityObservation,
): CurrentBenchIdentity | null {
  const { worker, gateway } = observation;
  const row = gateway.timeline;
  const provider = row.providerIdentity;
  const correlation = row.nativeCorrelation;
  const revision = (value: string) => /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value);
  if (task.taskId !== worker.taskId || task.workspaceId !== worker.workspaceId || !worker.ownerId ||
      !worker.nativeSessionId || !worker.evidenceRef || !gateway.processRef ||
      !revision(worker.runtimeRevision) || !revision(worker.sourceRevision) ||
      row.ownerId !== worker.ownerId || row.provider !== 'codex' || row.protocol !== 'openai-responses' ||
      row.outcome !== 'ok' || row.finalStatus !== 200 || !provider ||
      correlation.status !== 'observed' || correlation.threadId !== worker.nativeSessionId ||
      correlation.sessionId !== null && correlation.sessionId !== worker.nativeSessionId ||
      !correlation.turnId || !Number.isSafeInteger(row.requestId) || row.requestId < 1) return null;
  const fullHash = (value: typeof row.cache.tools) => value && value.bytes > 0 &&
    value.bytes === value.hashedBytes && /^[a-f0-9]{64}$/.test(value.sha256) ? value.sha256 : null;
  const promptHash = fullHash(row.cache.instructions), toolsHash = fullHash(row.cache.tools);
  if (row.cache.shape !== 'observed' || !promptHash || !toolsHash ||
      provider.responseId !== row.cache.providerRequestId || provider.accountId !== row.cache.servingAccountId ||
      !row.forwardedEffort || provider.effort !== null && provider.effort !== row.forwardedEffort ||
      !Number.isFinite(row.finalizedAt) || row.finalizedAt < row.startedAt) return null;
  // No lossy transcript adapter: its session header/version and exact turn are
  // observations which portable conversation renderers intentionally discard.
  if (Buffer.byteLength(observation.nativeTranscript) > 8_388_608) return null;
  let records: Array<{ type?: string; payload?: Record<string, unknown> }>;
  try {
    records = observation.nativeTranscript.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    if (records.some(record => !record || typeof record !== 'object' || Array.isArray(record))) return null;
  } catch { return null; }
  const headers = records.filter(record => record.type === 'session_meta');
  const version = headers[0]?.payload?.cli_version;
  if (!headers.length || typeof version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+[A-Za-z0-9.+-]*$/.test(version) ||
      headers.some(record => record.payload?.id !== worker.nativeSessionId || record.payload?.cli_version !== version)) return null;
  const turns = records.filter(record => record.type === 'turn_context' && record.payload?.turn_id === correlation.turnId);
  if (!turns.length || turns.some(record => record.payload?.model !== row.model ||
      record.payload?.effort !== row.forwardedEffort)) return null;
  return {
    measuredBy: 'runtime-observation', runtimeRevision: worker.runtimeRevision, sourceRevision: worker.sourceRevision,
    model: provider.model, effort: provider.effort ?? row.forwardedEffort,
    effortSource: provider.effort ? 'provider-response' : 'forwarded-request',
    clientVersion: `codex/${version}`, promptHash, toolsHash, accountId: provider.accountId,
    nativeSessionId: worker.nativeSessionId, providerResponseId: provider.responseId,
    observedAt: new Date(row.finalizedAt).toISOString(),
    evidenceRefs: [worker.evidenceRef, `${gateway.processRef}#request:${row.requestId}`, `codex:${worker.nativeSessionId}#turn:${correlation.turnId}`, `provider:${provider.responseId}`],
  };
}
export interface CurrentSuBenchOptions extends LiveBenchHarnessOpts {
  runId: string;
  armId: string;
  seed: number;
  preregistration: { preregHash: string; config: Record<string, unknown>; repoRoot?: string };
  agent: 'codex' | 'claude';
  model: string;
  effort: NonNullable<NonNullable<LaunchArgs['members']>[number]['effort']>;
  account: string;
  signal?: AbortSignal;
}
/** Bind admission/observations from the existing budget and protocol planes. */
export interface CurrentSuBenchObservations {
  /** Host-owned startNativeGymGateway transport. Identity reads may precede
   * setup; an actual launch refuses without this route. */
  nativeGateway?: ScopedInferenceGateway;
  admit(handle: BenchHarnessHandle, budget: GenerationBudget): Promise<{ admitted: boolean; receiptRef: string }>;
  observeIdentity(task: CurrentBenchTask): Promise<CurrentBenchIdentityObservation | null>;
}
export interface CurrentSuBenchPorts extends Pick<CurrentSuBenchObservations, 'admit'> {
  readIdentity(task: CurrentBenchTask): Promise<CurrentBenchIdentity | null>;
  verifyPreregistration(): Promise<{ preregHash: string; gitCommitSha: string; receiptRef: string }>;
  readCompletion(handle: BenchHarnessHandle): Promise<'done' | 'failed' | null>;
  launch(args: LaunchArgs): Promise<unknown>;
  getTask(taskId: string): Promise<CurrentBenchTask | null>;
  listTasks(filter: { workspaceId: string; labelPrefix: string; includeEnded: true; limit: number }): Promise<CurrentBenchTask[]>;
  killTask(taskId: string): Promise<ControlOutcome>;
  sleep(ms: number): Promise<void>;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function currentBenchRunLabel(runId: string): string {
  if (!runId.trim()) throw new Error('Current benchmark execution requires a stable run id.');
  return `current-bench:${hash(runId).slice(0, 24)}:`;
}
const attemptLabel = (runId: string, handle: BenchHarnessHandle) => `${currentBenchRunLabel(runId)}${hash(handle.slug).slice(0, 24)}:`;

export function currentBenchLaunchRequest(opts: CurrentSuBenchOptions, handle: BenchHarnessHandle, problem: string): LaunchArgs {
  resolveBenchWorkspace(opts.workspaceId);
  if (!opts.model.trim() || !opts.account.trim()) throw new Error('Current benchmark model/account must be explicit.');
  return {
    harness: handle.slug, cwd: handle.worktreePath, feature: handle.featureId, workItem: handle.featureId,
    brief: `Resolve the assigned benchmark task in this repository. Preserve your work in the checkout and complete the assigned work-item when finished.\n\n${problem}`,
    independent: true, headless: true, count: 1, mcpTarget: 'spawn-host',
    label: `${attemptLabel(opts.runId, handle)}solver`,
    idempotencyKey: `current-bench:${hash(`${opts.runId}:${handle.slug}`)}`,
    members: [{ role: 'su', agent: opts.agent, model: opts.model, effort: opts.effort, account: opts.account }],
  };
}
function payload(reply: unknown): Record<string, unknown> {
  if (!reply || typeof reply !== 'object') throw new Error('Native launch returned no receipt.');
  const obj = reply as Record<string, unknown>;
  // The native handler returns prose in content and its receipt in data.launch;
  // MCP clients expose that same data under structuredContent.
  for (const envelope of [obj.data, obj.structuredContent]) {
    if (!envelope || typeof envelope !== 'object') continue;
    const launch = (envelope as Record<string, unknown>).launch;
    if (launch && typeof launch === 'object' && !Array.isArray(launch)) return launch as Record<string, unknown>;
  }
  if (!Array.isArray(obj.content)) return obj;
  for (const part of obj.content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    try { return payload(JSON.parse(part.text)); } catch { /* advisory block */ }
  }
  throw new Error('Native launch returned no structured receipt.');
}
function measuredIdentity(value: CurrentBenchIdentity | null): CurrentBenchIdentity | null {
  if (!value || value.measuredBy !== 'runtime-observation') return null;
  const fields = ['runtimeRevision', 'sourceRevision', 'model', 'effort', 'clientVersion', 'promptHash', 'toolsHash'] as const;
  if (fields.some(k => typeof value[k] !== 'string' || !value[k].trim())) return null;
  if (!Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.evidenceRefs) ||
      !value.evidenceRefs.length || value.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim())) return null;
  return value;
}
async function retirePrefix(ports: CurrentSuBenchPorts, workspaceId: string, labelPrefix: string): Promise<string[]> {
  const tasks = await ports.listTasks({ workspaceId, labelPrefix, includeEnded: true, limit: 1000 });
  if (tasks.length >= 1000) throw new Error('Benchmark cleanup census exceeded its bound; cleanup is unverified.');
  const retired: string[] = [];
  for (const task of tasks) {
    if (task.workspaceId !== workspaceId || typeof task.detail.label !== 'string' || !task.detail.label.startsWith(labelPrefix)) continue;
    const result = await ports.killTask(task.taskId);
    if (!result.ok && result.error !== 'already_gone' && result.error !== 'task_not_found') throw new Error(`Benchmark cleanup failed for ${task.taskId}: ${result.error}`);
    retired.push(task.taskId);
  }
  return retired;
}
/** Explicit restart recovery for one interrupted run, never a workspace-wide sweep. */
export async function recoverCurrentBenchRun(ports: CurrentSuBenchPorts, opts: Pick<CurrentSuBenchOptions, 'workspaceId' | 'runId'>): Promise<string[]> {
  return retirePrefix(ports, resolveBenchWorkspace(opts.workspaceId), currentBenchRunLabel(opts.runId));
}
export function currentSuBenchHarnessDriver(lifecycle: BenchHarnessOps, ports: CurrentSuBenchPorts, opts: CurrentSuBenchOptions) {
  const workspaceId = resolveBenchWorkspace(opts.workspaceId);
  currentBenchRunLabel(opts.runId);
  const registeredTasks = new Map<string, BenchTask>();
  const ops: BenchHarnessOps = {
    ...lifecycle,
    async createHarness(input) {
      if (input.blueprintId !== FULL_SPINE_BLUEPRINT) throw new Error('Current su driver refuses a retired treatment blueprint.');
      return lifecycle.createHarness(input);
    },
    async addFeature(input) {
      await lifecycle.addFeature(input);
      registeredTasks.set(input.handle.slug, input.task);
    },
    async driveToDone({ handle, budget, timeoutMs, pollMs }): Promise<DriveResult> {
      const labelPrefix = attemptLabel(opts.runId, handle);
      const record: Record<string, unknown> = {
        configured: { agent: opts.agent, model: opts.model, effort: opts.effort, account: opts.account },
        identityStatus: 'unknown', measured: null, launchReceipt: null, terminalReceipt: null,
      };
      let result: DriveResult = { disposition: 'error', detail: 'Current benchmark launch did not complete.' };
      let started = false;
      try {
        if (opts.signal?.aborted) return { disposition: 'timeout', detail: 'Benchmark cancelled before launch.', armMeta: { currentExecution: record } };
        const task = registeredTasks.get(handle.slug);
        if (!task) throw new Error('Current benchmark task has no registered assignment.');
        requireCurrentBenchmarkAssignment(opts.preregistration.config, { ...opts, taskId: task.instanceId, budget });
        const protocol = await ports.verifyPreregistration();
        record.preregistration = protocol;
        if (protocol.preregHash !== opts.preregistration.preregHash || !protocol.gitCommitSha?.trim() || !protocol.receiptRef?.trim()) {
          throw new Error('Benchmark pre-registration receipt is missing or does not match the frozen protocol.');
        }
        if (opts.signal?.aborted) return { disposition: 'timeout', detail: 'Benchmark cancelled before admission.', armMeta: { currentExecution: record } };
        const admission = await ports.admit(handle, budget);
        record.admission = admission;
        if (!admission.receiptRef?.trim()) throw new Error('Benchmark budget admission has no durable receipt.');
        if (!admission.admitted) return { disposition: 'budget-exhausted', armMeta: { currentExecution: record } };
        if (opts.signal?.aborted) return { disposition: 'timeout', detail: 'Benchmark cancelled before launch.', armMeta: { currentExecution: record } };
        const startedAt = lifecycle.now();
        const deadline = startedAt + (budget.maxWallClockMs != null ? Math.min(timeoutMs, budget.maxWallClockMs) : timeoutMs);
        if (!(deadline > startedAt)) return { disposition: 'budget-exhausted', armMeta: { currentExecution: record } };
        // A transport failure can happen after spawning: cleanup uses the durable label.
        started = true;
        const receipt = payload(await ports.launch(currentBenchLaunchRequest(opts, handle, task.problemStatement)));
        record.launchReceipt = receipt;
        const tasks = receipt.tasks as Array<{ taskId?: string }> | undefined;
        if (receipt.agentStarted !== true || tasks?.length !== 1 || !tasks[0]?.taskId) throw new Error('Native benchmark launch has no verified single-agent start.');
        const taskId = tasks[0].taskId;
        for (;;) {
          const task = await ports.getTask(taskId);
          if (!task || task.workspaceId !== workspaceId || task.detail.label !== `${labelPrefix}solver`) throw new Error('Native benchmark task identity/scope could not be verified.');
          record.terminalReceipt = task;
          const identity = measuredIdentity(await ports.readIdentity(task));
          if (identity) { record.measured = identity; record.identityStatus = 'measured'; }
          if (opts.signal?.aborted) { result = { disposition: 'timeout', detail: 'Benchmark cancelled during generation.' }; break; }
          if (lifecycle.now() >= deadline) { result = { disposition: 'timeout', detail: 'Benchmark generation wall-clock cap reached.' }; break; }
          const completion = await ports.readCompletion(handle);
          if (completion === 'done') { result = { disposition: 'done' }; break; }
          if (completion === 'failed') { result = { disposition: 'escalate', detail: 'Benchmark task ended without completion.' }; break; }
          if (task.state !== 'running' && task.state !== 'pending') {
            result = task.state === 'exited' && task.exitCode === 0 ? { disposition: 'done' } :
              { disposition: 'error', detail: `Native generation ended ${task.state}, exit=${task.exitCode ?? 'unobserved'}.` };
            break;
          }
          const cost = await lifecycle.collectCost({ handle, workspaceId });
          if ((budget.maxUsd != null && cost.costUsd >= budget.maxUsd) ||
              (budget.maxTokens != null && cost.tokensIn + cost.tokensOut >= budget.maxTokens)) { result = { disposition: 'budget-exhausted' }; break; }
          await ports.sleep(Math.max(1, Math.min(pollMs, deadline - lifecycle.now())));
        }
      } catch (error) {
        result = { disposition: 'error', detail: error instanceof Error ? error.message : String(error) };
      } finally {
        if (started) {
          try { record.retiredTaskIds = await retirePrefix(ports, workspaceId, labelPrefix); }
          catch (error) { result = { disposition: 'error', detail: error instanceof Error ? error.message : String(error) }; }
        }
      }
      return { ...result, armMeta: { currentExecution: record } };
    },
    async teardown(input) { registeredTasks.delete(input.handle.slug); await lifecycle.teardown(input); },
  };
  return liveBenchHarnessDriver(ops, { ...opts, workspaceId, maxTransientRetries: 0 });
}
/** Preserve the authenticated caller context; never manufacture benchmark authority. */
export async function readCurrentBenchCompletion(
  handle: BenchHarnessHandle, scope: DbScope & { workspaceId: string },
): Promise<'done' | 'failed' | null> {
  const workspaceId = resolveBenchWorkspace(scope.workspaceId);
  const { resolveDb } = await import('./reproducibility/db');
  const { sql } = resolveDb({ ...scope, workspaceId });
  const [row] = await sql<{ status: string }[]>`
    SELECT status FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${handle.slug}
       AND feature_id = ${handle.featureId} LIMIT 1
  `;
  if (!row) return null;
  const normalized = normalizeFeatureStateInput(row.status);
  if (!normalized.ok) return null;
  return normalized.state === 'done' ? 'done' : normalized.state === 'dropped' ? 'failed' : null;
}
export function liveCurrentSuBenchPorts(
  ctx: PapercuspUnifiedToolContext, observations: CurrentSuBenchObservations,
  opts: Pick<CurrentSuBenchOptions, 'workspaceId' | 'runId' | 'preregistration'>,
  db: Pick<DbScope, 'sql'> = {},
): CurrentSuBenchPorts {
  const workspaceId = resolveBenchWorkspace(ctx.workspaceId);
  if (ctx.workspaceId !== workspaceId || opts.workspaceId !== workspaceId) throw new Error('Current benchmark launch requires an explicitly isolated caller context.');
  const gateway = observations.nativeGateway === undefined ? null : snapshotScopedInferenceGateway(observations.nativeGateway);
  return {
    admit: (handle, budget) => observations.admit(handle, budget),
    readIdentity: async task => {
      const observation = await observations.observeIdentity(task);
      return observation ? currentBenchIdentityFromObservation(task, observation) : null;
    },
    verifyPreregistration: async () => (await import('./reproducibility/prereg')).requireCommittedPreregistration(
      opts.runId, opts.preregistration, { ...db, workspaceId, repoRoot: opts.preregistration.repoRoot },
    ),
    readCompletion: handle => readCurrentBenchCompletion(handle, { ...db, workspaceId }),
    launch: async args => {
      if (!gateway) throw new Error('Current benchmark launch requires a private inference gateway.');
      const module = await import('../agent-tools/capability/launch-agent');
      return module.default.handler(args, { ...ctx, [module.INTERNAL_SCOPED_INFERENCE_GATEWAY]: gateway } as PapercuspUnifiedToolContext);
    },
    getTask: async id => (await import('../task-manager/store')).getTask(id),
    listTasks: async filter => (await import('../task-manager/store')).listTasks(filter),
    killTask: async id => (await import('../task-manager/control')).killTask(id, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}
export function bindCurrentSuBenchHarness(opts: CurrentSuBenchOptions, ctx: PapercuspUnifiedToolContext, observations: CurrentSuBenchObservations): void {
  if (resolveBenchWorkspace(opts.workspaceId) !== ctx.workspaceId) throw new Error('Benchmark launch context and run workspace differ.');
  setBenchHarnessDriver(currentSuBenchHarnessDriver(liveBenchHarnessOps(opts), liveCurrentSuBenchPorts(ctx, observations, opts), opts));
}
