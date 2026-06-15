/**
 * operator:delegate — handler coverage (the streaming delegate-claude tool).
 *
 * The handler is the orchestration seam: principal/workspace gate → session
 * resolve → delegated-task work_item create/resume → memory-injection →
 * prompt composition → mcpConfig assembly → runAgentChat stream loop →
 * post-stream side-effects. Every IO dependency is mocked so this file pins
 * the *control flow* (which branch fires, what gets forwarded, what is
 * emitted) without a DB, fs, or live model.
 *
 * Run with:
 *   cd packages/operator-core && npx vitest run lib/agent-tools/operator/delegate.test.ts
 *
 * Note `tool.handler(args, ctx)` is the raw role-gated handler — it does NOT
 * run the Zod `args` validation (the projection wrapper does at dispatch
 * time), so we call it with already-shaped args, matching the sibling
 * dedup_check.test.ts / misc.test.ts convention.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatEvent } from '@papercusp/papercup-shared/agent';

// ── hoisted mock fns (set per-test, read inside vi.mock factories) ──────────
const mocks = vi.hoisted(() => ({
  readSystemPrincipal: vi.fn(),
  activeWorkspaceId: vi.fn(() => 'ws-1'),
  resolveDelegateSession: vi.fn(),
  createDelegatedTask: vi.fn(),
  findOpenDelegatedTask: vi.fn(),
  recordDelegateTurn: vi.fn(),
  generateTaskTitle: vi.fn(),
  surfaceBackend: vi.fn(async () => undefined as string | undefined),
  surfaceModel: vi.fn(async () => undefined as string | undefined),
  buildMemoryContextBlock: vi.fn(async () => null as string | null),
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] as Array<{ slug: string }> })),
  operatorApiBase: vi.fn(() => 'http://op.base'),
  readFileSync: vi.fn(() => ''),
  runAgentChat: vi.fn(),
}));

vi.mock('../../system-principal', () => ({ readSystemPrincipal: mocks.readSystemPrincipal }));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: mocks.activeWorkspaceId }));
vi.mock('./delegate-session', () => ({ resolveDelegateSession: mocks.resolveDelegateSession }));
vi.mock('../../delegated-tasks', () => ({
  createDelegatedTask: mocks.createDelegatedTask,
  findOpenDelegatedTask: mocks.findOpenDelegatedTask,
  recordDelegateTurn: mocks.recordDelegateTurn,
}));
vi.mock('../../delegate-summary', () => ({ generateTaskTitle: mocks.generateTaskTitle }));
vi.mock('../../agent-config', () => ({
  surfaceBackend: mocks.surfaceBackend,
  surfaceModel: mocks.surfaceModel,
}));
vi.mock('../../memory/injection', () => ({ buildMemoryContextBlock: mocks.buildMemoryContextBlock }));
vi.mock('../../harness-registry', () => ({ loadHarnessRegistry: mocks.loadHarnessRegistry }));
vi.mock('../../operator-api-base', () => ({ operatorApiBase: mocks.operatorApiBase }));
vi.mock('node:fs', () => ({ readFileSync: mocks.readFileSync }));
vi.mock('../../agent-chat-stream', () => ({ runAgentChat: mocks.runAgentChat }));
// Keep ALL_AGENT_MCP_TOOLS real-ish but cheap — the real module is fine, but
// mocking avoids dragging its transitive deps into the unit graph.
vi.mock('../../operator-mcp-tools', () => ({ ALL_AGENT_MCP_TOOLS: ['mcp__agentmcp__tasks:list'] }));

// Import after mocks are registered.
import tool from './delegate';

type EmitName = 'session' | 'delta' | 'tool_call' | 'error';
interface CapturedEmit {
  name: EmitName;
  payload: Record<string, unknown>;
}

function makeCtx(emits: CapturedEmit[]) {
  const ctrl = new AbortController();
  return {
    log: vi.fn(),
    signal: ctrl.signal,
    progress: vi.fn(),
    emit: vi.fn((name: EmitName, payload: Record<string, unknown>) => {
      emits.push({ name, payload });
    }),
    workspaceId: 'ws-1',
    harnessSlug: 'sheets',
    role: 'operator' as const,
    runId: 'run_T',
    spawnId: 'spw_T',
  } as never;
}

/** Build an async-generator factory yielding the given scripted ChatEvents. */
function scriptStream(events: ChatEvent[]) {
  return () =>
    (async function* () {
      for (const ev of events) yield ev;
    })();
}

