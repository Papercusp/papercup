import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import type { RpcFrame, SuStdioPeerOptions } from './su-session-stdio-peer';

const mocks = vi.hoisted(() => ({
  link: vi.fn(async () => 'linked'), persist: vi.fn(async () => true),
  writeOmp: vi.fn((_id: number, _options: Record<string, unknown>) => '.papercusp/su-omp-homes/session-71'),
  receipts: vi.fn(async (_identity: unknown): Promise<Array<{ turnId: string; content: string }>> => []),
}));
vi.mock('./su-session-commands', async (orig) => ({
  ...(await orig<typeof import('./su-session-commands')>()),
  loadSuOwnerTurnReceipts: mocks.receipts,
}));
vi.mock('./adv-sessions', async (orig) => ({
  ...(await orig<typeof import('./adv-sessions')>()),
  setAdvSessionOmpThreadId: mocks.link,
}));
vi.mock('./su-session-persistence', () => ({
  bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })),
  persistSuSessionDescriptor: mocks.persist, readDurableSuSession: vi.fn(), classifySuSessionRuntime: vi.fn(),
}));
vi.mock('./mcp-base-url', () => ({ resolveSpawnHostOperatorBaseUrl: () => 'http://127.0.0.1:3170' }));
vi.mock('./su-session-stdio-peer', () => ({ startSuStdioPeer: vi.fn() }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', async (original) => ({
  resolveOmpSessionModel: (await original<typeof import('../../../apps/operator/scripts/psu-launcher.mjs')>()).resolveOmpSessionModel,
  assertLaunchPersona: vi.fn(), sanitizeInheritedEnv: () => ({}), applyGithubTokenEnv: vi.fn(),
  modelArgsFor: (backend: string, model: string) => backend === 'codex' ? ['-m', model] : ['--model', model],
  ompCoreToolNames: () => ['tools:invoke'], ompResponsesCompatibilityEnv: () => ({}), recordSessionOwner: vi.fn(),
  resolveOmpInjectHookPath: () => '/configured/inject.ts', writeOmpSessionConfigDir: mocks.writeOmp,
  suLaunchArgs: (backend: string) => ({ args: backend === 'codex'
    ? ['--dangerously-bypass-hook-trust']
    : ['--approval-mode', 'yolo', '--system-prompt', '/sealed/su.md'] }),
}));
import { codexApprovalsPolicy, startSuRpcEngine, type SuRpcEngine } from './su-session-rpc-engine';

const engines: SuRpcEngine[] = [];
const nativeDirs: string[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) { await engine.close(); engine.adapter.dispose(); }
  for (const dir of nativeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
  mocks.persist.mockResolvedValue(true);
  mocks.receipts.mockResolvedValue([]);
});

function fixture(backend: 'codex' | 'omp', overrides: {
  nativeId?: string; tools?: boolean; model?: string;
  servedAccountReader?: (ownerId: string) => Promise<string | null>;
  request?: (frame: RpcFrame) => Promise<RpcFrame | undefined>;
  resume?: boolean;
  history?: RpcFrame[];
  missingTranscript?: boolean;
  deliveryTimeoutMs?: number;
  beforeReady?: () => Promise<void>;
  toolApproval?: 'prompt';
  identity?: 'su' | 'coding-assistant';
  env?: Record<string, string>;
} = {}) {
  let nativePath = `/configured/${backend}/session.jsonl`;
  if (overrides.resume) {
    const dir = mkdtempSync(join(tmpdir(), `pui-${backend}-history-`));
    nativeDirs.push(dir);
    nativePath = join(dir, 'session.jsonl');
    if (!overrides.missingTranscript) writeFileSync(nativePath, (overrides.history ?? []).map((row) => JSON.stringify(row) + '\n').join(''));
  }
  const binding = { operation: 'created', backend, advSessionId: 71, ownerId: 'su-rpc-fixture',
    workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'plan', nativeSession: null } as PuiSuSessionBinding & { backend: 'codex' | 'omp' };
  const boot: BootstrapSuResult = { status: 'ok', specificationRevision: 'spec', stateRevision: 'state', compositionSource: 'blueprint',
    codexHome: '/configured/codex', coordExtPath: null,
    agent: backend, sessionId: 71, nativeSessionId: null, cwd: '/project', promptFile: '/sealed/su.md',
    workspaceId: 'workspace', harnessSlug: 'project', planSlug: 'plan', envelopeEnv: {
      PAPERCUSP_SID: binding.ownerId!, CODEX_HOME: '/configured/codex', PAPERCUSP_PROFILE: 'engineer',
      ...overrides.env,
    } };
  let transport!: SuStdioPeerOptions;
  let exit!: () => void;
  let failExit!: (error: Error) => void;
  const done = new Promise<void>((resolve, reject) => { exit = resolve; failExit = reject; });
  const sent: RpcFrame[] = [];
  const request = vi.fn(async (frame: RpcFrame) => {
    sent.push(frame);
    const override = await overrides.request?.(frame);
    if (override) return override;
    if (frame.method === 'thread/start' || frame.method === 'thread/resume') return {
      thread: { id: overrides.nativeId ?? 'native-codex', cwd: '/project', path: nativePath },
      model: overrides.model ?? 'codex-model',
    };
    if (frame.method === 'mcpServerStatus/list') return { data: overrides.tools === false ? [] : [{ name: 'papercusp-su', tools: { 'coord:whoami': {} } }] };
    if (frame.method === 'turn/start') return { turn: { id: 'native-turn' } };
    if (frame.method === 'turn/interrupt') transport.onMessage({ method: 'turn/completed', params: {
      threadId: 'native-codex', turn: { id: 'native-turn', status: 'interrupted' },
    } });
    if (frame.type === 'abort') transport.onMessage({ type: 'agent_end' });
    if (frame.type === 'get_state') return {
      sessionId: overrides.nativeId ?? 'native-omp', sessionFile: nativePath,
      model: { provider: 'openai', id: overrides.model ?? 'omp-model' },
      dumpTools: overrides.tools === false ? [] : [{ name: 'mcp__papercusp_su__coord_whoami' }],
    };
    return {};
  });
  const close = vi.fn(async () => { exit(); });
  const nativeSession = backend === 'codex'
    ? { backend: 'codex' as const, source: 'adv_sessions' as const, ownerId: binding.ownerId, codexHome: '/configured/codex', rolloutId: 'native-codex', exactResumeSupported: true, missingReason: null }
    : { backend: 'omp' as const, source: 'adv_sessions' as const, ownerId: binding.ownerId, agentHome: '/configured/omp', ompThreadId: 'native-omp', exactResumeSupported: true, missingReason: null };
  const engine = startSuRpcEngine(boot, binding, {
    agentChatId: `chat-${backend}`, model: backend === 'codex' ? 'codex-model' : 'openai/omp-model',
    startupTimeoutMs: 500,
    deliveryTimeoutMs: overrides.deliveryTimeoutMs,
    servedAccountReader: overrides.servedAccountReader,
    beforeReady: overrides.beforeReady,
    toolApproval: overrides.toolApproval,
    identity: overrides.identity,
    accountRoute: 'default', carry: 'warm', modes: ['auto'], register: false,
    ...(overrides.resume ? { nativeSession } : {}),
    peerFactory: async (options) => { transport = options; return { request, send: (frame) => sent.push(frame), done, close, pid: () => 7171 }; },
  });
  engines.push(engine);
  return { engine, sent, request, close, failExit, transport: () => transport, emit: (frame: RpcFrame) => transport.onMessage(frame) };
}

