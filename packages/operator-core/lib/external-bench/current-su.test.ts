import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import {
  currentBenchLaunchRequest, currentBenchRunLabel, currentSuBenchHarnessDriver,
  liveCurrentSuBenchPorts, recoverCurrentBenchRun,
  currentBenchIdentityFromObservation, type CurrentBenchIdentityObservation,
  currentBenchObservationReader, type CurrentBenchObservationReaderPorts,
  currentBenchAssignmentId, currentBenchGatewayController,
  type CurrentBenchIdentity, type CurrentBenchTask, type CurrentSuBenchOptions, type CurrentSuBenchPorts,
} from './current-su';
import type { BenchHarnessOps } from './bench-harness-live';
import type { PapercuspUnifiedToolContext } from '../agent-tools/_tool-context';
import { currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { GatewayRequestTelemetry } from '../inference-gateway/request-stage-telemetry';
import type { RuntimeVintageRow } from '../runtime-vintage';
import { processMonotonicClock } from '../process-monotonic-clock';
import type { GatewayCarryTrialAttempt, GatewayCarryTrialAttemptResult } from '../inference-gateway/gateway';
import type { NativeGymProviderAuthorization } from '../gym/proposer';
import type { LearningSpendReservation, ReserveLearningSpendInput, SettleLearningSpendInput } from '../learning-governor/store';
import type { Sql } from 'postgres';

function budgetFixture() {
  const digest = (text: string) => createHash('sha256').update(text).digest('hex');
  const protocol = currentProtocolFixture();
  const resources = { inputTokens: 10_000, outputTokens: 1000, requestsPerArm: 50,
    armIds: protocol.arms.map(arm => currentBenchAssignmentId(protocol.runId, arm.id, 't1', 1)),
    usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 1000, wallClockMsPerArm: 100 };
  const authority: NativeGymProviderAuthorization = { attemptKind: 'evaluation', requestedUsd: 0.001,
    inputTokens: 100, outputTokens: 10, validUntilMonotonicMs: processMonotonicClock.now() + 10_000,
    validateAuthorization: vi.fn(() => {}) };
  const reserve = vi.fn(async (_sql: Sql, q: ReserveLearningSpendInput) => {
    const reservation: LearningSpendReservation = { id: q.exact!.reservationId, workspaceId: q.workspaceId,
      loopId: q.loopId, potSlug: null, attemptKind: q.attemptKind!, requestedUsd: q.requestedUsd,
      reservedUsd: q.requestedUsd, usedUsd: 0, status: 'open', signalOrigin: 'organic',
      runRef: `manifest:${q.exact!.binding}/attempt:${q.exact!.reservationId}`, resources: { ...q.exact!.resources! },
      note: q.note ?? null, createdAt: Date.now(), settledAt: null };
    return { ok: true as const, clamped: false, headroomUsd: 60, reservation };
  });
  const settle = vi.fn(async (_sql: Sql, q: SettleLearningSpendInput) => ({ ok: false as const,
    reason: 'not-found' as const, reservation: null }));
  const input = { workspaceId: 'bench-private', loopId: 'benchmark-run-1', token: randomUUID(), preregHash: digest('frozen'),
    protocol, resources, armId: 'papercusp', taskId: 't1', seed: 1,
    authenticateProvider: vi.fn(async () => authority) };
  const governor = { enabled: async () => true, getSql: async () => ({} as Sql), reserve, settle, log: () => {} };
  const controller = currentBenchGatewayController(input, governor);
  const body = JSON.stringify({ model: 'configured-alias', reasoning: { effort: 'high' }, max_output_tokens: 10 });
  const attempt: GatewayCarryTrialAttempt = { attemptId: randomUUID(), manifestSha256: input.preregHash,
    armId: controller.gateway.carryTrial.armId, transport: 'bearer-http', accountId: 'authenticated-account',
    credentialHeader: 'authorization', credentialSha256: digest('Bearer PRIVATE_PROVIDER_KEY'),
    target: 'https://provider.invalid/v1/responses', body, bodySha256: digest(body),
    clockId: processMonotonicClock.id, signal: new AbortController().signal };
  const result = (request: GatewayCarryTrialAttempt, reservationRef: string, outcome: 'send-refused' | 'fetch-failed' | 'response-headers') => {
    const { body: _body, signal: _signal, ...identity } = request;
    return { ...identity, reservationRef, outcome, responseStatus: outcome === 'response-headers' ? 200 : null,
      ...(outcome === 'send-refused' ? { costUsd: 0, costUsdMeasurementMissing: false } : { costUsdMeasurementMissing: true }) } as GatewayCarryTrialAttemptResult;
  };
  return { ...controller, input, governor, reserve, settle, authority, attempt, digest, result };
}

describe('frozen benchmark native provider admission', () => {
  it('binds the host native output ceiling to the frozen resource allowance', () => {
    const f = budgetFixture();
    expect(f.gateway.carryTrial.outputTokenLimit).toBe(1000);
    f.input.resources.outputTokens = 9999;
    expect(f.gateway.carryTrial.outputTokenLimit).toBe(1000);
    f.revoke();
  });
  it('binds every provider attempt to the existing exact lifetime ledger and assignment cap', async () => {
    const f = budgetFixture();
    try {
      const receipt = await f.gateway.carryTrial.authorizeAttempt(f.attempt);
      expect(receipt).not.toBeNull();
      expect(receipt!.reservationRef).toBe(f.attempt.attemptId);
      expect(f.reserve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        workspaceId: 'bench-private', loopId: 'benchmark-run-1', floorUsd: 0, requestedUsd: 0.001,
        exact: { reservationId: f.attempt.attemptId, binding: f.input.preregHash, expectedBudgetUsd: 60,
          resources: { armId: f.attempt.armId, inputTokens: 100, outputTokens: 10 }, expectedResourceBudget: f.input.resources },
      }));
      expect(f.reserve.mock.calls[0][1].cycle).toBeUndefined();
      const note = f.reserve.mock.calls[0][1].note!;
      expect(note).not.toContain('PRIVATE_PROVIDER_KEY'); expect(note).not.toContain('configured-alias');
      receipt!.validateAuthorization!();
      await receipt!.observeAttemptResult!(f.result(f.attempt, receipt!.reservationRef, 'response-headers'));
      expect(f.settle).not.toHaveBeenCalled();
    } finally { f.revoke(); }
  });
  it.each(['send-refused', 'fetch-failed', 'response-headers'] as const)('keeps unknown usage reserved for %s', async outcome => {
    const f = budgetFixture();
    try {
      const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.attempt))!;
      expect(receipt).not.toBeNull();
      if (outcome !== 'send-refused') receipt.validateAuthorization!();
      await receipt.observeAttemptResult!(f.result(f.attempt, receipt.reservationRef, outcome));
      expect(f.settle).toHaveBeenCalledTimes(outcome === 'send-refused' ? 1 : 0);
      if (outcome === 'send-refused') expect(f.settle).toHaveBeenCalledWith(expect.anything(),
        expect.objectContaining({ reservationId: f.attempt.attemptId, usedUsd: 0, disposition: 'cancelled' }));
    } finally { f.revoke(); }
  });
  it.each(['body', 'effort', 'model', 'output', 'missing-output', 'auth', 'price', 'expired', 'foreign-manifest', 'foreign-assignment', 'fractional-usd'])('refuses %s before reservation', async changed => {
    const f = budgetFixture();
    try {
      const body = JSON.parse(f.attempt.body);
      if (changed === 'body') f.attempt = { ...f.attempt, body: '{' };
      if (changed === 'effort') body.reasoning.effort = 'low';
      if (changed === 'model') body.model = 'other-model';
      if (changed === 'output') body.max_output_tokens = 11;
      if (changed === 'missing-output') delete body.max_output_tokens;
      if (changed === 'auth') f.input.authenticateProvider.mockResolvedValue(null as never);
      if (changed === 'price') f.authority.requestedUsd = 0.000001;
      if (changed === 'expired') f.authority.validUntilMonotonicMs = -1;
      if (changed === 'foreign-manifest') f.attempt = { ...f.attempt, manifestSha256: 'd'.repeat(64) };
      if (changed === 'foreign-assignment') f.attempt = { ...f.attempt, armId: 'other' };
      if (changed === 'fractional-usd') f.authority.requestedUsd = 0.0000011;
      if (['effort', 'model', 'output', 'missing-output'].includes(changed)) {
        const text = JSON.stringify(body); f.attempt = { ...f.attempt, body: text, bodySha256: f.digest(text) };
      }
      expect(await f.gateway.carryTrial.authorizeAttempt(f.attempt)).toBeNull();
      expect(f.reserve).not.toHaveBeenCalled();
    } finally { f.revoke(); }
  });
  it.each(['total', 'assignment', 'inflight', 'roster', 'time'] as const)('rejects drifted frozen %s resource policy', changed => {
    const f = budgetFixture();
    try {
      if (changed === 'total') f.input.protocol.aggregateBudgetUsd = 0.5;
      if (changed === 'assignment') f.input.resources.usdPerArm = 4;
      if (changed === 'inflight') f.input.resources.maxOpenUsd = 4;
      if (changed === 'roster') f.input.resources.armIds.pop();
      if (changed === 'time') f.input.resources.wallClockMsPerArm++;
      expect(() => currentBenchGatewayController(f.input, f.governor)).toThrow();
    } finally { f.revoke(); }
  });
  it('refuses replay, rechecks revocation at send and snapshots the frozen protocol', async () => {
    const f = budgetFixture();
    try {
      f.input.protocol.arms[0].model = 'mutated'; f.input.protocol.aggregateBudgetUsd = 600;
      f.input.resources.usdPerArm = 30;
      const receipt = (await f.gateway.carryTrial.authorizeAttempt(f.attempt))!;
      expect(receipt).not.toBeNull();
      expect(f.reserve.mock.calls[0][1].exact!.expectedBudgetUsd).toBe(60);
      expect(await f.gateway.carryTrial.authorizeAttempt(f.attempt)).toBeNull();
      expect(f.reserve).toHaveBeenCalledTimes(1);
      f.revoke(); expect(() => receipt.validateAuthorization!()).toThrow();
    } finally { f.revoke(); }
  });
  it('does not price Anthropic cache-write exposure as ordinary input', async () => {
    const f = budgetFixture();
    try {
      f.input.protocol.arms[0].agent = 'claude';
      const c = currentBenchGatewayController(f.input, f.governor);
      const body = JSON.stringify({ model: 'configured-alias', output_config: { effort: 'high' }, max_tokens: 10 });
      expect(await c.gateway.carryTrial.authorizeAttempt({ ...f.attempt, transport: 'anthropic-http', body, bodySha256: f.digest(body) })).toBeNull();
      expect(f.reserve).not.toHaveBeenCalled(); c.revoke();
    } finally { f.revoke(); }
  });
});

