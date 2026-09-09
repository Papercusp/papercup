import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(), read: vi.fn(), bind: vi.fn(), bootstrap: vi.fn(), engine: vi.fn(), host: vi.fn(),
  ended: vi.fn(), pid: vi.fn(), persist: vi.fn(), reconcile: vi.fn(), rpc: vi.fn(),
  resume: vi.fn(), rehydrate: vi.fn(),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace' }));
vi.mock('./agent-chats-data', () => ({ getChat: mocks.chat }));
vi.mock('./adv-sessions', async (orig) => ({
  ...(await orig<typeof import('./adv-sessions')>()),
  getAdvSession: vi.fn(),
  markAdvSessionEnded: mocks.ended,
  setAdvSessionPid: mocks.pid,
}));
vi.mock('./native-session-handles', () => ({ nativeSessionHandleForAdvSession: vi.fn() }));
vi.mock('./su-session-host', () => ({ getRegisteredSuSessionHost: mocks.host, rehydrateRegisteredSuSessionHost: mocks.rehydrate }));
vi.mock('./su-session-resume', () => ({ prepareStructuredSuResume: mocks.resume }));
vi.mock('./su-session-persistence', () => ({ readDurableSuSession: mocks.read, bindSuSessionToAdvSession: mocks.bind, persistSuSessionDescriptor: mocks.persist }));
vi.mock('./su-session-claude-engine', () => ({ startClaudeSuEngine: mocks.engine }));
vi.mock('./su-session-rpc-engine', () => ({ startSuRpcEngine: mocks.rpc }));
vi.mock('./endpoint-route/routes/agent-mcp/bootstrap-su', () => ({ bootstrapSu: { handler: mocks.bootstrap } }));
import { launchAttachedSuSession } from './su-session-attached-launch';
import { CODEX_SAFE_DEFAULT_MODEL } from './model-context-budget.mjs';

const input = { agent: 'claude', agent_chat_id: 'chat', harness_slug: 'project', account: 'default', carry: 'warm' as const };
const request = () => new Request('http://localhost/api/adv/sessions/launch-su', { headers: { authorization: 'Bearer fixture-principal' } });
const boot = { status: 'ok', sessionId: 18, nativeSessionId: 'native-id', agent: 'claude', workspaceId: 'workspace', harnessSlug: 'project', planSlug: null,
  envelopeEnv: { PAPERCUSP_SID: 'su-engine', CLAUDE_CONFIG_DIR: '/configured/claude' } };
const close = vi.fn(async () => undefined);
const priorApproval = process.env.PUI_REAL_APPROVAL;
const priorFixtureWorkspace = process.env.PUI_OPERATOR_FIXTURE_WORKSPACE;
beforeEach(() => {
  delete process.env.PUI_REAL_APPROVAL;
  delete process.env.PUI_OPERATOR_FIXTURE_WORKSPACE;
  vi.resetAllMocks();
  mocks.chat.mockResolvedValue({ ok: true, data: { archived_at: null, su_runtime_class: 'su-session' } });
  mocks.read.mockResolvedValue(null);
  mocks.resume.mockRejectedValue(new Error('Reconnect requires a saved native session'));
  mocks.bind.mockResolvedValue({ status: 'bound' });
  mocks.bootstrap.mockImplementation(async () => Response.json(boot));
  mocks.engine.mockReturnValue({ ready: Promise.resolve(), done: new Promise(() => {}), close, pid: () => 4321,
    adapter: { reconcileRuntimeExit: mocks.reconcile, host: {
      descriptor: () => ({ lifecycle: 'starting' }), snapshot: () => ({ terminal: false }),
    } } });
  mocks.rpc.mockImplementation(() => ({ ...mocks.engine(), nativeSession: () => null }));
});
afterEach(() => {
  if (priorApproval === undefined) delete process.env.PUI_REAL_APPROVAL;
  else process.env.PUI_REAL_APPROVAL = priorApproval;
  if (priorFixtureWorkspace === undefined) delete process.env.PUI_OPERATOR_FIXTURE_WORKSPACE;
  else process.env.PUI_OPERATOR_FIXTURE_WORKSPACE = priorFixtureWorkspace;
});

