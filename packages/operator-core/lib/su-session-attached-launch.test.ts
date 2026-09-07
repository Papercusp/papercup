import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(), read: vi.fn(), bind: vi.fn(), bootstrap: vi.fn(), engine: vi.fn(), host: vi.fn(),
  ended: vi.fn(), pid: vi.fn(), persist: vi.fn(),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'workspace' }));
vi.mock('./agent-chats-data', () => ({ getChat: mocks.chat }));
vi.mock('./adv-sessions', () => ({ getAdvSession: vi.fn(), markAdvSessionEnded: mocks.ended, setAdvSessionPid: mocks.pid }));
vi.mock('./native-session-handles', () => ({ nativeSessionHandleForAdvSession: vi.fn() }));
vi.mock('./su-session-host', () => ({ getRegisteredSuSessionHost: mocks.host }));
vi.mock('./su-session-persistence', () => ({ readDurableSuSession: mocks.read, bindSuSessionToAdvSession: mocks.bind, persistSuSessionDescriptor: mocks.persist }));
vi.mock('./su-session-claude-engine', () => ({ startClaudeSuEngine: mocks.engine }));
vi.mock('./endpoint-route/routes/agent-mcp/bootstrap-su', () => ({ bootstrapSu: { handler: mocks.bootstrap } }));
import { launchAttachedSuSession } from './su-session-attached-launch';

const input = { agent: 'claude', agent_chat_id: 'chat', harness_slug: 'project', account: 'default', carry: 'warm' as const };
const request = () => new Request('http://localhost/api/adv/sessions/launch-su', { headers: { authorization: 'Bearer fixture-principal' } });
const boot = { status: 'ok', sessionId: 18, nativeSessionId: 'native-id', agent: 'claude', workspaceId: 'workspace', harnessSlug: 'project', planSlug: null,
  envelopeEnv: { PAPERCUSP_SID: 'su-engine', CLAUDE_CONFIG_DIR: '/configured/claude' } };
const close = vi.fn(async () => undefined);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.chat.mockResolvedValue({ ok: true, data: { archived_at: null, su_runtime_class: 'su-session' } });
  mocks.read.mockResolvedValue(null);
  mocks.bind.mockResolvedValue({ status: 'bound' });
  mocks.bootstrap.mockImplementation(async () => Response.json(boot));
  mocks.engine.mockReturnValue({ ready: Promise.resolve(), done: new Promise(() => {}), close, pid: () => 4321,
    adapter: { host: { descriptor: () => ({ lifecycle: 'ready' }) } } });
});

describe('attached launch authority', () => {
  it('waits for the engine, preserves the bootstrap principal, and binds before spawn', async () => {
    let ready!: () => void;
    mocks.engine.mockReturnValue({ ...mocks.engine(), ready: new Promise<void>((resolve) => { ready = resolve; }) });
    mocks.engine.mockClear();
    const pending = launchAttachedSuSession(request(), input);
    await vi.waitFor(() => expect(mocks.engine).toHaveBeenCalledOnce());
    expect(mocks.pid).not.toHaveBeenCalled();
    const forwarded = mocks.bootstrap.mock.calls[0][0] as Request;
    expect(forwarded.headers.get('authorization')).toBe('Bearer fixture-principal');
    expect(await forwarded.json()).toMatchObject({ ...input, workspace: 'workspace', headless: true, bootstrap_idempotency_key: 'pui:workspace:chat' });
    expect(mocks.bind.mock.invocationCallOrder[0]).toBeLessThan(mocks.engine.mock.invocationCallOrder[0]);
    ready();
    expect(await (await pending).json()).toMatchObject({ status: 'ok', transport: 'structured', ready: true, advSessionId: 18, ownerId: 'su-engine' });
    expect(mocks.pid).toHaveBeenCalledWith(18, 4321, 'pui-structured-claude');
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
    mocks.host.mockReturnValue({ snapshot: () => ({ executorAttached: false, streamReady: true, terminal: false }) });
    const response = await launchAttachedSuSession(request(), input);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('Reconnect');
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });

  it('closes the allocated runtime and row on readiness failure', async () => {
    mocks.engine.mockImplementation(() => ({ ready: Promise.reject(new Error('startup failure')), close }));
    const response = await launchAttachedSuSession(request(), input);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe('startup failure');
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.ended).toHaveBeenCalledWith(18, null, 'cleanup');
    expect(mocks.pid).not.toHaveBeenCalled();
  });

  it('does not downgrade an unsupported engine to a hidden native client', async () => {
    const response = await launchAttachedSuSession(request(), { ...input, agent: 'codex' });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('attached_engine_unavailable');
    expect(mocks.bootstrap).not.toHaveBeenCalled();
    expect(mocks.engine).not.toHaveBeenCalled();
  });
});