function parsePayload(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

const BASE_TASK = { id: 'wi-1' };

beforeEach(() => {
  // default-happy wiring; individual tests override.
  mocks.readSystemPrincipal.mockResolvedValue({
    bearer: 'tok',
    name: 'operator',
    workspaceId: 'ws-1',
    capabilities: [],
  });
  mocks.activeWorkspaceId.mockReturnValue('ws-1');
  mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'sess-resolved', sessionCreated: true });
  mocks.createDelegatedTask.mockResolvedValue(BASE_TASK);
  mocks.findOpenDelegatedTask.mockResolvedValue(BASE_TASK);
  mocks.recordDelegateTurn.mockResolvedValue(undefined);
  mocks.generateTaskTitle.mockResolvedValue(undefined);
  mocks.surfaceBackend.mockResolvedValue(undefined);
  mocks.surfaceModel.mockResolvedValue(undefined);
  mocks.buildMemoryContextBlock.mockResolvedValue(null);
  mocks.loadHarnessRegistry.mockResolvedValue({ projects: [] });
  mocks.operatorApiBase.mockReturnValue('http://op.base');
  mocks.readFileSync.mockReturnValue('');
  mocks.runAgentChat.mockImplementation(scriptStream([{ type: 'delta', text: 'hi' }]));
});

afterEach(() => {
  vi.clearAllMocks();
});

// ── principal + workspace gate ──────────────────────────────────────────────
describe('operator:delegate — principal + workspace gate', () => {
  it("throws 'Papercup principal not provisioned' when readSystemPrincipal returns null (never streams)", async () => {
    mocks.readSystemPrincipal.mockResolvedValue(null);
    await expect(tool.handler({ requestText: 'do it' }, makeCtx([]))).rejects.toThrow(
      /Papercup principal not provisioned/,
    );
    expect(mocks.runAgentChat).not.toHaveBeenCalled();
    expect(mocks.resolveDelegateSession).not.toHaveBeenCalled();
  });

  it('throws the workspace-mismatch error when principal.workspaceId != activeWorkspaceId() (never streams)', async () => {
    mocks.readSystemPrincipal.mockResolvedValue({
      bearer: 't',
      name: 'operator',
      workspaceId: 'ws-OTHER',
      capabilities: [],
    });
    mocks.activeWorkspaceId.mockReturnValue('ws-1');
    await expect(tool.handler({ requestText: 'do it' }, makeCtx([]))).rejects.toThrow(
      /workspace mismatch \(file=ws-OTHER active=ws-1\)/,
    );
    expect(mocks.runAgentChat).not.toHaveBeenCalled();
  });
});

