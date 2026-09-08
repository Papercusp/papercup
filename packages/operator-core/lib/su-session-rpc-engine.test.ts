import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SU_SESSION_PROTOCOL_VERSION, SU_SESSION_SCHEMA } from '@papercusp/chat-protocol';
import { resolveCardResponse } from '@papercusp/agent-mcp';
import type { BootstrapSuResult } from './endpoint-route/routes/agent-mcp/bootstrap-su';
import type { PuiSuSessionBinding } from './launch-agent';
import type { RpcFrame, SuStdioPeerOptions } from './su-session-stdio-peer';

const mocks = vi.hoisted(() => ({ link: vi.fn(async () => 'linked'), persist: vi.fn(async () => true) }));
vi.mock('./adv-sessions', () => ({ setAdvSessionOmpThreadId: mocks.link }));
vi.mock('./su-session-persistence', () => ({
  bindSuSessionToAdvSession: vi.fn(async () => ({ status: 'bound' })),
  persistSuSessionDescriptor: mocks.persist, readDurableSuSession: vi.fn(), classifySuSessionRuntime: vi.fn(),
}));
vi.mock('./mcp-base-url', () => ({ resolveSpawnHostOperatorBaseUrl: () => 'http://127.0.0.1:3170' }));
vi.mock('./su-session-stdio-peer', () => ({ startSuStdioPeer: vi.fn() }));
vi.mock('../../../apps/operator/scripts/psu-launcher.mjs', () => ({
  assertLaunchPersona: vi.fn(), sanitizeInheritedEnv: () => ({}), applyGithubTokenEnv: vi.fn(),
  modelArgsFor: (backend: string, model: string) => backend === 'codex' ? ['-m', model] : ['--model', model],
  ompCoreToolNames: () => ['tools:invoke'], ompResponsesCompatibilityEnv: () => ({}), recordSessionOwner: vi.fn(),
  resolveOmpInjectHookPath: () => '/configured/inject.ts', writeOmpSessionConfigDir: () => '.papercusp/su-omp-homes/session-71',
  suLaunchArgs: (backend: string) => ({ args: backend === 'codex' ? ['--dangerously-bypass-hook-trust'] : ['--system-prompt', '/sealed/su.md'] }),
}));
import { startSuRpcEngine, type SuRpcEngine } from './su-session-rpc-engine';

const engines: SuRpcEngine[] = [];
const nativeDirs: string[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) { await engine.close(); engine.adapter.dispose(); }
  for (const dir of nativeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
  mocks.persist.mockResolvedValue(true);
});

function fixture(backend: 'codex' | 'omp', overrides: {
  nativeId?: string; tools?: boolean; model?: string;
  request?: (frame: RpcFrame) => Promise<RpcFrame | undefined>;
  resume?: boolean;
  history?: RpcFrame[];
  missingTranscript?: boolean;
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
    expect(f.transport().args).toContain(backend === 'codex' ? 'app-server' : 'rpc');
    // An assigned id and a working executor do not prove native persistence.
    expect(f.engine.nativeSession().exactResumeSupported).toBe(false);
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
    const f = fixture(backend);
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
    expect(f.engine.adapter.host.descriptor().lifecycle).toBe('waiting-for-owner');
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
});

it('recognizes OMP connected MCP devices that are not top-level tools', async () => {
  const f = fixture('omp', { request: async (frame) => frame.type === 'get_state' ? {
    sessionId: 'native-omp', sessionFile: '/configured/omp/session.jsonl',
    model: { provider: 'openai', id: 'omp-model' }, dumpTools: [{ name: 'read' }, { name: 'write' }],
    systemPrompt: ['SU instructions', '## MCP Tool Routes\n\n- tools:invoke → `xd://mcp_papercusp-su_tools_invoke`'],
  } : undefined });
  await f.engine.ready;
  expect(f.engine.adapter.host.snapshot().streamReady).toBe(true);
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