function command(engine: SuRpcEngine, type: 'owner_turn' | 'interrupt', id: string = type) {
  const base = { schema: SU_SESSION_SCHEMA, protocolVersion: SU_SESSION_PROTOCOL_VERSION,
    commandId: id, issuedAt: new Date().toISOString(), target: engine.adapter.host.descriptor().identity };
  return type === 'owner_turn' ? { ...base, type, turnId: `owner-${id}`, content: 'Hello from PUI' } : { ...base, type };
}

describe.each(['codex', 'omp'] as const)('%s structured SU engine', (backend) => {
  it.each([
    { toolApproval: undefined, codexApproval: 'never', codexSandbox: 'danger-full-access', ompApproval: 'yolo' },
    { toolApproval: 'prompt' as const, codexApproval: 'on-request', codexSandbox: 'workspace-write', ompApproval: 'always-ask' },
  ])('maps tool approval $toolApproval to the native policy', async ({ toolApproval, codexApproval, codexSandbox, ompApproval }) => {
    const f = fixture(backend, toolApproval ? { toolApproval } : {});
    await f.engine.ready;
    if (backend === 'codex') {
      expect(f.sent).toContainEqual(expect.objectContaining({ method: 'thread/start', params: expect.objectContaining({
        approvalPolicy: codexApproval, sandbox: codexSandbox,
      }) }));
    } else {
      const approvalMode = f.transport().args.indexOf('--approval-mode');
      expect(f.transport().args[approvalMode + 1]).toBe(ompApproval);
    }
  });

  it('keeps restored history in startup until the new executor is ready', async () => {
    const history = backend === 'codex' ? [
      { type: 'event_msg', payload: { type: 'user_message', message: 'Saved greeting' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Saved reply' }] } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ] : [
      { type: 'message', id: 'saved-user', message: { role: 'user', content: 'Saved greeting' } },
      { type: 'message', id: 'saved-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Saved reply' }], stopReason: 'stop' } },
    ];
    let beforeReady: ReturnType<SuRpcEngine['adapter']['host']['snapshot']> | undefined;
    const f = fixture(backend, { resume: true, history, beforeReady: async () => {
      beforeReady = f.engine.adapter.host.snapshot();
    } });
    await f.engine.ready;
    expect(beforeReady).toMatchObject({ streamReady: false, executorAttached: false,
      descriptor: { lifecycle: expect.stringMatching(/^(starting|resuming)$/) } });
    expect(f.engine.adapter.host.recent.map(({ event }) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'transcript', phase: 'completed', role: 'assistant', content: 'Saved reply' }),
    ]));
    expect(f.engine.adapter.host.snapshot()).toMatchObject({ streamReady: true, executorAttached: true,
      descriptor: { lifecycle: 'ready' } });
  });

  it('restores historical assistant text before accepting resumed input', async () => {
    const content = [{ type: backend === 'codex' ? 'output_text' : 'text', text: 'Saved assistant reply' }];
    const message = { role: 'assistant', content };
    const history = [backend === 'codex'
      ? { type: 'response_item', payload: { type: 'message', ...message } }
      : { type: 'message', id: 'saved-reply', message }];
    const f = fixture(backend, { resume: true, history });
    await f.engine.ready;
    expect(f.engine.adapter.host.recent.map(({ event }) => event).filter((event) =>
      event.type === 'transcript' && event.phase === 'completed' && event.role === 'assistant'))
      .toEqual([expect.objectContaining({ content: 'Saved assistant reply' })]);
    expect(f.sent.some((frame) => frame.method === 'turn/start' || frame.type === 'prompt')).toBe(false);
  });

  it('shows a restored prompt and its reply under the saved receipt turn id (WI-10004254)', async () => {
    const history = backend === 'codex' ? [
      { type: 'response_item', payload: { type: 'message', id: 'saved-user', role: 'user', content: [{ type: 'input_text', text: 'Saved greeting' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Saved reply' }] } },
      { type: 'event_msg', payload: { type: 'task_complete' } },
    ] : [
      { type: 'message', id: 'saved-user', message: { role: 'user', content: 'Saved greeting' } },
      { type: 'message', id: 'saved-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Saved reply' }], stopReason: 'stop' } },
    ];
    mocks.receipts.mockResolvedValue([{ turnId: 'saved-turn', content: 'Saved greeting' }]);
    const f = fixture(backend, { resume: true, history });
    await f.engine.ready;
    expect(mocks.receipts).toHaveBeenCalledWith(expect.objectContaining({
      agentChatId: `chat-${backend}`, nativeSessionId: backend === 'codex' ? 'native-codex' : 'native-omp',
    }));
    const completed = f.engine.adapter.host.recent.map(({ event }) => event)
      .filter((event) => event.type === 'transcript' && event.phase === 'completed');
    expect(completed).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'owner', content: 'Saved greeting', turnId: 'saved-turn' }),
      expect.objectContaining({ role: 'assistant', content: 'Saved reply', turnId: 'saved-turn' }),
    ]));
  });

  it('refuses resume readiness when saved history cannot be read', async () => {
    const f = fixture(backend, { resume: true, missingTranscript: true });
    await expect(f.engine.ready).rejects.toThrow('ENOENT');
    expect(f.engine.adapter.host.snapshot().streamReady).toBe(false);
  });

  it('refuses readiness when the native identity cannot be persisted', async () => {
    mocks.persist.mockResolvedValue(false);
    const f = fixture(backend);
    await expect(f.engine.ready).rejects.toThrow('Could not persist the native session identity');
    expect(f.engine.adapter.host.snapshot().streamReady).toBe(false);
    expect(f.close).toHaveBeenCalled();
  });

  it('binds the native identity only after protocol and SU-tool initialization', async () => {
    const f = fixture(backend);
    expect(f.engine.adapter.host.snapshot()).toMatchObject({ executorAttached: false, streamReady: false });
    await f.engine.ready;
    expect(f.engine.adapter.host.snapshot()).toMatchObject({ executorAttached: true, streamReady: true,
      descriptor: { identity: { nativeSessionId: `native-${backend}` }, modes: ['auto'], carry: 'warm', accountRoute: 'default' } });
    expect(f.transport().env).toMatchObject({ PAPERCUSP_SID: 'su-rpc-fixture', PAPERCUSP_PROFILE: 'engineer' });
    expect(f.transport().args).toContain(backend === 'codex' ? 'app-server' : 'rpc-ui');
    // An assigned id and a working executor do not prove native persistence.
    expect(f.engine.nativeSession().exactResumeSupported).toBe(false);
  });

  it('waits for durable native identity persistence before signaling readiness', async () => {
    let release!: () => void;
    const persistenceGate = new Promise<void>((resolve) => { release = resolve; });
    let nativePersistenceStarted!: () => void;
    const nativePersistence = new Promise<void>((resolve) => { nativePersistenceStarted = resolve; });
    mocks.persist.mockImplementation(async (...args: unknown[]) => {
      const descriptor = args.find((arg): arg is { identity?: { nativeSessionId?: string | null } } =>
        Boolean(arg && typeof arg === 'object' && 'identity' in arg)) as { identity?: { nativeSessionId?: string | null } } | undefined;
      if (descriptor?.identity?.nativeSessionId) {
        nativePersistenceStarted();
        await persistenceGate;
      }
      return true;
    });
    const f = fixture(backend);
    let ready = false;
    void f.engine.ready.then(() => { ready = true; });
    await nativePersistence;
    await Promise.resolve();
    expect(ready).toBe(false);
    release();
    await f.engine.ready;
    expect(ready).toBe(true);
    expect(mocks.persist.mock.calls).toEqual(expect.arrayContaining([
      [71, expect.objectContaining({
        identity: expect.objectContaining({ nativeSessionId: `native-${backend}` }),
      })],
    ]));
  });

  // pui-chat-first-ux P-016: outside every registered checkout the chat runs
  // the backend's own identity, so there is no SU server to wait for.
  it('starts a coding-assistant session without the SU server, playbook or hooks', async () => {
    const home = mkdtempSync(join(tmpdir(), `pui-${backend}-assistant-`));
    nativeDirs.push(home);
    const codexHome = join(home, 'session-codex');
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, 'config.toml'),
      'project_doc_max_bytes = 0\n[mcp_servers.papercusp-su]\nurl = "http://su"\n[mcp_servers.docs]\nurl = "http://docs"\n');
    writeFileSync(join(codexHome, 'AGENTS.md'), 'SU PLAYBOOK');
    writeFileSync(join(codexHome, 'hooks.json'), '{}');
    mkdirSync(join(home, '.omp', 'agent'), { recursive: true });
    writeFileSync(join(home, '.omp', 'agent', 'mcp.json'), JSON.stringify({
      mcpServers: { 'papercusp-su': { url: 'http://su' }, context7: { url: 'http://c7' } },
    }));

    const f = fixture(backend, { tools: false, identity: 'coding-assistant', env: { CODEX_HOME: codexHome, HOME: home } });
    await f.engine.ready;

    expect(f.sent.some((frame) => frame.method === 'mcpServerStatus/list')).toBe(false);
    if (backend === 'codex') {
      const config = readFileSync(join(codexHome, 'config.toml'), 'utf8');
      expect(config).not.toContain('papercusp-su');
      expect(config).not.toContain('project_doc_max_bytes');
      expect(config).toContain('[mcp_servers.docs]');
      expect(existsSync(join(codexHome, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);
    } else {
      expect(f.transport().args).not.toContain('--system-prompt');
      expect(f.transport().args).toContain('rpc-ui');
      const [, options] = mocks.writeOmp.mock.calls.at(-1)!;
      expect(options).toMatchObject({ discoveryOff: false, toolsAllowlist: null, operatorBearer: null });
      expect(Object.keys(JSON.parse(String(options.mcpJsonContents)).mcpServers)).toEqual(['context7']);
    }
  });

  it('refuses a greeting when the SU tool connection is absent', async () => {
    const f = fixture(backend, { tools: false });
    await expect(f.engine.ready).rejects.toThrow('SU tools are not connected');
    expect(f.engine.adapter.host.snapshot()).toMatchObject({ executorAttached: false, streamReady: false, terminal: true });
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.sent.some((frame) => frame.type === 'prompt' || frame.method === 'turn/start')).toBe(false);
  });

  it('reports the original initialization failure before the terminal lifecycle event', async () => {
    const f = fixture(backend, { request: async () => { throw new Error('native configuration is invalid'); } });
    await expect(f.engine.ready).rejects.toThrow('native configuration is invalid');
    const events = f.engine.adapter.host.recent.map(({ event }) => event);
    const errorIndex = events.findIndex((event) => event.type === 'error' && event.message === 'native configuration is invalid');
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((event) => event.type === 'lifecycle' && event.state === 'failed')).toBeGreaterThan(errorIndex);
  });

  it('preserves an unexpected native process failure through close reconciliation', async () => {
    const f = fixture(backend); await f.engine.ready;
    f.failExit(new Error('native process failed: invalid transport'));
    await expect(f.engine.done).rejects.toThrow('invalid transport');
    expect(f.engine.adapter.host.recent.map(({ event }) => event)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'error', message: 'native process failed: invalid transport' }),
      expect.objectContaining({ type: 'lifecycle', state: 'failed', reason: 'native process failed: invalid transport' }),
    ]));
  });

  it('correlates streaming replies and tools to the submitted owner turn', async () => {
    const servedAccountReader = vi.fn(async (_ownerId: string) => `pool-${backend}-success`);
    const f = fixture(backend, { servedAccountReader });
    await f.engine.ready;
    const dispatch = f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn') as never);
    await expect(dispatch.terminal).resolves.toMatchObject({ status: 'completed' });
    if (backend === 'codex') {
      f.emit({ method: 'item/agentMessage/delta', params: { threadId: 'native-codex', itemId: 'reply', delta: 'Hello' } });
      f.emit({ method: 'item/completed', params: { threadId: 'native-codex', item: { id: 'reply', type: 'agentMessage', text: 'Hello' } } });
      f.emit({ method: 'item/started', params: { threadId: 'native-codex', item: { id: 'call', type: 'mcpToolCall', tool: 'coord:whoami' } } });
      f.emit({ method: 'item/completed', params: { threadId: 'native-codex', item: { id: 'call', type: 'mcpToolCall', tool: 'coord:whoami', status: 'completed' } } });
      f.emit({ method: 'turn/completed', params: { threadId: 'native-codex', turn: { id: 'native-turn', status: 'completed' } } });
    } else {
      f.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } });
      f.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } });
      f.emit({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'coord:whoami', args: {} });
      f.emit({ type: 'tool_execution_end', toolCallId: 'call', toolName: 'coord:whoami', result: { ownerId: 'su-rpc-fixture' } });
      f.emit({ type: 'agent_end' });
    }
    const events = f.engine.adapter.host.recent.map(({ event }) => event);
    const text = events.filter((event) => event.type === 'transcript' && event.phase === 'delta');
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ turnId: 'owner-owner_turn', role: 'assistant', content: 'Hello' });
    expect(events.filter((event) => event.type === 'transcript' && event.phase === 'completed')).toEqual([
      expect.objectContaining({ turnId: 'owner-owner_turn', role: 'assistant', content: 'Hello' }),
    ]);
    expect(events.filter((event) => event.type === 'tool')).toEqual([
      expect.objectContaining({ phase: 'started', turnId: 'owner-owner_turn', callId: 'call' }),
      expect.objectContaining({ phase: 'completed', turnId: 'owner-owner_turn', callId: 'call', isError: false }),
    ]);
    await vi.waitFor(() => expect(f.engine.adapter.host.descriptor()).toMatchObject({
      lifecycle: 'waiting-for-owner', accountServed: `pool-${backend}-success`,
    }));
    expect(servedAccountReader).toHaveBeenCalledWith('su-rpc-fixture');
  });

  it('refreshes the served account after a known native turn failure', async () => {
    const servedAccountReader = vi.fn(async (_ownerId: string) => `pool-${backend}-failure`);
    const f = fixture(backend, { servedAccountReader });
    await f.engine.ready;
    await f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn') as never).terminal;
    if (backend === 'codex') {
      f.emit({ method: 'turn/completed', params: {
        threadId: 'native-codex', turn: { id: 'native-turn', status: 'failed', error: { message: 'no available account' } },
      } });
    } else {
      f.emit({ type: 'response', success: false, error: 'no available account' });
    }
    await vi.waitFor(() => {
      expect(f.engine.adapter.host.recent.map(({ event }) => event)).toContainEqual(expect.objectContaining({
        type: 'error', scope: 'turn', code: `${backend}_turn_failed`, message: 'no available account',
      }));
      expect(f.engine.adapter.host.descriptor()).toMatchObject({
        lifecycle: 'waiting-for-owner', accountServed: `pool-${backend}-failure`,
      });
    });
    expect(servedAccountReader).toHaveBeenCalledWith('su-rpc-fixture');
  });

  it('interrupts the native turn and keeps the connection usable', async () => {
    const f = fixture(backend); await f.engine.ready;
    await f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn') as never).terminal;
    await expect(f.engine.adapter.host.startCommand(command(f.engine, 'interrupt') as never).terminal).resolves.toMatchObject({ status: 'completed' });
    expect(f.sent).toContainEqual(backend === 'codex'
      ? { method: 'turn/interrupt', params: { threadId: 'native-codex', turnId: 'native-turn' } } : { type: 'abort' });
    expect(f.engine.adapter.host.descriptor().lifecycle).toBe('interrupted');
    expect(f.engine.adapter.host.snapshot().streamReady).toBe(true);
  });

  it('routes a real PUI card response back onto the native connection', async () => {
    const f = fixture(backend); await f.engine.ready;
    await f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn')).terminal;
    f.emit(backend === 'codex'
      ? { id: 23, method: 'item/commandExecution/requestApproval', params: { threadId: 'native-codex', command: 'touch approved.txt' } }
      : { type: 'extension_ui_request', id: 'approve', method: 'confirm', title: 'Approve this action?' });
    const opened = f.engine.adapter.host.recent.map(({ event }) => event).find((event) => event.type === 'card' && event.phase === 'opened');
    if (!opened || opened.type !== 'card' || opened.phase !== 'opened') throw new Error('PUI did not receive the native card');
    expect(resolveCardResponse({ correlationId: opened.card.correlationId, action: 'submit',
      payload: { picks: ['0'] }, expectedWorkspaceId: 'workspace' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(f.sent).toContainEqual(backend === 'codex'
      ? { id: 23, result: { decision: 'accept' } }
      : { type: 'extension_ui_response', id: 'approve', confirmed: true }));
  });

  it('resumes only the saved native handle with the same SU scope and context', async () => {
    const f = fixture(backend, { resume: true }); await f.engine.ready;
    if (backend === 'codex') {
      expect(f.sent).toContainEqual(expect.objectContaining({ method: 'thread/resume', params: expect.objectContaining({ threadId: 'native-codex' }) }));
      expect(f.sent.some((frame) => frame.method === 'thread/start')).toBe(false);
    } else expect(f.transport().args.slice(-2)).toEqual(['--resume', 'native-omp']);
    expect(f.engine.adapter.host.descriptor()).toMatchObject({ identity: { ownerId: 'su-rpc-fixture', harnessSlug: 'project', workspaceId: 'workspace' }, modes: ['auto'], carry: 'warm' });
  });

  it('fails closed if resume returns a different native identity', async () => {
    const f = fixture(backend, { resume: true, nativeId: 'wrong-thread' });
    await expect(f.engine.ready).rejects.toThrow('requested native identity');
    expect(f.engine.adapter.host.descriptor().identity.nativeSessionId).toBe(`native-${backend}`);
  });

  it('closes uncertain delivery before another saved turn can be sent', async () => {
    const f = fixture(backend, { request: async (frame) => {
      if (frame.type === 'prompt' || frame.method === 'turn/start') throw new Error('native acknowledgement lost');
      return undefined;
    } });
    await f.engine.ready;
    await expect(f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn') as never).terminal)
      .resolves.toMatchObject({ status: 'refused', refusal: { code: 'engine_delivery_unknown', retryable: false } });
    expect(f.engine.adapter.host.snapshot()).toMatchObject({ terminal: true, streamReady: false });
    await expect(f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn', 'second') as never).terminal)
      .resolves.toMatchObject({ status: 'refused' });
    expect(f.sent.filter((frame) => frame.type === 'prompt' || frame.method === 'turn/start')).toHaveLength(1);
  });

  // pui-chat-first-ux P-026 / D-025: the model picked in /model rides on the
  // next owner turn, and the engine applies it before that turn runs.
  const turnWithModel = (engine: SuRpcEngine, id: string, model: string) =>
    ({ ...command(engine, 'owner_turn', id), model }) as never;

  it('P-026: applies a chosen model to the next turn and names it on the session', async () => {
    const f = fixture(backend); await f.engine.ready;
    const spec = backend === 'codex' ? 'gpt-5.5:high' : 'anthropic/claude-sonnet-4-5:high';
    await expect(f.engine.adapter.host.startCommand(turnWithModel(f.engine, 'switch', spec)).terminal)
      .resolves.toMatchObject({ status: 'completed' });
    if (backend === 'codex') {
      expect(f.sent.find((frame) => frame.method === 'turn/start')?.params)
        .toMatchObject({ model: 'gpt-5.5', effort: 'high' });
    } else {
      const order = f.sent.map((frame) => frame.type).filter((type) => type === 'set_model' || type === 'set_thinking_level' || type === 'prompt');
      expect(order).toEqual(['set_model', 'set_thinking_level', 'prompt']);
      expect(f.sent).toContainEqual({ type: 'set_model', provider: 'anthropic', modelId: 'claude-sonnet-4-5' });
      expect(f.sent).toContainEqual({ type: 'set_thinking_level', level: 'high' });
    }
    expect(f.engine.adapter.host.descriptor().model).toBe(spec);
  });

  it('P-026: a turn naming the current model does not switch', async () => {
    const f = fixture(backend); await f.engine.ready;
    const current = backend === 'codex' ? 'codex-model' : 'openai/omp-model';
    await f.engine.adapter.host.startCommand(turnWithModel(f.engine, 'same', current)).terminal;
    expect(f.sent.some((frame) => frame.type === 'set_model')).toBe(false);
    const start = f.sent.find((frame) => frame.method === 'turn/start')?.params as Record<string, unknown> | undefined;
    expect(start?.model).toBeUndefined();
  });

  if (backend === 'omp') {
    it('P-026: a refused OMP switch refuses the turn, sends nothing and keeps the session usable', async () => {
      const f = fixture(backend, { request: async (frame) => {
        if (frame.type === 'set_model') throw new Error('Model not found: anthropic/nope');
        return undefined;
      } });
      await f.engine.ready;
      await expect(f.engine.adapter.host.startCommand(turnWithModel(f.engine, 'refused', 'anthropic/nope')).terminal)
        .resolves.toMatchObject({ status: 'refused', refusal: { code: 'model_switch_refused', retryable: false } });
      expect(f.sent.some((frame) => frame.type === 'prompt')).toBe(false);
      expect(f.engine.adapter.host.snapshot()).toMatchObject({ terminal: false, streamReady: true });
      expect(f.engine.adapter.host.descriptor().model).not.toBe('anthropic/nope');
      await expect(f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn', 'after') as never).terminal)
        .resolves.toMatchObject({ status: 'completed' });
      expect(f.sent.filter((frame) => frame.type === 'prompt')).toHaveLength(1);
    });
  }

  // pui-chat-first-ux P-027 / D-026: /approvals rides on the next owner turn
  // the same way the model does.
  const turnWithApprovals = (engine: SuRpcEngine, id: string, approvals: string) =>
    ({ ...command(engine, 'owner_turn', id), approvals }) as never;

  if (backend === 'codex') {
    it('D-026: sends the chosen approvals mode on turn/start and names it on the session', async () => {
      const f = fixture(backend); await f.engine.ready;
      await expect(f.engine.adapter.host.startCommand(turnWithApprovals(f.engine, 'ro', 'read-only')).terminal)
        .resolves.toMatchObject({ status: 'completed' });
      expect(f.sent.find((frame) => frame.method === 'turn/start')?.params)
        .toMatchObject({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
      expect(f.engine.adapter.host.descriptor().approvals).toBe('read-only');
      // The same mode again does not resend the override.
      await f.engine.adapter.host.startCommand(turnWithApprovals(f.engine, 'ro-again', 'read-only')).terminal;
      const starts = f.sent.filter((frame) => frame.method === 'turn/start').map((frame) => frame.params as Record<string, unknown>);
      expect(starts).toHaveLength(2);
      expect(starts[1]!.approvalPolicy).toBeUndefined();
    });

    it('D-026: maps every mode to a Codex policy and has no full-access mode', () => {
      expect(codexApprovalsPolicy('ask')).toEqual({ approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite' } });
      expect(codexApprovalsPolicy('auto-edit')).toEqual({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } });
      expect(codexApprovalsPolicy('read-only')).toEqual({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } });
    });
  } else {
    it('D-026: OMP refuses an approvals switch, sends no prompt and stays usable', async () => {
      const f = fixture(backend); await f.engine.ready;
      await expect(f.engine.adapter.host.startCommand(turnWithApprovals(f.engine, 'ask', 'ask')).terminal)
        .resolves.toMatchObject({ status: 'refused', refusal: { code: 'approvals_switch_refused', retryable: false } });
      expect(f.sent.some((frame) => frame.type === 'prompt')).toBe(false);
      expect(f.engine.adapter.host.descriptor().approvals).toBeUndefined();
      await expect(f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn', 'after') as never).terminal)
        .resolves.toMatchObject({ status: 'completed' });
    });
  }
});

// WI-10003604: the OMP session's papercusp-su bearer must be the token THIS operator validates
// ($PAPERCUSP_HOME/superuser-token), not the one baked into the user's ~/.omp template — the
// installed-product run failed every OMP turn with superuser_invalid_bearer when they differed.
it('hands OMP the superuser token this operator validates', async () => {
  const papercuspHome = mkdtempSync(join(tmpdir(), 'rpc-su-token-'));
  nativeDirs.push(papercuspHome);
  writeFileSync(join(papercuspHome, 'superuser-token'), 'operator-validated-token-0123456789\n');
  vi.stubEnv('PAPERCUSP_HOME', papercuspHome);
  try {
    const f = fixture('omp');
    await f.engine.ready;
    const [, options] = mocks.writeOmp.mock.calls.at(-1)!;
    expect(options).toMatchObject({ operatorBearer: 'operator-validated-token-0123456789' });
  } finally { vi.unstubAllEnvs(); }
});

it('enables native OMP question callbacks through the RPC UI transport', async () => {
  const f = fixture('omp');
  await f.engine.ready;
  const args = f.transport().args;
  expect(args[args.indexOf('--mode') + 1]).toBe('rpc-ui');
});

it('refuses an OMP gateway model reported under the default account before inference', async () => {
  const f = fixture('omp', { request: async (frame) => frame.type === 'get_state' ? {
    sessionId: 'native-omp', model: { provider: 'papercusp-gateway', id: 'claude-sonnet-4-6' },
    dumpTools: [{ name: 'mcp__papercusp_su__coord_whoami' }],
  } : undefined });
  await expect(f.engine.ready).rejects.toThrow(/default.*gateway/i);
  expect(f.engine.adapter.host.snapshot().streamReady).toBe(false);
  expect(f.sent.some((frame) => frame.type === 'prompt')).toBe(false);
});

it('refuses an OMP native model substitution before sending an owner turn', async () => {
  const f = fixture('omp', { model: 'another-model' });
  await expect(f.engine.ready).rejects.toThrow('OMP selected openai/another-model, expected openai/omp-model');
  expect(f.engine.adapter.host.snapshot().streamReady).toBe(false);
  expect(f.sent.some((frame) => frame.type === 'prompt')).toBe(false);
});

it.each([
  ['SU instructions', '## MCP Tool Routes\n\n- tools:invoke → `xd://mcp_papercusp-su_tools_invoke`'],
  ['SU instructions\n\n## MCP Tool Routes\n\n- tools:invoke → `xd://mcp__papercusp_su_tools_invoke`\n\n## MCP Server Instructions\nserver guidance', 'dynamic context'],
])('recognizes OMP connected MCP devices in a composed prompt (%#)', async (...systemPrompt) => {
  const f = fixture('omp', { request: async (frame) => frame.type === 'get_state' ? {
    sessionId: 'native-omp', sessionFile: '/configured/omp/session.jsonl',
    model: { provider: 'openai', id: 'omp-model' }, dumpTools: [{ name: 'read' }, { name: 'write' }],
    systemPrompt,
  } : undefined });
  await f.engine.ready;
  expect(f.engine.adapter.host.snapshot().streamReady).toBe(true);
});

it('does not treat a launch-prompt mention of an OMP MCP path as a connected device', async () => {
  const f = fixture('omp', { request: async (frame) => frame.type === 'get_state' ? {
    sessionId: 'native-omp', sessionFile: '/configured/omp/session.jsonl',
    model: { provider: 'openai', id: 'omp-model' }, dumpTools: [{ name: 'read' }, { name: 'write' }],
    systemPrompt: ['Use xd://mcp__papercusp_su_tools_invoke after connecting your server.'],
  } : undefined });
  await expect(f.engine.ready).rejects.toThrow('OMP SU tools are not connected');
});

it('keeps OMP input closed until the native SU connection arrives after RPC readiness', async () => {
  let connected = false;
  const f = fixture('omp', { request: async (frame) => frame.type === 'get_state' ? {
    sessionId: 'native-omp', sessionFile: '/configured/omp/session.jsonl',
    model: { provider: 'openai', id: 'omp-model' }, dumpTools: [{ name: 'read' }],
    systemPrompt: connected ? ['## MCP Server Instructions\n\n### papercusp-su\nConnected.'] : [],
  } : undefined });
  await vi.waitFor(() => expect(f.sent.some((frame) => frame.type === 'get_state')).toBe(true));
  expect(f.engine.adapter.host.snapshot().streamReady).toBe(false);
  const pendingInput = await f.engine.adapter.host.acceptCommand(command(f.engine, 'owner_turn'));
  await expect(pendingInput.terminal).resolves.toMatchObject({ status: 'refused', refusal: { code: 'session_not_ready' } });
  expect(f.sent.some((frame) => frame.type === 'prompt')).toBe(false);
  connected = true;
  await f.engine.ready;
  expect(f.engine.adapter.host.snapshot().streamReady).toBe(true);
});

it('refuses a different OMP native identity arriving with the delayed tool connection', async () => {
  let requests = 0;
  const f = fixture('omp', { request: async (frame) => frame.type === 'get_state' ? {
    sessionId: ++requests === 1 ? 'native-omp' : 'another-session',
    model: { provider: 'openai', id: 'omp-model' },
    dumpTools: requests === 1 ? [] : [{ name: 'mcp__papercusp_su__coord_whoami' }],
  } : undefined });
  await expect(f.engine.ready).rejects.toThrow('OMP did not return the requested native identity');
  expect(f.sent.some((frame) => frame.type === 'prompt')).toBe(false);
});

it.each(['papercusp-su', 'another-server'])('uses exact native connected-server evidence when the OMP map is bounded (%s)', async (server) => {
  const f = fixture('omp', { request: async (frame) => frame.type === 'get_state' ? {
    sessionId: 'native-omp', sessionFile: '/configured/omp/session.jsonl',
    model: { provider: 'openai', id: 'omp-model' }, dumpTools: [{ name: 'read' }, { name: 'write' }],
    systemPrompt: ['SU instructions mentioning papercusp-su\n\n## MCP Tool Routes\n\n- other → `xd://mcp__other_tool`\nAdditional mounted MCP tool mappings omitted: prompt bounded.\n\n## MCP Server Instructions\n\n' +
      `### ${server}\nConnected server instructions.\n\n## Other section\n### papercusp-su\nAn unrelated mention.`],
  } : undefined });
  if (server === 'papercusp-su') {
    await f.engine.ready;
    expect(f.engine.adapter.host.snapshot().streamReady).toBe(true);
  } else await expect(f.engine.ready).rejects.toThrow('OMP SU tools are not connected');
});

it('settles an OMP interrupt from the native idle acknowledgement when no agent_end was emitted', async () => {
  const f = fixture('omp', { deliveryTimeoutMs: 25,
    request: async (frame) => frame.type === 'abort' ? {} : undefined });
  await f.engine.ready;
  const identity = f.engine.adapter.host.descriptor().identity;
  await f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn')).terminal;
  await expect(f.engine.adapter.host.startCommand(command(f.engine, 'interrupt')).terminal)
    .resolves.toMatchObject({ status: 'completed' });
  expect(f.engine.adapter.host.descriptor().lifecycle).toBe('interrupted');
  expect(f.engine.adapter.host.snapshot().streamReady).toBe(true);
  expect(f.close).not.toHaveBeenCalled();
  await expect(f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn', 'followup')).terminal)
    .resolves.toMatchObject({ status: 'completed' });
  f.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Resumed reply' }] } });
  f.emit({ type: 'agent_end' });
  expect(f.engine.adapter.host.descriptor().identity).toEqual(identity);
  expect(f.engine.adapter.host.recent.some(({ event }) => event.type === 'transcript'
    && event.phase === 'completed' && event.turnId === 'owner-followup' && event.content === 'Resumed reply')).toBe(true);
});

it('makes an unacknowledged OMP interrupt visibly failed instead of leaving the session running', async () => {
  const f = fixture('omp', { request: async (frame) => {
    if (frame.type === 'abort') throw new Error('Native abort acknowledgement timed out');
    return undefined;
  } });
  await f.engine.ready;
  await f.engine.adapter.host.startCommand(command(f.engine, 'owner_turn')).terminal;
  await expect(f.engine.adapter.host.startCommand(command(f.engine, 'interrupt')).terminal)
    .resolves.toMatchObject({ status: 'refused' });
  expect(f.engine.adapter.host.descriptor().lifecycle).toBe('failed');
  expect(f.engine.adapter.host.snapshot().streamReady).toBe(false);
  expect(f.close).toHaveBeenCalledOnce();
});

it('rejects a Codex approval from a different thread before opening a card', async () => {
  const f = fixture('codex'); await f.engine.ready;
  expect(() => f.emit({ id: 'wrong', method: 'item/commandExecution/requestApproval',
    params: { threadId: 'another-session', command: 'touch wrong.txt' } })).toThrow('different thread');
  expect(f.engine.adapter.host.recent.some(({ event }) => event.type === 'card')).toBe(false);
  expect(f.sent.some((frame) => frame.id === 'wrong')).toBe(false);
});

it.each(['thread/start', 'mcpServerStatus/list'])('accepts matching Codex startup notifications during %s', async (method) => {
  const f = fixture('codex', { request: async (frame) => {
    if (frame.method === method) f.emit({ method: 'mcpServer/startupStatus/updated', params: {
      threadId: 'native-codex', name: 'papercusp-su', status: 'starting',
    } });
    return undefined;
  } });
  await f.engine.ready;
  expect(f.engine.adapter.host.snapshot()).toMatchObject({ streamReady: true,
    descriptor: { identity: { nativeSessionId: 'native-codex' } } });
});

it('validates a queued pre-identity Codex approval before it can open a card', async () => {
  const f = fixture('codex', { request: async (frame) => {
    if (frame.method === 'thread/start') f.emit({ id: 'early-wrong', method: 'item/commandExecution/requestApproval',
      params: { threadId: 'another-session', command: 'touch wrong.txt' } });
    return undefined;
  } });
  await expect(f.engine.ready).rejects.toThrow('different thread');
  expect(f.engine.adapter.host.recent.some(({ event }) => event.type === 'card')).toBe(false);
  expect(f.sent.some((frame) => frame.id === 'early-wrong')).toBe(false);
});