// ── session resolution ──────────────────────────────────────────────────────
describe('operator:delegate — session resolution', () => {
  it('preResolved + sessionId path uses sessionId as-is, derives sessionCreated from !!input.sessionCreated, and skips resolveDelegateSession', async () => {
    const emits: CapturedEmit[] = [];
    const result = await tool.handler(
      { requestText: 'go', preResolved: true, sessionId: 'pre-123', sessionCreated: true },
      makeCtx(emits),
    );
    expect(mocks.resolveDelegateSession).not.toHaveBeenCalled();
    const payload = parsePayload(result as never);
    expect(payload.agentSessionId).toBe('pre-123');
    expect(payload.sessionCreated).toBe(true);
    // session event reflects the same id + created flag.
    expect(emits[0]).toEqual({ name: 'session', payload: { agentSessionId: 'pre-123', created: true } });
  });

  it('preResolved without sessionCreated coerces sessionCreated to false (resume semantics)', async () => {
    const result = await tool.handler(
      { requestText: 'go', preResolved: true, sessionId: 'pre-123' },
      makeCtx([]),
    );
    expect(parsePayload(result as never).sessionCreated).toBe(false);
    // resume path → findOpenDelegatedTask, not create.
    expect(mocks.findOpenDelegatedTask).toHaveBeenCalledWith('pre-123');
    expect(mocks.createDelegatedTask).not.toHaveBeenCalled();
  });

  it('preResolved WITHOUT a sessionId falls through to resolveDelegateSession', async () => {
    // preResolved is only honored alongside an explicit sessionId.
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'fresh', sessionCreated: true });
    const result = await tool.handler({ requestText: 'go', preResolved: true }, makeCtx([]));
    expect(mocks.resolveDelegateSession).toHaveBeenCalledWith('ws-1', undefined, false);
    expect(parsePayload(result as never).agentSessionId).toBe('fresh');
  });

  it('non-preResolved path calls resolveDelegateSession(workspaceId, sessionId, !!newSession) and adopts its id/created', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'resumed-x', sessionCreated: false });
    const result = await tool.handler(
      { requestText: 'go', sessionId: 'want-x', newSession: false },
      makeCtx([]),
    );
    expect(mocks.resolveDelegateSession).toHaveBeenCalledWith('ws-1', 'want-x', false);
    const payload = parsePayload(result as never);
    expect(payload.agentSessionId).toBe('resumed-x');
    expect(payload.sessionCreated).toBe(false);
  });

  it('forwards newSession=true into resolveDelegateSession as the forceNew flag', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'minted', sessionCreated: true });
    await tool.handler({ requestText: 'go', sessionId: 'want-x', newSession: true }, makeCtx([]));
    expect(mocks.resolveDelegateSession).toHaveBeenCalledWith('ws-1', 'want-x', true);
  });
});

