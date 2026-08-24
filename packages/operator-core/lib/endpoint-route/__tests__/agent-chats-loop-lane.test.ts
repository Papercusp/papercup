/**
 * Route-level tests for the P-008 OWNED-loop engine lane
 * (own-tui-full-divorce-2026-08-24, D-008/D-009 native session protocol):
 *
 *   POST /harness/:slug/agent-chats/:chatId/messages  { engine: 'loop' }
 *   GET  /harness/:slug/agent-chats/:chatId/approvals
 *   POST /harness/:slug/agent-chats/:chatId/approvals/:callId
 *
 * Engine + approval store are mocked (their own suites cover them); these
 * tests pin the ROUTE contract: lane selection, the systemText/transcript
 * handed to the engine, SSE close, transcript persistence of the loop
 * result, and the approval routes' status mapping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RouteContext, RouteDefinition } from '../define-route';

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

vi.mock('../../agent-chat-lock', () => ({
  AGENT_CHAT_LOCK_TTL_MS: 10 * 60_000,
  acquireAgentChatLock: async (chatId: string) => ({ chatId, token: 'test-lock-token' }),
  releaseAgentChatLock: async () => {},
  isAgentChatLocked: async () => false,
  __resetAgentChatLocks: async () => {},
}));

async function drainSse(
  body: ReadableStream<Uint8Array> | null,
  maxMs: number,
): Promise<{ text: string; closed: boolean }> {
  if (!body) return { text: '', closed: false };
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + maxMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { text, closed: false };
      const step = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), remaining)),
      ]);
      if (step === 'timeout') return { text, closed: false };
      if (step.done) return { text, closed: true };
      text += decoder.decode(step.value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

const SLUG = 'test-harness';
const CHAT = 'CHAT-L1';

const baseRow = {
  id: CHAT,
  role: 'worker',
  feature_id: null,
  archived_at: null,
  transcript: [] as unknown[],
  total_cost_usd_cents: 0,
  total_input_tokens: 0,
  total_output_tokens: 0,
};

function ctxFor(chatId: string, extra: Record<string, string> = {}): RouteContext {
  return {
    principal: null,
    input: undefined,
    params: { slug: SLUG, chatId, ...extra },
    log: () => {},
    signal: new AbortController().signal,
  };
}

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/harness/x/agent-chats/x/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const MOCKED_MODULES = [
  '../../agent-tools',
  '../../workspace-registry',
  '../../memory/injection',
  '../../harness-registry',
  '../../operator-notes',
  '@papercusp/orchestrator/role-prompt',
  '../../prompt-assembly',
  '../../agent-chats-data',
  '@papercusp/db-org',
  '../../agent-loop/chat-engine',
  '../../agent-loop/approval-store',
];

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  for (const m of MOCKED_MODULES) vi.doUnmock(m);
});

interface LoopLaneMocks {
  assembleHarnessRolePrompt: ReturnType<typeof vi.fn>;
  assembleOperatorRolePrompt: ReturnType<typeof vi.fn>;
  runLoopChatTurn: ReturnType<typeof vi.fn>;
  resolveLoopApproval: ReturnType<typeof vi.fn>;
  listPendingLoopApprovals: ReturnType<typeof vi.fn>;
  updates: string[];
  updateArgs: unknown[][];
}

async function loopLaneRoutes(
  chatRow: Record<string, unknown> | null,
  engineResult: Record<string, unknown> = {},
): Promise<{
  routes: RouteDefinition<undefined>[];
  mocks: LoopLaneMocks;
}> {
  const updates: string[] = [];
  const updateArgs: unknown[][] = [];
  const runLoopChatTurn = vi.fn(async (opts: { sink: { event: (n: string, d: unknown) => void } }) => {
    opts.sink.event('text_delta', { type: 'text_delta', stepIndex: 0, text: 'loop says hi' });
    opts.sink.event('done', { type: 'done', stopReason: 'complete', finalText: 'loop says hi' });
    return {
      stopReason: 'complete',
      finalText: 'loop says hi',
      tokensIn: 12,
      tokensOut: 7,
      costUsd: 0.05,
      errorMessage: null,
      stepCount: 1,
      ...engineResult,
    };
  });
  const resolveLoopApproval = vi.fn(async () => true);
  const listPendingLoopApprovals = vi.fn(async () => []);
  const assembleHarnessRolePrompt = vi.fn(() => ({
    text: 'ROLE PROMPT',
    meta: { runId: 'run-test' },
  }));
  const assembleOperatorRolePrompt = vi.fn(() => ({
    text: 'OPERATOR ROLE PROMPT',
    sections: [],
  }));

  vi.doMock('../../agent-tools', () => ({}));
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
  vi.doMock('../../memory/injection', () => ({ buildMemoryContextBlock: vi.fn(async () => null) }));
  vi.doMock('../../harness-registry', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../harness-registry')>();
    return { ...actual, loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) };
  });
  vi.doMock('../../operator-notes', () => ({ projectDirForSlug: vi.fn(async () => '/tmp/proj') }));
  vi.doMock('@papercusp/orchestrator/role-prompt', () => ({
    assembleRolePrompt: assembleHarnessRolePrompt,
  }));
  vi.doMock('../../prompt-assembly', () => ({
    assembleRolePrompt: assembleOperatorRolePrompt,
  }));
  vi.doMock('../../agent-chats-data', () => ({
    readFeatureLockState: vi.fn(async () => null),
    rowToChat: (row: Record<string, unknown>) => row,
  }));
  vi.doMock('@papercusp/db-org', async (orig) => {
    const actual = await vi.importActual<Record<string, unknown>>('@papercusp/db-org');
    return {
      ...(await orig<typeof import('@papercusp/db-org')>()),
      ...actual,
      getLegacyClient: () => ({
        prepare: (sql: string) => ({
          get: async () => (/^SELECT \* FROM agent_chats/.test(sql.trim()) ? chatRow : { total: 0 }),
          run: async (...args: unknown[]) => { updates.push(sql.trim()); updateArgs.push(args); },
        }),
      }),
    };
  });
  vi.doMock('../../agent-loop/chat-engine', () => ({ runLoopChatTurn }));
  vi.doMock('../../agent-loop/approval-store', () => ({
    resolveLoopApproval,
    listPendingLoopApprovals,
  }));

  const routes = (await import('../routes/agent-chats/index')).default as RouteDefinition<undefined>[];
  return {
    routes,
    mocks: {
      assembleHarnessRolePrompt,
      assembleOperatorRolePrompt,
      runLoopChatTurn,
      resolveLoopApproval,
      listPendingLoopApprovals,
      updates,
      updateArgs,
    },
  };
}

function findRoute(routes: RouteDefinition<undefined>[], method: string, path: string) {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`route not found: ${method} ${path}`);
  return r;
}

describe('POST messages { engine: "loop" } — the owned-loop lane', () => {
  it('routes to runLoopChatTurn with the assembled system + transcript, streams, persists, closes', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({ content: 'hello loop', engine: 'loop', model: 'm-override' }),
      ctxFor(CHAT),
    )) as Response;
    expect(res.status).toBe(200);
    const { text, closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);
    expect(text).toContain('text_delta');
    expect(text).toContain('loop says hi');

    expect(mocks.runLoopChatTurn).toHaveBeenCalledTimes(1);
    const opts = mocks.runLoopChatTurn.mock.calls[0][0] as {
      system: string;
      transcript: Array<{ role: string; content: string }>;
      model?: string;
      chatId: string;
    };
    // systemText = persona + context sections, NO history block, NO user turn.
    expect(opts.system).toContain('ROLE PROMPT');
    expect(opts.system).not.toContain('## User');
    // The transcript handed to the engine ends with the just-appended user turn.
    expect(opts.transcript.at(-1)).toMatchObject({ role: 'user', content: 'hello loop' });
    expect(opts.model).toBe('m-override');
    expect(opts.chatId).toBe(CHAT);

    // Persistence: user turn first (preflight), then the assistant turn with totals.
    expect(mocks.updates.length).toBeGreaterThanOrEqual(2);
    const finalUpdate = mocks.updateArgs.at(-1)!;
    const transcript = JSON.parse(finalUpdate[0] as string) as Array<{ role: string; content: string; tokens_in?: number }>;
    expect(transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'loop says hi', tokens_in: 12, tokens_out: 7 });
    expect(finalUpdate[1]).toBe(12); // total_input_tokens increment
    expect(finalUpdate[2]).toBe(7); // total_output_tokens increment
    expect(finalUpdate[3]).toBe(5); // cost cents (0.05 USD)
  });

  it('assembles an operator chat from the operator prompt stack, not the blueprint stack', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow, role: 'operator' });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({ content: 'run the native operator loop', engine: 'loop' }),
      ctxFor(CHAT),
    )) as Response;
    expect(res.status).toBe(200);
    const { closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);

    expect(mocks.assembleOperatorRolePrompt).toHaveBeenCalledWith({
      role: 'operator',
      toolNames: [],
    });
    expect(mocks.assembleHarnessRolePrompt).not.toHaveBeenCalled();
    expect(mocks.runLoopChatTurn.mock.calls[0][0].system).toContain('OPERATOR ROLE PROMPT');
  });

  it('an engine errorMessage persists a failure-marker turn and still closes the stream', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow }, {
      errorMessage: 'gateway exploded',
      finalText: '',
      stopReason: 'error',
    });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    const res = (await messages.handler(
      postReq({ content: 'hello loop', engine: 'loop' }),
      ctxFor(CHAT),
    )) as Response;
    const { closed } = await drainSse(res.body, 8_000);
    expect(closed).toBe(true);
    const finalUpdate = mocks.updateArgs.at(-1)!;
    const transcript = JSON.parse(finalUpdate[0] as string) as Array<{ role: string; content: string; error?: boolean }>;
    expect(transcript.at(-1)).toMatchObject({ role: 'assistant', content: 'gateway exploded', error: true });
  });

  it('without engine:"loop" the legacy lane is used (runLoopChatTurn untouched)', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const messages = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/messages');
    // The legacy lane needs the agent_chats:chat tool registered; with
    // '../../agent-tools' mocked empty the lookup fails and the route 500s —
    // which is exactly the discriminator needed: the loop engine must NOT run.
    const res = (await messages.handler(
      postReq({ content: 'hello legacy' }),
      ctxFor(CHAT),
    )) as Response;
    expect(mocks.runLoopChatTurn).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
  });
});

describe('approval routes', () => {
  it('POST approvals/:callId resolves a pending approval', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    const route = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/approvals/:callId');
    const res = (await route.handler(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: true }),
      }),
      ctxFor(CHAT, { callId: 'call-7' }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(mocks.resolveLoopApproval).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT, callId: 'call-7', approved: true, workspaceId: 'default' }),
    );
  });

  it('POST approvals/:callId → 404 when nothing is pending', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    mocks.resolveLoopApproval.mockResolvedValueOnce(false);
    const route = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/approvals/:callId');
    const res = (await route.handler(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approved: false, reason: 'nope' }),
      }),
      ctxFor(CHAT, { callId: 'gone' }),
    )) as Response;
    expect(res.status).toBe(404);
  });

  it('POST approvals/:callId → 400 without a boolean `approved`', async () => {
    const { routes } = await loopLaneRoutes({ ...baseRow });
    const route = findRoute(routes, 'POST', '/harness/:slug/agent-chats/:chatId/approvals/:callId');
    const res = (await route.handler(
      new Request('http://localhost/x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'no decision' }),
      }),
      ctxFor(CHAT, { callId: 'c' }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  it('GET approvals returns the pending list', async () => {
    const { routes, mocks } = await loopLaneRoutes({ ...baseRow });
    mocks.listPendingLoopApprovals.mockResolvedValueOnce([
      { chatId: CHAT, callId: 'c1', toolName: 'capability:bash' },
    ]);
    const route = findRoute(routes, 'GET', '/harness/:slug/agent-chats/:chatId/approvals');
    const res = (await route.handler(
      new Request('http://localhost/x'),
      ctxFor(CHAT),
    )) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { approvals: Array<{ callId: string }> };
    expect(body.approvals).toHaveLength(1);
    expect(body.approvals[0].callId).toBe('c1');
  });
});
