import { createHash } from 'node:crypto';
import { spawn as realSpawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { currentProtocolFixture, allCapabilities } from './reproducibility/_protocol-test-fixture';
import { currentBenchmarkProtocolSchema, currentBenchProviderAgent, PROXIMUS_CLIENT_VERSION,
  PROXIMUS_SOURCE_REVISION, type CurrentBenchmarkProtocol } from './reproducibility/schema';
import { measureProximusRuntime, proximusHostProcess, proximusRunSpec, runProximusHost } from './proximus-runtime';
import { currentBenchAssignmentId, currentBenchGatewayController, currentBenchProviderAuthenticator,
  requireCurrentBenchHostReferenceGateway, type CurrentBenchNativeInputCeiling } from './current-su';
import { processMonotonicClock } from '../process-monotonic-clock';
import type { GatewayCarryTrialAttempt } from '../inference-gateway/gateway';
import { currentBenchLaunchSelection } from './run-launcher';
import type { LearningSpendReservation, ReserveLearningSpendInput } from '../learning-governor/store';
import type { Sql } from 'postgres';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
function fixture(provider: 'openai' | 'anthropic' = 'openai') {
  const protocol = currentProtocolFixture('proximus-offline-fixture', 1_000);
  for (const arm of protocol.arms) arm.control = { topology: arm.id === 'baseline' ? 'stock-native-reference' : 'solo',
    solverGroup: arm.id, solverToolsHash: digest(arm.id), capabilities: allCapabilities(arm.id === 'baseline' ? 'off' : 'on') };
  const arm = protocol.arms[1];
  arm.agent = 'proximus';
  arm.runtime = { sourceRevision: PROXIMUS_SOURCE_REVISION, clientVersion: PROXIMUS_CLIENT_VERSION,
    runtimeRevision: digest('installed-python-harbor-litellm-lock'), promptHash: digest('prompt'), toolsHash: digest('tools'),
    proximus: { provider, harborVersion: '0.23.0', maxInputTokens: 20_000, supportsVision: false } };
  const rate = protocol.priceSchedule.rates[0];
  Object.assign(rate, { inputTokenCeiling: 10_000, inputTokenCeilingSourceSha256: digest('input-authority'),
    outputTokenCeiling: 64, ...(provider === 'anthropic' ? { cacheWriteUsdPerMillion: 1.25 } : {}) });
  protocol.grader.images = { t1: `registry.example/task@sha256:${digest('task-image')}` };
  const execution = { runId: protocol.runId, armId: arm.id, taskId: 't1', seed: 1, agent: 'proximus',
    model: arm.model, effort: arm.effort, account: arm.account, budget: { ...arm.generationBudget },
    topology: 'stock-native-reference' as const, runtimeRevision: arm.runtime.runtimeRevision,
    handle: { containerId: 'existing-frontier-task', instanceId: 't1', image: protocol.grader.images.t1 },
    maxWallClockMs: 1_000, outputTokenLimit: 10 };
  return { protocol, arm, rate, execution };
}

describe('official Proximus protocol identity', () => {
  it('keeps the reference distinct from its credential family and preserves historical Codex protocols', () => {
    expect(currentBenchmarkProtocolSchema.parse(currentProtocolFixture()).arms[1].agent).toBe('codex');
    for (const provider of ['openai', 'anthropic'] as const) {
      const { protocol } = fixture(provider), parsed = currentBenchmarkProtocolSchema.parse(protocol);
      expect(parsed.arms[1].agent).toBe('proximus');
      expect(currentBenchProviderAgent(parsed.arms[1])).toBe(provider === 'openai' ? 'codex' : 'claude');
    }
  });
  const mutations: Record<string, (p: CurrentBenchmarkProtocol) => void> = {
    'missing runtime': p => { delete p.arms[1].runtime.proximus; },
    'relabel as Codex': p => { p.arms[1].agent = 'codex'; },
    'treatment topology': p => { p.arms[1].control!.topology = 'solo'; },
    'capability enabled': p => { p.arms[1].control!.capabilities['memory-recall'] = 'on'; },
    'source drift': p => { p.arms[1].runtime.sourceRevision = 'b'.repeat(40); },
    'package drift': p => { p.arms[1].runtime.clientVersion = 'harbor-proximus@latest'; },
    'unpinned dependencies': p => { p.arms[1].runtime.runtimeRevision = 'latest'; },
    'Codex prompt template': p => { p.arms[1].runtime.promptHashMode = 'codex-native-template-v1'; },
    'unmatched model': p => { p.arms[1].model = 'other-model'; },
    'wider USD cap': p => { p.arms[1].generationBudget.maxUsd++; },
    'wider time cap': p => { p.arms[1].generationBudget.maxWallClockMs++; },
    'missing image manifest': p => { delete p.grader.images; },
    'missing task image': p => { p.grader.images = {}; },
    'unknown context capacity': p => { p.arms[1].runtime.proximus!.maxInputTokens = 0; },
    'input wider than context': p => { p.arms[1].runtime.proximus!.maxInputTokens = 9_999; },
    'unbounded output': p => { delete p.priceSchedule.rates[0].outputTokenCeiling; },
    'unproven input ceiling': p => { delete p.priceSchedule.rates[0].inputTokenCeilingSourceSha256; },
    'subscription payer': p => { for (const a of p.arms) a.payer = 'subscription'; },
    'missing Anthropic cache price': p => { p.arms[1].runtime.proximus!.provider = 'anthropic'; },
    'same solver as Codex': p => { p.arms[1].control!.solverGroup = p.arms[0].control!.solverGroup; },
    'no treatment': p => { p.arms[0].control!.topology = 'stock-native-reference';
      p.arms[0].control!.capabilities = allCapabilities('off'); },
  };
  it.each(Object.keys(mutations))('refuses %s before runtime preparation', change => {
    const { protocol, execution } = fixture(); mutations[change](protocol);
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
    expect(() => proximusRunSpec(protocol, execution)).toThrow();
  });
});

describe('Proximus measured host execution', () => {
  const measured = () => ({ schemaVersion: 1 as const, runtimeRevision: digest('installed-python-harbor-litellm-lock'),
    sourceRevision: PROXIMUS_SOURCE_REVISION, clientVersion: PROXIMUS_CLIENT_VERSION, harborVersion: '0.23.0', fileCount: 100 });
  async function host() {
    const f = providerFixture('openai');
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: f.auth.authenticateProvider,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } });
    const receipt = await controller.startHostGateway(() => {}, async () => ({ port: 32105, stop: async () => {} } as never));
    const execution = { ...f.execution, handle: { ...f.execution.handle, containerId: 'a'.repeat(64) },
      pythonBin: '/offline/venv/bin/python', trialDir: '/offline/trial', instruction: 'solve the exact task',
      network: 'none', networkMode: 'no-network' as const, gateway: receipt };
    return { ...f, controller, execution, receipt, cleanup: async () => { await receipt.stop(); f.auth.revoke(); } };
  }
  it('prepares without any gateway and refuses incomplete installed-byte evidence', async () => {
    const execute = vi.fn(async () => measured());
    expect(await measureProximusRuntime({ pythonBin: '/offline/python' }, execute)).toEqual(measured());
    expect(execute).toHaveBeenCalledWith({ pythonBin: '/offline/python', operation: 'measure', maxWallClockMs: 120_000 });
    await expect(measureProximusRuntime({ pythonBin: '/offline/python' }, async () => ({ runtimeRevision: 'claimed' })))
      .rejects.toThrow(/incomplete/);
  });
  it('binds the official host to measured bytes and its issued gateway, retaining diagnostic cost as unreconciled', async () => {
    const f = await host();
    const execute = vi.fn<NonNullable<Parameters<typeof measureProximusRuntime>[1]>>(async input => input.operation === 'measure' ? measured()
      : { schemaVersion: 1, status: 'completed', runtime: measured(), diagnosticContext: { cost_usd: 0.001 }, billingStatus: 'unreconciled' });
    try {
      const result = await runProximusHost(f.protocol, f.execution, execute);
      expect(result.billingStatus).toBe('unreconciled');
      expect(result.diagnosticContext).toEqual({ cost_usd: 0.001 });
      const run = execute.mock.calls[1][0], body = JSON.parse(run.stdin!);
      expect(run).toMatchObject({ operation: 'run', maxWallClockMs: 1_000, pythonBin: '/offline/venv/bin/python' });
      expect(body.gateway).toEqual(f.receipt.gateway);
      expect(body.spec).toMatchObject({ runtimeRevision: measured().runtimeRevision, modelName: `openai/${f.arm.model}` });
      expect(body).not.toHaveProperty('account');
    } finally { await f.cleanup(); }
  });
  it.each(['copied grant', 'runtime drift', 'revoked during measurement', 'result drift'] as const)
  ('refuses %s before accepting any terminal result', async change => {
    const f = await host();
    const execute = vi.fn<NonNullable<Parameters<typeof measureProximusRuntime>[1]>>(async input => {
      if (input.operation === 'measure') {
        if (change === 'revoked during measurement') await f.receipt.stop();
        return { ...measured(), ...(change === 'runtime drift' ? { runtimeRevision: digest('changed') } : {}) };
      }
      return { schemaVersion: 1, status: 'completed', runtime: { ...measured(), runtimeRevision: digest('changed') },
        diagnosticContext: { cost_usd: 0 }, billingStatus: 'unreconciled' };
    });
    if (change === 'copied grant') f.execution.gateway = { ...f.receipt };
    try {
      await expect(runProximusHost(f.protocol, f.execution, execute)).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(change === 'copied grant' ? 0 : change === 'result drift' ? 2 : 1);
    } finally { await f.cleanup(); }
  });
  it('refuses invalid process inputs or an already aborted run without starting a child', async () => {
    await expect(proximusHostProcess({ pythonBin: 'python', operation: 'run', maxWallClockMs: 1 })).rejects.toThrow(/Invalid/);
    await expect(proximusHostProcess({ pythonBin: '/python', operation: 'run', maxWallClockMs: 1,
      signal: AbortSignal.abort() })).rejects.toThrow(/aborted/);
  });
  it.each(['deadline', 'output'] as const)('kills and reaps the actual host child on %s failure', async cause => {
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let child: ReturnType<typeof original.spawn> | undefined;
    vi.mocked(realSpawn).mockImplementationOnce((_command, _args, options) => {
      const program = cause === 'deadline' ? 'setInterval(() => {}, 1000)'
        : 'process.stdout.write("x".repeat(3 * 1024 * 1024));setInterval(() => {}, 1000)';
      child = original.spawn(process.execPath, ['-e', program], options);
      return child;
    });
    await expect(proximusHostProcess({ pythonBin: '/offline/python', operation: 'run',
      maxWallClockMs: cause === 'deadline' ? 100 : 5_000 })).rejects.toThrow(cause === 'deadline' ? /deadline/ : /output limit/);
    expect(child!.signalCode).toBe('SIGKILL');
    expect(() => process.kill(child!.pid!, 0)).toThrow();
  });
  it('strips inherited credentials/proxies and sends the payload on stdin without exposing diagnostics', async () => {
    const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.stubEnv('OPENAI_API_KEY', 'host-provider-secret');
    vi.stubEnv('HTTPS_PROXY', 'http://unscoped-proxy');
    let command: string | undefined, args: readonly string[] | undefined;
    vi.mocked(realSpawn).mockImplementationOnce((bin, argv, options) => {
      command = bin; args = argv;
      const program = 'let data="";process.stdin.on("data",b=>data+=b);process.stdin.on("end",()=>{process.stderr.write("private-request-diagnostic");process.stdout.write(JSON.stringify({secret:process.env.OPENAI_API_KEY??null,proxy:process.env.HTTPS_PROXY??null,payload:JSON.parse(data)}))})';
      return original.spawn(process.execPath, ['-e', program], options);
    });
    try {
      const result = await proximusHostProcess({ pythonBin: '/offline/python', operation: 'run', maxWallClockMs: 5_000,
        stdin: JSON.stringify({ token: 'gateway-only-token' }) });
      expect(result).toEqual({ secret: null, proxy: null, payload: { token: 'gateway-only-token' } });
      expect(command).toBe('/offline/python');
      expect(args).toEqual(['-I', '-B', expect.stringMatching(/proximus-host.py$/), 'run']);
      expect(args!.join(' ')).not.toContain('gateway-only-token');
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('Proximus attachment specification', () => {
  it('targets the existing immutable task and holds the hard deadline independently of upstream finalization', () => {
    const { protocol, execution } = fixture();
    const spec = proximusRunSpec(protocol, execution);
    expect(spec).toMatchObject({ agent: 'harbor_proximus:Proximus', sourceRevision: PROXIMUS_SOURCE_REVISION,
      harborVersion: '0.23.0', containerId: execution.handle.containerId, image: execution.handle.image,
      model: execution.model, modelName: `openai/${execution.model}`, maxWallClockMs: 1_000, maxUsd: 3,
      options: { time_budget_sec: 1, reasoning_effort: 'high', model_info: { max_input_tokens: 20_000, mode: 'responses' },
        llm_call_kwargs: { max_tokens: 10 } } });
    expect(Object.isFrozen(spec.options.llm_call_kwargs)).toBe(true);
    expect(spec.options).not.toHaveProperty('api_key');
    expect(spec.options).not.toHaveProperty('load_trajectory');
    expect(proximusRunSpec(protocol, { ...execution, maxWallClockMs: 500 }).maxWallClockMs).toBe(500);
  });
  it.each(['image', 'task', 'runtime', 'time', 'output', 'model', 'dollars'] as const)('refuses %s drift before spawn', change => {
    const { protocol, execution } = fixture();
    if (change === 'image') execution.handle.image = 'registry.example/task:latest';
    if (change === 'task') execution.handle.instanceId = 'other';
    if (change === 'runtime') execution.runtimeRevision = digest('other-installed-runtime');
    if (change === 'time') execution.maxWallClockMs++;
    if (change === 'output') execution.outputTokenLimit = 65;
    if (change === 'model') execution.model = 'other-model';
    if (change === 'dollars') execution.budget.maxUsd++;
    expect(() => proximusRunSpec(protocol, execution)).toThrow();
  });
  it('refuses the native-CLI launcher before any task or provider starts', () => {
    const { protocol, arm } = fixture();
    expect(() => currentBenchLaunchSelection({ arm: arm.id, taskSetId: 'custom', current: {
      workspaceId: 'bench-private', protocolRunId: protocol.runId, preregHash: digest('offline-preregistration'), seed: 1,
      observation: { runtimeWorkspaceId: 'bench-private', workerUnit: 'offline-worker', gatewayUnit: 'offline-gateway' },
    } }, protocol)).toThrow(/Unsupported current benchmark execution arm/);
  });
});

function providerFixture(provider: 'openai' | 'anthropic') {
  const f = fixture(provider), preregHash = digest('offline-preregistration'), secret = 'offline-test-credential';
  const claude = provider === 'anthropic';
  const credentialHeader = claude ? 'x-api-key' : 'authorization';
  const body = JSON.stringify({ model: f.arm.model, ...(claude ? { output_config: { effort: f.arm.effort }, max_tokens: 10 }
    : { reasoning: { effort: f.arm.effort }, max_output_tokens: 10 }) });
  const attempt: GatewayCarryTrialAttempt = { attemptId: 'offline-attempt', manifestSha256: preregHash,
    armId: currentBenchAssignmentId(f.protocol.runId, f.arm.id, 't1', 1),
    transport: claude ? 'anthropic-http' : 'bearer-http', accountId: 'offline-account',
    credentialHeader, credentialSha256: digest(claude ? secret : `Bearer ${secret}`),
    target: claude ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/responses',
    body, bodySha256: digest(body), clockId: processMonotonicClock.id, signal: new AbortController().signal };
  const ceiling: CurrentBenchNativeInputCeiling = { model: f.arm.model, inputTokens: 10_000,
    sourceSha256: f.rate.inputTokenCeilingSourceSha256!, validUntilMonotonicMs: processMonotonicClock.now() + 10_000,
    validateAuthorization: vi.fn(() => {}) };
  type Ports = NonNullable<Parameters<typeof currentBenchProviderAuthenticator>[1]>;
  const ports: Ports = { readAccount: vi.fn<Ports['readAccount']>(async () => ({ id: attempt.accountId, provider: claude ? 'claude' : 'codex',
    credentialRef: 'token:offline' })), credentialResolver: vi.fn<Ports['credentialResolver']>(() => ({ kind: 'token', authMode: claude ? 'api-key' : 'oauth',
      current: async () => secret, invalidate: () => {} })) };
  const input = { workspaceId: 'bench-private', preregHash, protocol: f.protocol, armId: f.arm.id, taskId: 't1', seed: 1,
    readNativeInputCeiling: vi.fn(async () => ceiling) };
  const auth = currentBenchProviderAuthenticator(input, ports);
  return { ...f, input, ports, attempt, ceiling, auth };
}

describe('Proximus uses existing final-provider accounting authority', () => {
  it.each(['openai', 'anthropic'] as const)('reserves the authenticated %s request on the existing assignment ledger', async provider => {
    const f = providerFixture(provider);
    const reserve = vi.fn(async (_sql: Sql, q: ReserveLearningSpendInput) => {
      const reservation: LearningSpendReservation = { id: q.exact!.reservationId, workspaceId: q.workspaceId,
        loopId: q.loopId, potSlug: null, attemptKind: q.attemptKind!, requestedUsd: q.requestedUsd,
        reservedUsd: q.requestedUsd, usedUsd: 0, status: 'open', signalOrigin: 'organic',
        runRef: `manifest:${q.exact!.binding}/attempt:${q.exact!.reservationId}`, resources: { ...q.exact!.resources! },
        note: q.note ?? null, createdAt: Date.now(), settledAt: null };
      return { ok: true as const, clamped: false, headroomUsd: 60, reservation };
    });
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: f.auth.authenticateProvider,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } }, {
      enabled: async () => true, getSql: async () => ({} as Sql), reserve,
      settle: vi.fn(async () => ({ ok: false as const, reason: 'not-found' as const, reservation: null })),
      recordAttemptResult: vi.fn(async () => ({ ok: true })), log: () => {},
    });
    try {
      const receipt = await controller.gateway.carryTrial.authorizeAttempt(f.attempt);
      expect(receipt).not.toBeNull();
      expect(reserve).toHaveBeenCalledTimes(1);
      const saved = reserve.mock.calls[0][1];
      expect(saved.exact!.resources!.armId).toBe(f.attempt.armId);
      expect(saved.requestedUsd).toBe(provider === 'openai' ? 0.01002 : 0.01252);
      const note = JSON.parse(saved.note!);
      expect(note.nativeGatewayAttempt).toMatchObject({ bodySha256: f.attempt.bodySha256, transport: f.attempt.transport });
      expect(saved.note).not.toContain('offline-test-credential');
      // This deliberately leaves the provider result unknown: admission is not
      // a response, bill, terminal usage census or native acceptance claim.
    } finally { controller.revoke(); f.auth.revoke(); }
  });
  it.each(['openai', 'anthropic'] as const)('authorizes %s only with the final credential and counted frozen input', async provider => {
    const f = providerFixture(provider);
    try {
      const authority = await f.auth.authenticateProvider(f.attempt);
      expect(authority).toMatchObject({ attemptKind: 'evaluation', inputTokens: 10_000, outputTokens: 10 });
      expect(authority!.requestedUsd).toBeGreaterThan(0);
      expect(f.input.readNativeInputCeiling).toHaveBeenCalledTimes(1);
      expect(f.ports.credentialResolver).toHaveBeenCalledWith(provider === 'openai' ? 'codex' : 'claude', 'token:offline');
      authority!.validateAuthorization(); f.auth.revoke();
      expect(() => authority!.validateAuthorization()).toThrow(/revoked/);
    } finally { f.auth.revoke(); }
  });
  it.each(['route', 'model', 'effort', 'credential', 'input-proof', 'foreign-assignment'] as const)
  ('refuses %s drift through the same authenticator', async change => {
    const f = providerFixture('openai');
    let attempt = f.attempt;
    if (change === 'route') attempt = { ...attempt, target: 'https://api.openai.com/v1/chat/completions' };
    if (change === 'model' || change === 'effort') {
      const body = JSON.parse(f.attempt.body);
      if (change === 'model') body.model = 'other-model'; else body.reasoning.effort = 'low';
      const text = JSON.stringify(body); attempt = { ...attempt, body: text, bodySha256: digest(text) };
    }
    if (change === 'credential') attempt = { ...attempt, credentialSha256: digest('other-credential') };
    if (change === 'input-proof') f.ceiling.sourceSha256 = digest('other-count-source');
    if (change === 'foreign-assignment') attempt = { ...attempt, armId: 'other-assignment' };
    try { expect(await f.auth.authenticateProvider(attempt)).toBeNull(); } finally { f.auth.revoke(); }
  });
  it('cannot start a Codex native gateway as a Proximus runtime', async () => {
    const f = providerFixture('openai'), start = vi.fn();
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: async () => null,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } });
    try {
      await expect(controller.startNativeGateway(() => {}, start)).rejects.toThrow(/unsupported/);
      expect(start).not.toHaveBeenCalled();
    } finally { controller.revoke(); f.auth.revoke(); }
  });
  it.each(['openai', 'anthropic'] as const)('issues an explicit %s host grant and revokes copied/stale/foreign grants', async provider => {
    const f = providerFixture(provider), stop = vi.fn(async () => {});
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: f.auth.authenticateProvider,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } });
    const start = vi.fn(async () => ({ port: 32105, stop } as never));
    try {
      const hosted = await controller.startHostGateway(() => {}, start);
      const assignment = { armId: f.arm.id, taskId: 't1', seed: 1 };
      expect(requireCurrentBenchHostReferenceGateway(hosted, f.protocol, assignment)).toBe(hosted);
      expect(hosted.agent).toBe('proximus');
      expect(hosted.gateway.baseURL).toBe('http://127.0.0.1:32105');
      expect('nativeGateway' in hosted).toBe(false);
      expect('issueSessionBudget' in hosted).toBe(false);
      expect(() => requireCurrentBenchHostReferenceGateway({ ...hosted }, f.protocol, assignment)).toThrow(/controller-issued/);
      expect(() => requireCurrentBenchHostReferenceGateway(hosted, f.protocol, { ...assignment, seed: 2 })).toThrow(/assignment/);
      const changed = structuredClone(f.protocol); changed.runId = 'another-run';
      expect(() => requireCurrentBenchHostReferenceGateway(hosted, changed, assignment)).toThrow(/assignment/);
      await expect(controller.startHostGateway(() => {}, start)).rejects.toThrow(/already started/);
      expect(start).toHaveBeenCalledTimes(1);
      await hosted.stop(); await hosted.stop();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(() => requireCurrentBenchHostReferenceGateway(hosted, f.protocol, assignment)).toThrow(/live/);
    } finally { controller.revoke(); f.auth.revoke(); }
  });
  it('closes a host listener if authority is revoked while it starts', async () => {
    const f = providerFixture('openai'), stop = vi.fn(async () => {});
    const controller = currentBenchGatewayController({ ...f.input,
      loopId: 'offline-loop', token: digest('offline-gateway-token'), authenticateProvider: f.auth.authenticateProvider,
      resources: { inputTokens: 20_000, outputTokens: 100, requestsPerArm: 2,
        armIds: f.protocol.arms.map(a => currentBenchAssignmentId(f.protocol.runId, a.id, 't1', 1)),
        usdPerArm: 3, maxOpenUsd: 3, wallClockMs: 2_000, wallClockMsPerArm: 1_000 } });
    try {
      await expect(controller.startHostGateway(() => {}, async () => {
        controller.revoke(); return { port: 32106, stop } as never;
      })).rejects.toThrow(/revoked during startup/);
      expect(stop).toHaveBeenCalledTimes(1);
    } finally { controller.revoke(); f.auth.revoke(); }
  });
});