// ── delegated-task work_item create vs resume ───────────────────────────────
describe('operator:delegate — delegated-task work_item', () => {
  it('on a new session creates the task with an 8-word/200-char title + 2000-char summary', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'sess-new', sessionCreated: true });
    mocks.surfaceBackend.mockResolvedValue(undefined);
    const longRequest = Array.from({ length: 20 }, (_v, i) => `word${i}`).join(' ');
    await tool.handler({ requestText: longRequest }, makeCtx([]));
    expect(mocks.findOpenDelegatedTask).not.toHaveBeenCalled();
    expect(mocks.createDelegatedTask).toHaveBeenCalledTimes(1);
    const arg = mocks.createDelegatedTask.mock.calls[0][0] as {
      title: string;
      summary: string;
      agentSessionId: string;
      origin: string;
      backend: string;
    };
    // first 8 whitespace-split words
    expect(arg.title).toBe('word0 word1 word2 word3 word4 word5 word6 word7');
    expect(arg.summary).toBe(longRequest.slice(0, 2000));
    expect(arg.agentSessionId).toBe('sess-new');
    expect(arg.origin).toBe('voice');
    // global default backend (surfaceBackend undefined) → claude-code
    expect(arg.backend).toBe('claude-code');
  });

  it("truncates a >200-char title to 200 chars and the summary to 2000 chars", async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: true });
    // a single 'word' of 5000 chars — no whitespace, so slice(0,8 words) keeps it whole,
    // then .slice(0,200) caps the title; summary caps at 2000.
    const huge = 'x'.repeat(5000);
    await tool.handler({ requestText: huge }, makeCtx([]));
    const arg = mocks.createDelegatedTask.mock.calls[0][0] as { title: string; summary: string };
    expect(arg.title).toHaveLength(200);
    expect(arg.summary).toHaveLength(2000);
  });

  it("falls back to 'delegated task' title when requestText is whitespace-only", async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: true });
    await tool.handler({ requestText: '   \t  \n ' }, makeCtx([]));
    const arg = mocks.createDelegatedTask.mock.calls[0][0] as { title: string };
    expect(arg.title).toBe('delegated task');
  });

  it("maps surfaceBackend('omp') to the 'omp' DelegateBackend on the task", async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: true });
    mocks.surfaceBackend.mockResolvedValue('omp');
    await tool.handler({ requestText: 'hello there' }, makeCtx([]));
    const arg = mocks.createDelegatedTask.mock.calls[0][0] as { backend: string };
    expect(arg.backend).toBe('omp');
  });

  it('on resume calls findOpenDelegatedTask(agentSessionId) instead of createDelegatedTask', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'sess-resume', sessionCreated: false });
    await tool.handler({ requestText: 'continue' }, makeCtx([]));
    expect(mocks.findOpenDelegatedTask).toHaveBeenCalledWith('sess-resume');
    expect(mocks.createDelegatedTask).not.toHaveBeenCalled();
  });

  it('stays in degraded mode (workItemId null → no post-stream writes) when createDelegatedTask rejects', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: true });
    mocks.createDelegatedTask.mockRejectedValue(new Error('coord down'));
    await tool.handler({ requestText: 'go' }, makeCtx([]));
    expect(mocks.recordDelegateTurn).not.toHaveBeenCalled();
    expect(mocks.generateTaskTitle).not.toHaveBeenCalled();
  });

  it('stays in degraded mode when findOpenDelegatedTask rejects on resume', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: false });
    mocks.findOpenDelegatedTask.mockRejectedValue(new Error('coord down'));
    await tool.handler({ requestText: 'go' }, makeCtx([]));
    expect(mocks.recordDelegateTurn).not.toHaveBeenCalled();
  });
});

// ── session event + memory injection + prompt composition ───────────────────
describe('operator:delegate — session event, memory injection, prompt', () => {
  it("emits 'session' { agentSessionId, created } BEFORE the stream starts", async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'sX', sessionCreated: true });
    const order: string[] = [];
    mocks.runAgentChat.mockImplementation(() => {
      order.push('stream');
      return (async function* () {
        /* no events */
      })();
    });
    const emits: CapturedEmit[] = [];
    const ctx = makeCtx(emits);
    // wrap emit to record ordering relative to the stream call.
    const origEmit = (ctx as { emit: (n: EmitName, p: Record<string, unknown>) => void }).emit;
    (ctx as { emit: (n: EmitName, p: Record<string, unknown>) => void }).emit = (n, p) => {
      if (n === 'session') order.push('session');
      origEmit(n, p);
    };
    await tool.handler({ requestText: 'go' }, ctx);
    expect(emits[0]).toEqual({ name: 'session', payload: { agentSessionId: 'sX', created: true } });
    expect(order).toEqual(['session', 'stream']);
  });

  it('runs memory injection (across all harness slugs) ONLY when sessionCreated', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: true });
    mocks.loadHarnessRegistry.mockResolvedValue({ projects: [{ slug: 'a' }, { slug: 'b' }] });
    mocks.buildMemoryContextBlock.mockResolvedValue('MEM-BLOCK');
    await tool.handler({ requestText: 'find stuff' }, makeCtx([]));
    expect(mocks.buildMemoryContextBlock).toHaveBeenCalledTimes(1);
    expect(mocks.buildMemoryContextBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: null,
        workspaceId: 'ws-1',
        harnessSlugs: ['a', 'b'],
        queryContext: 'find stuff',
      }),
    );
  });

  it('does NOT run memory injection on resume', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: false });
    await tool.handler({ requestText: 'continue' }, makeCtx([]));
    expect(mocks.buildMemoryContextBlock).not.toHaveBeenCalled();
    expect(mocks.loadHarnessRegistry).not.toHaveBeenCalled();
  });

  it('composes SYSTEM_PROMPT + memory + "User request:" on create', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: true });
    mocks.buildMemoryContextBlock.mockResolvedValue('MEM-BLOCK');
    await tool.handler({ requestText: 'build the thing' }, makeCtx([]));
    const opts = mocks.runAgentChat.mock.calls[0][0] as { promptText: string };
    expect(opts.promptText).toContain('You are a Delegate');
    expect(opts.promptText).toContain('MEM-BLOCK');
    expect(opts.promptText).toContain('User request: build the thing');
    expect(opts.promptText).not.toContain('User: build the thing');
  });

  it('drops a null memory block via .filter(Boolean) on create (no empty join gap)', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: true });
    mocks.buildMemoryContextBlock.mockResolvedValue(null);
    await tool.handler({ requestText: 'build' }, makeCtx([]));
    const opts = mocks.runAgentChat.mock.calls[0][0] as { promptText: string };
    // exactly two segments joined by one blank line — no triple-newline from a null block.
    expect(opts.promptText).not.toContain('\n\n\n');
    expect(opts.promptText.endsWith('User request: build')).toBe(true);
  });

  it('uses "User: <text>" (no system prompt, no memory) on resume', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: false });
    await tool.handler({ requestText: 'next step' }, makeCtx([]));
    const opts = mocks.runAgentChat.mock.calls[0][0] as { promptText: string };
    expect(opts.promptText).toBe('User: next step');
  });
});