const native = vi.hoisted(() => ({ launch: vi.fn(), kill: vi.fn() }));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: native.launch },
  INTERNAL_SCOPED_INFERENCE_GATEWAY: Symbol.for('benchmark-test-private-route') }));
vi.mock('../task-manager/control', () => ({ killTask: native.kill }));

const options: CurrentSuBenchOptions = {
  workspaceId: 'bench-private', runId: 'run-1', armId: 'papercusp', seed: 1, agent: 'codex', model: 'configured-alias',
  effort: 'high', account: 'auto', pollIntervalMs: 10, driveTimeoutMs: 100,
  preregistration: { preregHash: 'frozen-protocol', config: currentProtocolFixture() },
};
const handle = { slug: 'xbench-current-1', featureId: 'xbench-feature-1', worktreePath: '/scratch/task' };
const request = {
  blueprintId: 'su', task: { benchmark: 'swe-bench-pro', instanceId: 't1', problemStatement: 'Fix the public issue.', graderMeta: { hidden: 'SECRET' } },
  checkout: { dir: '/scratch/task', repo: 'a/b', baseCommit: 'base', cleanup: async () => {} },
  budget: { maxUsd: 3, maxWallClockMs: 100 },
};
const identity: CurrentBenchIdentity = {
  measuredBy: 'runtime-observation', runtimeRevision: 'served-revision', sourceRevision: 'source-revision',
  model: 'served-model', effort: 'medium', clientVersion: 'native-client/1',
  promptHash: 'measured-prompt', toolsHash: 'measured-tools', observedAt: '2026-10-09T20:00:00Z', evidenceRefs: ['usage:actual-task'],
};
function observedFixture() {
  const nativeSessionId = '00000000-0000-0000-0000-000000000001';
  const turnId = '00000000-0000-0000-0000-000000000002';
  const task: CurrentBenchTask = { taskId: 'task-observed', workspaceId: 'bench-private', state: 'exited', exitCode: 0, detail: {} };
  const telemetry = new GatewayRequestTelemetry({ now: () => Date.parse('2026-10-09T20:00:00Z') });
  const span = telemetry.begin({ ownerId: 'su-exact', provider: 'codex', protocol: 'openai-responses' });
  span.setModel('native-requested-model');
  span.setCacheShape(Buffer.from(JSON.stringify({ instructions: 'PRIVATE_SYSTEM_PROMPT', tools: [{ name: 'tool-exact' }], reasoning: { effort: 'high' } })));
  span.setNativeCorrelation({ client_metadata: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: nativeSessionId, turn_id: turnId }) } });
  span.setServingAccount('actual-account');
  span.recordProviderIdentity('resp-exact', 'actual-provider-model', null, 'actual-account');
  span.recordCacheUsage(10, 0, 0, 'resp-exact');
  const observation: CurrentBenchIdentityObservation = {
    worker: { taskId: task.taskId, workspaceId: task.workspaceId, ownerId: 'su-exact', nativeSessionId,
      runtimeRevision: 'a'.repeat(40), sourceRevision: 'b'.repeat(40), evidenceRef: 'loaded-runtime:task-observed' },
    nativeTranscript: [
      { type: 'session_meta', payload: { id: nativeSessionId, cli_version: '0.162.0' } },
      { type: 'turn_context', payload: { turn_id: turnId, model: 'native-requested-model', effort: 'high' } },
    ].map(record => JSON.stringify(record)).join('\n'),
    gateway: { processRef: 'gateway:exact-process', timeline: span.finish('ok', 200)! },
  };
  return { task, observation };
}