describe('attached launch authority', () => {
  it('returns the durable identity before engine readiness and supervises initialization on the host', async () => {
    let ready!: () => void;
    mocks.engine.mockReturnValue({ ...mocks.engine(), ready: new Promise<void>((resolve) => { ready = resolve; }) });
    mocks.engine.mockClear();
    const pending = launchAttachedSuSession(request(), input);
    await vi.waitFor(() => expect(mocks.engine).toHaveBeenCalledOnce());
    // An unresolved native readiness promise must not hold the HTTP request.
    expect(await (await pending).json()).toMatchObject({ status: 'ok', transport: 'structured', ready: false, advSessionId: 18, ownerId: 'su-engine' });
    expect(mocks.pid).not.toHaveBeenCalled();
    expect(mocks.persist).toHaveBeenCalledWith(18, { lifecycle: 'starting' });
    const forwarded = mocks.bootstrap.mock.calls[0][0] as Request;
    expect(forwarded.headers.get('authorization')).toBe('Bearer fixture-principal');
    expect(await forwarded.json()).toMatchObject({ ...input, workspace: 'workspace', headless: true, bootstrap_idempotency_key: 'pui:workspace:chat' });
    expect(mocks.bind.mock.invocationCallOrder[0]).toBeLessThan(mocks.engine.mock.invocationCallOrder[0]);
    ready();
    await vi.waitFor(() => expect(mocks.pid).toHaveBeenCalledWith(18, 4321, 'pui-structured-claude'));
  });

  it('enables prompt approval only for the matching real-provider fixture workspace', async () => {
    process.env.PUI_REAL_APPROVAL = '1';
    process.env.PUI_OPERATOR_FIXTURE_WORKSPACE = 'workspace';
    await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'approval-fixture' });
    expect(mocks.engine.mock.calls[0][3]).toMatchObject({ toolApproval: 'prompt' });

    process.env.PUI_OPERATOR_FIXTURE_WORKSPACE = 'other-workspace';
    await launchAttachedSuSession(request(), { ...input, agent_chat_id: 'ordinary-session' });
    expect(mocks.engine.mock.calls[1][3]).not.toHaveProperty('toolApproval');
  });

  it('coalesces simultaneous retries before any engine is started', async () => {
    const [one, two] = await Promise.all([launchAttachedSuSession(request(), input), launchAttachedSuSession(request(), input)]);
    expect(await one.json()).toEqual(await two.json());
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.engine).toHaveBeenCalledOnce();
  });

  it('refuses legacy and archived chats before allocating an SU identity', async () => {
    for (const data of [{ archived_at: 'now', su_runtime_class: 'su-session' }, { archived_at: null, su_runtime_class: 'legacy-owned-loop' }]) {
      mocks.chat.mockResolvedValue({ ok: true, data });
      expect((await launchAttachedSuSession(request(), input)).status).toBe(503);
    }
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it('does not conceal a lost executor by creating another session', async () => {
    mocks.read.mockResolvedValue({ backend: 'claude', harnessSlug: 'project', advSessionId: 18 });
    mocks.host.mockReturnValue({ snapshot: () => ({ executorAttached: false, streamReady: true, terminal: false, descriptor: { lifecycle: 'ready' } }) });
    const response = await launchAttachedSuSession(request(), input);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/Reconnect|reconnect/);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex', 'omp'])('reattaches saved %s without bootstrap or a new identity', async (agent) => {
    const chatId = `restored-${agent}`;
    const restored = { snapshot: () => ({ executorAttached: false, streamReady: false, terminal: true }) };
    const binding = { operation: 'attached', backend: agent, advSessionId: 18, ownerId: 'su-engine',
      workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'saved-plan' };
    const native = { backend: agent, sessionId: 'saved-native', rolloutId: 'saved-native', ompThreadId: 'saved-native' };
    const options = { agentChatId: chatId, model: 'saved-model', accountRoute: 'saved-account',
      carry: 'cold', modes: ['auto'], runtimeGeneration: 4 };
    const beforeReady = vi.fn(), onExit = vi.fn(), release = vi.fn();
    mocks.read.mockResolvedValue({ backend: agent, harnessSlug: 'project', advSessionId: 18, ownerId: 'su-engine' });
    mocks.rehydrate.mockResolvedValue(restored);
    mocks.resume.mockResolvedValue({ boot: { ...boot, agent }, binding, nativeSession: native,
      options, beforeReady, onExit, release });
    const response = await launchAttachedSuSession(request(), { ...input, agent, agent_chat_id: chatId });
    expect(await response.json()).toMatchObject({ resumed: true, ready: false, advSessionId: 18,
      ownerId: 'su-engine', planSlug: 'saved-plan', nativeSession: native });
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.bind).not.toHaveBeenCalled();
    const call = (agent === 'claude' ? mocks.engine : mocks.rpc).mock.calls[0];
    expect(call[agent === 'claude' ? 3 : 2]).toMatchObject({ ...options, host: restored, beforeReady, onExit,
      ...(agent === 'claude' ? { resume: true } : { nativeSession: native }) });
  });

  it('closes the allocated runtime and row on readiness failure', async () => {
    const runtime = mocks.engine();
    mocks.engine.mockImplementation(() => ({ ...runtime, ready: Promise.reject(new Error('startup failure')) }));
    const response = await launchAttachedSuSession(request(), input);
    expect(response.status).toBe(200);
    expect((await response.json()).ready).toBe(false);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(mocks.reconcile).toHaveBeenCalledWith({ expected: false, reason: 'Error: startup failure' });
    expect(mocks.ended).toHaveBeenCalledWith(18, null, 'cleanup', { throwOnError: true });
    expect(mocks.pid).not.toHaveBeenCalled();
  });

  it('reuses a still-initializing host on a later retry without another bootstrap', async () => {
    let ready!: () => void;
    const runtime = mocks.engine();
    mocks.engine.mockReturnValue({ ...runtime, ready: new Promise<void>((resolve) => { ready = resolve; }) });
    mocks.engine.mockClear();
    await launchAttachedSuSession(request(), input);
    mocks.read.mockResolvedValue({ backend: 'claude', harnessSlug: 'project', advSessionId: 18 });
    mocks.host.mockReturnValue({ snapshot: () => ({ terminal: false, executorAttached: false, streamReady: false, descriptor: { lifecycle: 'starting' } }) });
    const retry = await launchAttachedSuSession(request(), input);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ duplicate: true, ready: false, advSessionId: 18 });
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(mocks.engine).toHaveBeenCalledOnce();
    ready();
    await vi.waitFor(() => expect(mocks.pid).toHaveBeenCalled());
  });

  it('does not downgrade an unsupported engine to a hidden native client', async () => {
    const response = await launchAttachedSuSession(request(), { ...input, agent: 'unsupported' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('attached_engine_unavailable');
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });

  it.each(['codex', 'omp'])('starts %s with a runtime-assigned native id through the same bootstrap', async (agent) => {
    mocks.bootstrap.mockImplementation(async () => Response.json({ ...boot, agent, nativeSessionId: null,
      envelopeEnv: { PAPERCUSP_SID: 'su-engine', CODEX_HOME: '/configured/codex' } }));
    const response = await launchAttachedSuSession(request(), { ...input, agent });
    expect(await response.json()).toMatchObject({ status: 'ok', agent, nativeSession: null, ready: false });
    expect(mocks.rpc).toHaveBeenCalledWith(expect.objectContaining({ agent }),
      expect.objectContaining({ backend: agent, ownerId: 'su-engine', advSessionId: 18 }),
      expect.objectContaining({ accountRoute: 'default', carry: 'warm' }));
    await vi.waitFor(() => expect(mocks.pid).toHaveBeenCalledWith(18, 4321, `pui-structured-${agent}`));
  });

  it.each([
    { model: undefined, expected: CODEX_SAFE_DEFAULT_MODEL, source: 'configured-default' },
    { model: 'gpt-5.6-sol:high', expected: 'gpt-5.6-sol:high', source: 'explicit' },
  ])('carries the visible Codex $source choice through headless bootstrap and execution', async ({ model, expected, source }) => {
    mocks.bootstrap.mockImplementation(async () => Response.json({ ...boot, agent: 'codex', nativeSessionId: null,
      envelopeEnv: { PAPERCUSP_SID: 'su-engine', CODEX_HOME: '/configured/codex' } }));
    const response = await launchAttachedSuSession(request(), { ...input, agent: 'codex', model });
    expect(response.status).toBe(200);
    expect(await (mocks.bootstrap.mock.calls[0][0] as Request).json())
      .toMatchObject({ model: expected, model_source: source, headless: true });
    expect(mocks.rpc.mock.calls[0][2].model).toBe(expected);
  });
});