// ── mcpConfig assembly ──────────────────────────────────────────────────────
describe('operator:delegate — buildMcpConfig', () => {
  it('includes the agentmcp server only when the superuser token file is readable + non-empty', async () => {
    mocks.readFileSync.mockReturnValue('  super-token  \n'); // trimmed → non-empty
    await tool.handler({ requestText: 'go' }, makeCtx([]));
    const opts = mocks.runAgentChat.mock.calls[0][0] as {
      mcpConfig: { mcpServers: Record<string, unknown> };
    };
    expect(Object.keys(opts.mcpConfig.mcpServers).sort()).toEqual(['agentmcp', 'delegate']);
    const agentmcp = opts.mcpConfig.mcpServers.agentmcp as { args: string[] };
    // workspace= scoping + bearer header carry the trimmed token.
    expect(agentmcp.args.some((a) => a.includes('workspace=ws-1'))).toBe(true);
    expect(agentmcp.args).toContain('Authorization:Bearer super-token');
  });

  it('omits agentmcp (delegate server only) when readFileSync throws', async () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    await tool.handler({ requestText: 'go' }, makeCtx([]));
    const opts = mocks.runAgentChat.mock.calls[0][0] as {
      mcpConfig: { mcpServers: Record<string, unknown> };
    };
    expect(Object.keys(opts.mcpConfig.mcpServers)).toEqual(['delegate']);
  });

  it('omits agentmcp when the token file is empty/whitespace-only', async () => {
    mocks.readFileSync.mockReturnValue('   \n  ');
    await tool.handler({ requestText: 'go' }, makeCtx([]));
    const opts = mocks.runAgentChat.mock.calls[0][0] as {
      mcpConfig: { mcpServers: Record<string, unknown> };
    };
    expect(Object.keys(opts.mcpConfig.mcpServers)).toEqual(['delegate']);
  });
});