describe('exact native benchmark identity observation', () => {
  it('joins native version and turn with a provider response and complete exposure hashes', () => {
    const { task, observation } = observedFixture();
    const result = currentBenchIdentityFromObservation(task, observation);
    expect(result).toMatchObject({ model: 'actual-provider-model', effort: 'high', effortSource: 'forwarded-request',
      clientVersion: 'codex/0.162.0', accountId: 'actual-account', providerResponseId: 'resp-exact' });
    expect(result?.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.toolsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SYSTEM_PROMPT');
    observation.gateway.timeline.providerIdentity!.effort = 'high';
    expect(currentBenchIdentityFromObservation(task, observation)?.effortSource).toBe('provider-response');
  });
  it.each(['workspace', 'task', 'owner', 'native', 'response', 'account', 'effort', 'partial-prompt', 'partial-tools', 'missing-provider', 'runtime', 'native-version', 'native-turn', 'native-model', 'native-effort', 'malformed-transcript'])('leaves %s drift or incomplete evidence unknown', changed => {
    const { task, observation: o } = observedFixture();
    const row = o.gateway.timeline;
    if (changed === 'workspace') o.worker.workspaceId = 'other';
    if (changed === 'task') o.worker.taskId = 'other';
    if (changed === 'owner') row.ownerId = 'other';
    if (changed === 'native') row.nativeCorrelation.threadId = '00000000-0000-0000-0000-000000000003';
    if (changed === 'response') row.cache.providerRequestId = 'resp-other';
    if (changed === 'account') row.cache.servingAccountId = 'other';
    if (changed === 'effort') row.providerIdentity!.effort = 'low';
    if (changed === 'partial-prompt') row.cache.instructions!.hashedBytes--;
    if (changed === 'partial-tools') row.cache.tools!.hashedBytes--;
    if (changed === 'missing-provider') row.providerIdentity = null;
    if (changed === 'runtime') o.worker.runtimeRevision = 'configured-alias';
    if (changed === 'native-version') o.nativeTranscript = o.nativeTranscript.replace('0.162.0', '');
    if (changed === 'native-turn') o.nativeTranscript = o.nativeTranscript.replace('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003');
    if (changed === 'native-model') o.nativeTranscript = o.nativeTranscript.replace('native-requested-model', 'configured-alias');
    if (changed === 'native-effort') o.nativeTranscript = o.nativeTranscript.replace('high', 'low');
    if (changed === 'malformed-transcript') o.nativeTranscript += '\n{';
    expect(currentBenchIdentityFromObservation(task, o)).toBeNull();
  });
});
function hostObservationFixture() {
  const { task, observation } = observedFixture();
  task.detail.coordOwnerId = observation.worker.ownerId;
  task.sessionId = observation.worker.nativeSessionId;
  task.startedAt = new Date(observation.gateway.timeline.startedAt - 1).toISOString();
  const rows: RuntimeVintageRow[] = ['worker', 'gateway'].map((unit, i) => ({
    workspaceId: 'host-ledger', unit, host: 'measured-host', treeSha: 'b'.repeat(40), buildTime: null,
    bundleVersion: null, pid: 100 + i, reportedAt: new Date(observation.gateway.timeline.startedAt - 2).toISOString(),
    extra: { kernelProcessIdentity: `kernel:${unit}`, ...(unit === 'gateway' ? { port: 8788 } : {}) },
  }));
  const report = { owner: observation.worker.ownerId,
    process: { pid: 101, identity: 'kernel:gateway', startedAt: observation.gateway.timeline.startedAt - 3 },
    stageTelemetry: { ownerId: observation.worker.ownerId, recent: [observation.gateway.timeline] } };
  const ports: CurrentBenchObservationReaderPorts = {
    readBinding: vi.fn(async () => ({ ownerId: observation.worker.ownerId, nativeSessionId: observation.worker.nativeSessionId, codexHome: '/host/native-home' })),
    readRuntimes: vi.fn(async () => rows), measureRuntimes: vi.fn(() => 'a'.repeat(64)),
    readTranscript: vi.fn(async () => observation.nativeTranscript), readGateway: vi.fn(async () => report),
  };
  const opts = { workspaceId: task.workspaceId, runtimeWorkspaceId: 'host-ledger', workerUnit: 'worker', gatewayUnit: 'gateway', gatewayBaseUrl: 'http://127.0.0.1:8788' };
  return { task, rows, report, ports, opts };
}
describe('host-backed benchmark observation reader', () => {
  it('joins exact native binding, execution-host boot pins and a process-matched gateway request', async () => {
    const f = hostObservationFixture();
    const observation = await currentBenchObservationReader(f.opts, f.ports)(f.task);
    expect(currentBenchIdentityFromObservation(f.task, observation!)).toMatchObject({ sourceRevision: 'b'.repeat(40), runtimeRevision: 'a'.repeat(64), model: 'actual-provider-model' });
    expect(f.ports.readRuntimes).toHaveBeenCalledTimes(2);
    expect(f.ports.readTranscript).toHaveBeenCalledWith(f.task.sessionId, '/host/native-home');
  });
  it.each(['task-workspace', 'missing-native', 'owner', 'kernel', 'pid', 'port', 'old-request', 'restarted', 'missing-transcript', 'abbreviated-source', 'runtime-workspace'])('refuses %s rather than fabricating loaded identity', async changed => {
    const f = hostObservationFixture();
    if (changed === 'task-workspace') f.task.workspaceId = 'production';
    if (changed === 'missing-native') f.task.sessionId = null;
    if (changed === 'owner') f.report.owner = 'other';
    if (changed === 'kernel') f.report.process.identity = 'new-process';
    if (changed === 'pid') f.report.process.pid++;
    if (changed === 'port') f.rows[1].extra.port = 1234;
    if (changed === 'old-request') f.task.startedAt = new Date(f.report.stageTelemetry.recent[0].finalizedAt + 1).toISOString();
    if (changed === 'restarted') f.ports.measureRuntimes = vi.fn().mockReturnValueOnce('a'.repeat(64)).mockReturnValueOnce('a'.repeat(64)).mockReturnValue('c'.repeat(64));
    if (changed === 'missing-transcript') f.ports.readTranscript = vi.fn(async () => null);
    if (changed === 'abbreviated-source') f.rows[0].treeSha = 'abcdef0';
    if (changed === 'runtime-workspace') f.rows[0].workspaceId = 'other';
    expect(await currentBenchObservationReader(f.opts, f.ports)(f.task)).toBeNull();
  });
  it('requires an explicit local observation endpoint without an embedded credential', () => {
    const f = hostObservationFixture();
    for (const gatewayBaseUrl of ['https://example.com', 'http://secret@127.0.0.1:8788', 'http://127.0.0.1:8788/other']) {
      expect(() => currentBenchObservationReader({ ...f.opts, gatewayBaseUrl }, f.ports)).toThrow(/explicit local/);
    }
  });
});
function fixture(opts = options) {
  let clock = 0;
  const row: CurrentBenchTask = {
    taskId: 'task-own', workspaceId: opts.workspaceId, state: 'exited', exitCode: 0,
    detail: { label: currentBenchLaunchRequest(opts, handle, 'issue').label },
  };
  const lifecycle: BenchHarnessOps = {
    now: () => clock,
    createHarness: vi.fn(async () => handle), addFeature: vi.fn(async () => {}),
    driveToDone: vi.fn(async () => ({ disposition: 'error' as const })),
    collectCost: vi.fn(async () => ({ costUsd: 0.25, tokensIn: 20, tokensOut: 10, turns: 1 })),
    teardown: vi.fn(async () => {}),
  };
  const ports: CurrentSuBenchPorts = {
    verifyPreregistration: vi.fn(async () => ({ preregHash: 'frozen-protocol', gitCommitSha: 'a'.repeat(40), receiptRef: 'prereg:committed' })),
    admit: vi.fn(async () => ({ admitted: true, receiptRef: 'budget:reservation-1' })),
    launch: vi.fn(async () => ({ agentStarted: true, tasks: [{ taskId: row.taskId, ownerId: 'su-native' }] })),
    getTask: vi.fn(async () => row), listTasks: vi.fn(async () => [row]),
    killTask: vi.fn(async (id: string) => ({ ok: true as const, taskId: id, action: 'kill' })),
    sleep: vi.fn(async ms => { clock += ms; }),
    readCompletion: vi.fn(async () => null), readIdentity: vi.fn(async () => identity),
  };
  return { row, ports, lifecycle, run: () => currentSuBenchHarnessDriver(lifecycle, ports, opts).spinRunAndCost(request) };
}
describe('current native benchmark execution', () => {
  it('verifies the frozen protocol before reserving budget or launching', async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.ports.verifyPreregistration).toHaveBeenCalledOnce();
    expect(vi.mocked(f.ports.verifyPreregistration).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.ports.admit).mock.invocationCallOrder[0]);
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ preregistration: { preregHash: 'frozen-protocol', receiptRef: 'prereg:committed' } });
  });
  it('refuses uncommitted protocol before admission and generation', async () => {
    const f = fixture();
    vi.mocked(f.ports.verifyPreregistration).mockRejectedValue(new Error('protocol is not committed'));
    expect((await f.run()).telemetry.generationError).toMatch(/not committed/);
    expect(f.ports.admit).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it.each([
    { preregHash: 'different-protocol', gitCommitSha: 'a'.repeat(40), receiptRef: 'prereg:other' },
    { preregHash: 'frozen-protocol', gitCommitSha: '', receiptRef: 'prereg:missing-commit' },
    { preregHash: 'frozen-protocol', gitCommitSha: 'a'.repeat(40), receiptRef: '' },
  ])('refuses an unverifiable protocol receipt before budget admission: %j', async receipt => {
    const f = fixture();
    vi.mocked(f.ports.verifyPreregistration).mockResolvedValue(receipt);
    expect((await f.run()).telemetry.generationError).toMatch(/pre-registration receipt/);
    expect(f.ports.admit).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it.each(['data', 'structuredContent'])('reads the maintained launcher receipt from %s.launch', async field => {
    const f = fixture();
    vi.mocked(f.ports.launch).mockResolvedValue({
      content: [{ type: 'text', text: 'Opened one headless native solver.' }],
      [field]: { launch: { agentStarted: true, tasks: [{ taskId: f.row.taskId }] } },
    });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('done');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      launchReceipt: { agentStarted: true, tasks: [{ taskId: f.row.taskId }] },
      terminalReceipt: { taskId: f.row.taskId }, retiredTaskIds: [f.row.taskId],
    });
  });
  it('uses the maintained native su request, pins explicit controls and excludes hidden grader inputs', async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.ports.launch).toHaveBeenCalledWith(expect.objectContaining({
      harness: handle.slug, cwd: handle.worktreePath, feature: handle.featureId, workItem: handle.featureId,
      independent: true, headless: true, count: 1, mcpTarget: 'spawn-host',
      members: [{ role: 'su', agent: 'codex', model: 'configured-alias', effort: 'high', account: 'auto' }],
    }));
    const args = vi.mocked(f.ports.launch).mock.calls[0][0];
    expect(args.brief).toContain(request.task.problemStatement);
    expect(args.brief).not.toContain('SECRET');
    expect(result.telemetry.stopReason).toBe('done');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({
      configured: { model: 'configured-alias', effort: 'high' }, measured: identity, identityStatus: 'measured',
      launchReceipt: { tasks: [{ taskId: 'task-own' }] }, terminalReceipt: { taskId: 'task-own', exitCode: 0 }, retiredTaskIds: ['task-own'],
    });
    expect(f.lifecycle.driveToDone).not.toHaveBeenCalled();
    expect(f.lifecycle.teardown).toHaveBeenCalledOnce();
  });
  it.each([null, { ...identity, measuredBy: 'configuration' }, { ...identity, toolsHash: '' }, { ...identity, evidenceRefs: [] }])(
    'does not convert missing or configured identity into a runtime measurement: %j', async value => {
      const f = fixture();
      vi.mocked(f.ports.readIdentity).mockResolvedValue(value as CurrentBenchIdentity | null);
      const result = await f.run();
      expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ identityStatus: 'unknown', measured: null });
    },
  );
  it('refuses production workspace before registration or process launch', () => {
    const f = fixture();
    expect(() => currentSuBenchHarnessDriver(f.lifecycle, f.ports, { ...options, workspaceId: ' papercusp-workspace ' })).toThrow(/PRODUCTION/);
    expect(f.lifecycle.createHarness).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('refuses retired treatment dispatch rather than reconstructing its blueprint', async () => {
    const f = fixture();
    const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, options).spinRunAndCost({ ...request, blueprintId: 'external-bench' });
    expect(result.telemetry.generationError).toMatch(/retired treatment/);
    expect(f.lifecycle.createHarness).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('records declined admission as a cap outcome and launches no process', async () => {
    const f = fixture();
    vi.mocked(f.ports.admit).mockResolvedValue({ admitted: false, receiptRef: 'budget:full' });
    expect((await f.run()).telemetry.stopReason).toBe('budget-exhausted');
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('requires a durable budget receipt before launch', async () => {
    const f = fixture();
    vi.mocked(f.ports.admit).mockResolvedValue({ admitted: true, receiptRef: '' });
    expect((await f.run()).telemetry.generationError).toMatch(/no durable receipt/);
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it.each([{ model: 'changed' }, { effort: 'low' }, { account: 'other' }, { seed: 2 }, { armId: 'other' }] as const)(
    'refuses launch control or assignment drift before protocol read/admission: %j', async changed => {
      const f = fixture({ ...options, ...changed });
      expect((await f.run()).telemetry.generationError).toMatch(/frozen protocol/);
      expect(f.ports.verifyPreregistration).not.toHaveBeenCalled();
      expect(f.ports.admit).not.toHaveBeenCalled(); expect(f.ports.launch).not.toHaveBeenCalled();
    },
  );
  it('refuses undeclared task and budget drift before generation', async () => {
    for (const altered of [
      { ...request, task: { ...request.task, instanceId: 'unassigned' } },
      { ...request, budget: { ...request.budget, maxUsd: 4 } },
    ]) {
      const f = fixture();
      const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, options).spinRunAndCost(altered);
      expect(result.telemetry.generationError).toMatch(/frozen protocol/);
      expect(f.ports.admit).not.toHaveBeenCalled(); expect(f.ports.launch).not.toHaveBeenCalled();
    }
  });
  it('cancels before launch without admitting or spending', async () => {
    const ac = new AbortController(); ac.abort();
    const f = fixture({ ...options, signal: ac.signal });
    expect((await f.run()).telemetry.stopReason).toBe('timeout');
    expect(f.ports.admit).not.toHaveBeenCalled();
    expect(f.ports.launch).not.toHaveBeenCalled();
  });
  it('cancels a process whose launch completes after cancellation and retains its receipt', async () => {
    const ac = new AbortController();
    const f = fixture({ ...options, signal: ac.signal });
    vi.mocked(f.ports.launch).mockImplementation(async () => { ac.abort(); return { agentStarted: true, tasks: [{ taskId: 'task-own' }] }; });
    const result = await f.run();
    expect(result.telemetry.generationError).toMatch(/cancelled during/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    expect(result.telemetry.armMeta?.currentExecution).toMatchObject({ retiredTaskIds: ['task-own'] });
  });
  it('uses the attempt wall-clock cap and retires its live task', async () => {
    const capped = { ...options, preregistration: { ...options.preregistration, config: currentProtocolFixture('run-1', 20) } };
    const f = fixture(capped); f.row.state = 'running'; f.row.exitCode = null;
    const result = await currentSuBenchHarnessDriver(f.lifecycle, f.ports, capped).spinRunAndCost({ ...request, budget: { maxUsd: 3, maxWallClockMs: 20 } });
    expect(result.telemetry.stopReason).toBe('timeout');
    expect(result.telemetry.wallClockMs).toBe(20);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('preserves completed work while stopping a still-live native host', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    vi.mocked(f.ports.readCompletion).mockResolvedValue('done');
    expect((await f.run()).telemetry.stopReason).toBe('done');
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('stops at the metered attempt cap and retains the total cost', async () => {
    const f = fixture(); f.row.state = 'running'; f.row.exitCode = null;
    vi.mocked(f.lifecycle.collectCost).mockResolvedValue({ costUsd: 3, tokensIn: 20, tokensOut: 10, turns: 1 });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('budget-exhausted');
    expect(result.telemetry.costUsd).toBe(3);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
    expect(f.ports.launch).toHaveBeenCalledOnce();
  });
  it('refuses a task receipt pointing to another workspace', async () => {
    const f = fixture(); f.row.workspaceId = 'papercusp-workspace';
    expect((await f.run()).telemetry.generationError).toMatch(/identity\/scope/);
    expect(f.ports.killTask).not.toHaveBeenCalled();
  });
  it('reports unobserved termination as an error rather than a clean exit', async () => {
    const f = fixture(); f.row.state = 'ended_unobserved'; f.row.exitCode = null;
    expect((await f.run()).telemetry.generationError).toMatch(/unobserved/);
  });
  it('cleans a partially launched task using durable labels when the launch reply is lost', async () => {
    const f = fixture(); vi.mocked(f.ports.launch).mockRejectedValue(new Error('transport lost receipt'));
    expect((await f.run()).telemetry.generationError).toMatch(/lost receipt/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('refuses a launch receipt without observed native start and cleans its task', async () => {
    const f = fixture(); vi.mocked(f.ports.launch).mockResolvedValue({ agentStarted: false, tasks: [{ taskId: 'task-own' }] });
    expect((await f.run()).telemetry.generationError).toMatch(/no verified single-agent start/);
    expect(f.ports.killTask).toHaveBeenCalledWith('task-own');
  });
  it('does not claim successful generation when process cleanup fails', async () => {
    const f = fixture();
    vi.mocked(f.ports.killTask).mockResolvedValue({ ok: false, taskId: 'task-own', action: 'kill', error: 'not_live' });
    const result = await f.run();
    expect(result.telemetry.stopReason).toBe('error');
    expect(result.telemetry.generationError).toMatch(/cleanup failed/);
  });
});
describe('current benchmark restart and live binding', () => {
  it('recovers only tasks belonging to the exact interrupted run and workspace', async () => {
    const f = fixture();
    const peer = { ...f.row, taskId: 'peer', detail: { label: `${currentBenchRunLabel('run-2')}solver` } };
    const production = { ...f.row, taskId: 'production', workspaceId: 'papercusp-workspace' };
    vi.mocked(f.ports.listTasks).mockResolvedValue([f.row, peer, production]);
    expect(await recoverCurrentBenchRun(f.ports, options)).toEqual(['task-own']);
    expect(f.ports.listTasks).toHaveBeenCalledWith({ workspaceId: 'bench-private', labelPrefix: currentBenchRunLabel('run-1'), includeEnded: true, limit: 1000 });
    expect(f.ports.killTask).toHaveBeenCalledExactlyOnceWith('task-own');
  });
  it('fails closed on a truncated cleanup census', async () => {
    const f = fixture(); vi.mocked(f.ports.listTasks).mockResolvedValue(Array.from({ length: 1000 }, () => f.row));
    await expect(recoverCurrentBenchRun(f.ports, options)).rejects.toThrow(/census exceeded/);
    expect(f.ports.killTask).not.toHaveBeenCalled();
  });
  it('calls the maintained handler with the original authenticated context and subtree controller', async () => {
    const f = fixture();
    const ctx = { workspaceId: 'bench-private', authenticatedPrincipal: { retained: true } } as unknown as PapercuspUnifiedToolContext;
    const gateway = { baseURL: 'http://127.0.0.1:32101', token: 'a'.repeat(64) };
    const ports = liveCurrentSuBenchPorts(ctx, { admit: f.ports.admit, observeIdentity: async () => null, nativeGateway: gateway }, options);
    const args = currentBenchLaunchRequest(options, handle, 'issue');
    await ports.launch(args);
    const forwarded = native.launch.mock.calls.at(-1)![1];
    expect(forwarded.authenticatedPrincipal).toBe((ctx as unknown as { authenticatedPrincipal: unknown }).authenticatedPrincipal);
    expect(forwarded.workspaceId).toBe(ctx.workspaceId);
    expect(forwarded[Symbol.for('benchmark-test-private-route')]).toEqual(gateway);
    expect(Object.getOwnPropertySymbols(ctx)).not.toContain(Symbol.for('benchmark-test-private-route'));
    await ports.killTask('task-own');
    expect(native.kill).toHaveBeenCalledWith('task-own', { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 5000 });
    expect(ctx.workspaceId).toBe('bench-private');
  });
  it('refuses a production launch without the host private route before invoking the native handler', async () => {
    const ctx = { workspaceId: 'bench-private' } as PapercuspUnifiedToolContext;
    const ports = liveCurrentSuBenchPorts(ctx, { admit: fixture().ports.admit, observeIdentity: async () => null }, options);
    const before = native.launch.mock.calls.length;
    await expect(ports.launch(currentBenchLaunchRequest(options, handle, 'issue'))).rejects.toThrow(/private inference gateway/);
    expect(native.launch.mock.calls.length).toBe(before);
  });
  it('production ports derive identity from scoped observations instead of accepting a configured measurement', async () => {
    const { task, observation } = observedFixture();
    const ctx = { workspaceId: 'bench-private' } as PapercuspUnifiedToolContext;
    const observeIdentity = vi.fn(async () => observation);
    const ports = liveCurrentSuBenchPorts(ctx, { admit: fixture().ports.admit, observeIdentity }, options);
    expect(await ports.readIdentity(task)).toMatchObject({ model: 'actual-provider-model', clientVersion: 'codex/0.162.0' });
    expect(observeIdentity).toHaveBeenCalledWith(task);
    observation.worker.workspaceId = 'other';
    expect(await ports.readIdentity(task)).toBeNull();
  });
});