// ── stream loop event mapping ───────────────────────────────────────────────
describe('operator:delegate — stream loop event mapping', () => {
  it("'delta' accumulates text and emits each chunk", async () => {
    mocks.runAgentChat.mockImplementation(
      scriptStream([
        { type: 'delta', text: 'Hello ' },
        { type: 'delta', text: 'world' },
      ]),
    );
    const emits: CapturedEmit[] = [];
    const result = await tool.handler({ requestText: 'go' }, makeCtx(emits));
    const deltas = emits.filter((e) => e.name === 'delta').map((e) => e.payload.text);
    expect(deltas).toEqual(['Hello ', 'world']);
    // accumulated into fullText (no result event → assistantText is the sum).
    expect(parsePayload(result as never).fullText).toBe('Hello world');
  });

  it("'tool_call' emits { name, input } verbatim", async () => {
    mocks.runAgentChat.mockImplementation(
      scriptStream([{ type: 'tool_call', name: 'tasks:list', input: { limit: 3 } }]),
    );
    const emits: CapturedEmit[] = [];
    await tool.handler({ requestText: 'go' }, makeCtx(emits));
    const tc = emits.find((e) => e.name === 'tool_call');
    expect(tc?.payload).toEqual({ name: 'tasks:list', input: { limit: 3 } });
  });

  it("'result' captures costUsd/tokensIn/tokensOut and overrides assistantText with finalText", async () => {
    mocks.runAgentChat.mockImplementation(
      scriptStream([
        { type: 'delta', text: 'partial' },
        { type: 'result', costUsd: 0.42, tokensIn: 100, tokensOut: 250, finalText: 'FINAL' },
      ]),
    );
    const result = await tool.handler({ requestText: 'go' }, makeCtx([]));
    const payload = parsePayload(result as never);
    expect(payload.costUsd).toBe(0.42);
    expect(payload.tokensIn).toBe(100);
    expect(payload.tokensOut).toBe(250);
    expect(payload.fullText).toBe('FINAL');
  });

  it("'result' with empty finalText keeps the accumulated delta text", async () => {
    mocks.runAgentChat.mockImplementation(
      scriptStream([
        { type: 'delta', text: 'streamed' },
        { type: 'result', costUsd: 0, tokensIn: 0, tokensOut: 0, finalText: '' },
      ]),
    );
    const result = await tool.handler({ requestText: 'go' }, makeCtx([]));
    expect(parsePayload(result as never).fullText).toBe('streamed');
  });

  it("'error' emits { message } and includes stderr only when present", async () => {
    mocks.runAgentChat.mockImplementation(
      scriptStream([
        { type: 'error', message: 'no stderr here' },
        { type: 'error', message: 'with stderr', stderr: 'boom' },
      ]),
    );
    const emits: CapturedEmit[] = [];
    await tool.handler({ requestText: 'go' }, makeCtx(emits));
    const errs = emits.filter((e) => e.name === 'error').map((e) => e.payload);
    expect(errs[0]).toEqual({ message: 'no stderr here' });
    expect(errs[1]).toEqual({ message: 'with stderr', stderr: 'boom' });
  });

  it("wraps a thrown stream error as 'operator delegate failed: <msg>'", async () => {
    mocks.runAgentChat.mockImplementation(() =>
      (async function* (): AsyncGenerator<ChatEvent> {
        throw new Error('stream blew up');
        // eslint-disable-next-line no-unreachable
        yield { type: 'delta', text: 'never' };
      })(),
    );
    await expect(tool.handler({ requestText: 'go' }, makeCtx([]))).rejects.toThrow(
      'operator delegate failed: stream blew up',
    );
  });

  it('forwards ctx.signal + bypassPermissions + the delegate tool allowlist + force session mode to runAgentChat', async () => {
    const ctx = makeCtx([]);
    await tool.handler({ requestText: 'go' }, ctx);
    const opts = mocks.runAgentChat.mock.calls[0][0] as {
      signal: AbortSignal;
      permissionMode: string;
      sessionMode: string;
      allowedTools: string[];
    };
    expect(opts.signal).toBe((ctx as { signal: AbortSignal }).signal);
    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.sessionMode).toBe('force');
    // mocked ALL_AGENT_MCP_TOOLS + the six DELEGATE_EXTRA_TOOLS.
    expect(opts.allowedTools).toContain('mcp__agentmcp__tasks:list');
    expect(opts.allowedTools).toContain('mcp__delegate__dispatchToAgent');
  });

  it('passes a surface model override into runAgentChat when surfaceModel resolves one', async () => {
    mocks.surfaceModel.mockResolvedValue('claude-opus-4');
    await tool.handler({ requestText: 'go' }, makeCtx([]));
    const opts = mocks.runAgentChat.mock.calls[0][0] as { model?: string };
    expect(opts.model).toBe('claude-opus-4');
  });

  it('omits the model key entirely when surfaceModel returns undefined', async () => {
    mocks.surfaceModel.mockResolvedValue(undefined);
    await tool.handler({ requestText: 'go' }, makeCtx([]));
    const opts = mocks.runAgentChat.mock.calls[0][0] as Record<string, unknown>;
    expect('model' in opts).toBe(false);
  });
});

// ── post-stream side-effects + returned payload ─────────────────────────────
describe('operator:delegate — post-stream side-effects', () => {
  it('records the turn (always) and generates a title (only on create) when workItemId is set', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'sess-c', sessionCreated: true });
    mocks.createDelegatedTask.mockResolvedValue({ id: 'wi-77' });
    mocks.runAgentChat.mockImplementation(
      scriptStream([{ type: 'result', costUsd: 1, tokensIn: 2, tokensOut: 3, finalText: 'ANSWER' }]),
    );
    await tool.handler({ requestText: 'the request' }, makeCtx([]));
    expect(mocks.recordDelegateTurn).toHaveBeenCalledWith('wi-77', 'sess-c', {
      request: 'the request',
      response: 'ANSWER',
    });
    expect(mocks.generateTaskTitle).toHaveBeenCalledWith({
      workItemId: 'wi-77',
      initiatorMsg: 'the request',
      firstResponse: 'ANSWER',
    });
  });

  it('records the turn but does NOT generate a title on resume', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'sess-r', sessionCreated: false });
    mocks.findOpenDelegatedTask.mockResolvedValue({ id: 'wi-88' });
    await tool.handler({ requestText: 'follow up' }, makeCtx([]));
    expect(mocks.recordDelegateTurn).toHaveBeenCalledWith('wi-88', 'sess-r', expect.any(Object));
    expect(mocks.generateTaskTitle).not.toHaveBeenCalled();
  });

  it('fires NO post-stream writes when workItemId is null (resume found no open task)', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'sess-r', sessionCreated: false });
    mocks.findOpenDelegatedTask.mockResolvedValue(null);
    await tool.handler({ requestText: 'follow up' }, makeCtx([]));
    expect(mocks.recordDelegateTurn).not.toHaveBeenCalled();
    expect(mocks.generateTaskTitle).not.toHaveBeenCalled();
  });

  it('swallows recordDelegateTurn rejection (fire-and-forget — handler still resolves)', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 's', sessionCreated: true });
    mocks.createDelegatedTask.mockResolvedValue({ id: 'wi-1' });
    mocks.recordDelegateTurn.mockRejectedValue(new Error('subscribe failed'));
    const result = await tool.handler({ requestText: 'go' }, makeCtx([]));
    expect(parsePayload(result as never).agentSessionId).toBe('s');
  });

  it('returns content[0].text as JSON with the full result shape', async () => {
    mocks.resolveDelegateSession.mockResolvedValue({ agentSessionId: 'sess-Z', sessionCreated: true });
    mocks.runAgentChat.mockImplementation(
      scriptStream([{ type: 'result', costUsd: 0.5, tokensIn: 11, tokensOut: 22, finalText: 'DONE' }]),
    );
    const result = await tool.handler({ requestText: 'go' }, makeCtx([]));
    expect(parsePayload(result as never)).toEqual({
      agentSessionId: 'sess-Z',
      sessionCreated: true,
      costUsd: 0.5,
      tokensIn: 11,
      tokensOut: 22,
      fullText: 'DONE',
    });
  });
});
