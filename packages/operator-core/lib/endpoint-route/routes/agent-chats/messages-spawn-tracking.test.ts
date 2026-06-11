/**
 * messages-spawn-tracking.test.ts — EI-259 regression: the messagesRoute must
 * register every chat turn in the durable nursery (beginChatSpawnTracking),
 * thread the minted spawnId into the dispatch ctx, and flip the row terminal
 * from the observed stream outcome — and must keep streaming untracked when
 * tracking is unavailable (best-effort).
 *
 * The outcome MAPPING itself is unit-tested in fleet/chat-spawn-tracking.test.ts;
 * this file pins the route-side seam (what signals reach it, when finish fires).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type StreamEvent =
  | { kind: 'event'; name: string; data: unknown }
  | { kind: 'done'; result?: { content?: Array<{ text?: string }> } }
  | { kind: 'error'; error: { code: string; message: string } };

const h = vi.hoisted(() => ({
  beginMock: vi.fn(),
  finishMock: vi.fn(),
  resolveMock: vi.fn(),
  dispatchMock: vi.fn(),
  setupHolder: { fn: null as null | ((sink: unknown) => Promise<void>) },
  streamEvents: [] as StreamEvent[],
  capturedCtx: { value: null as null | Record<string, unknown> },
}));

vi.mock('../../../agent-tools/index', () => ({}));
vi.mock('@papercusp/sse', () => ({
  sseResponse: (opts: { setup: (sink: unknown) => Promise<void> }) => {
    h.setupHolder.fn = opts.setup;
    return new Response('sse-started');
  },
}));
vi.mock('@papercusp/agent-mcp', () => ({
  defineTool: (d: unknown) => d,
  dispatchProjectedToolStream: h.dispatchMock,
  lookupByMcpName: () => ({ mcpToolName: 'agent_chats:chat' }),
}));
vi.mock('@papercusp/db-org', () => ({
  getLegacyClient: () => ({
    prepare: (sql: string) => ({
      get: async () => {
        if (sql.includes('FROM agent_chats WHERE id')) {
          return {
            id: 'chat-1',
            role: 'worker',
            feature_id: 'F-TEST-1',
            title: 'smoke chat',
            transcript: '[]',
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost_usd_cents: 0,
            created_at: Date.now(),
            updated_at: Date.now(),
            archived_at: null,
          };
        }
        if (sql.includes('SUM(total_cost_usd_cents)')) return { total: 0 };
        return undefined;
      },
      run: async () => ({}),
    }),
  }),
}));
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
vi.mock('../../../harness-registry', () => ({ loadHarnessRegistry: async () => ({ projects: [] }) }));
vi.mock('../../../harness-effective-config', () => ({ readEffectiveHarnessConfig: async () => ({}) }));
vi.mock('../../../harness-prompt-overrides', () => ({ getPromptOverride: async () => null }));
vi.mock('../../../memory/injection', () => ({ buildMemoryContextBlock: async () => null }));
vi.mock('../../../operator-notes', () => ({ projectDirForSlug: async () => '/tmp/proj-x' }));
vi.mock('@papercusp/orchestrator/role-prompt', () => ({
  assembleRolePrompt: () => ({ text: 'PROMPT', meta: { runId: 'run-1' } }),
}));
vi.mock('../../../agent-chats-data', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../agent-chats-data')>();
  return { ...orig, readFeatureLockState: async () => null };
});
// Fully mocked: the real module pulls spawn-reclaim → parent-wake → the await
// engine — far too heavy for this seam test (mapping covered in its own unit).
vi.mock('../../../fleet/chat-spawn-tracking', () => ({
  beginChatSpawnTracking: h.beginMock,
  resolveChatRunOutcome: h.resolveMock,
}));

import agentChatTools from './index';

const messagesRoute = (agentChatTools as Array<{ path: string; method: string; handler: (req: Request, ctx: unknown) => Promise<Response> }>)
  .find((t) => t.method === 'POST' && t.path.endsWith('/messages'))!;

async function runTurn(): Promise<{ res: Response; sinkEvents: Array<[string, unknown]> }> {
  const req = new Request('http://localhost/api/harness/h-test/agent-chats/chat-1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'do the thing' }),
  });
  const res = await messagesRoute.handler(req, { params: { slug: 'h-test', chatId: 'chat-1' } });
  const sinkEvents: Array<[string, unknown]> = [];
  if (h.setupHolder.fn) {
    await h.setupHolder.fn({
      event: (name: string, data: unknown) => sinkEvents.push([name, data]),
      close: () => {},
    });
  }
  return { res, sinkEvents };
}

beforeEach(() => {
  h.beginMock.mockReset();
  h.finishMock.mockReset();
  h.resolveMock.mockReset();
  h.dispatchMock.mockReset();
  h.setupHolder.fn = null;
  h.capturedCtx.value = null;
  h.streamEvents = [];

  h.beginMock.mockResolvedValue({ spawnId: 'agent_chats-chat-1-abcd1234', finish: h.finishMock });
  h.resolveMock.mockReturnValue({ status: 'done', errorMessage: null });
  h.dispatchMock.mockImplementation(async function* (
    _tool: unknown, _name: unknown, _args: unknown, ctx: Record<string, unknown>,
  ) {
    h.capturedCtx.value = ctx;
    for (const ev of h.streamEvents) yield ev;
  });
});

describe('agent-chats messagesRoute spawn tracking (EI-259)', () => {
  it('registers the turn with the chat identity and threads the minted spawnId into the dispatch ctx', async () => {
    h.streamEvents = [
      { kind: 'event', name: 'delta', data: { text: 'hello ' } },
      { kind: 'done', result: { content: [{ text: JSON.stringify({ finalText: 'hello world', tokensIn: 2, tokensOut: 3, costUsd: 0.01 }) }] } },
    ];
    await runTurn();

    expect(h.beginMock).toHaveBeenCalledTimes(1);
    expect(h.beginMock.mock.calls[0][0]).toMatchObject({
      chatId: 'chat-1',
      workspaceId: 'ws-test',
      harnessSlug: 'h-test',
      childRole: 'worker',
      runId: 'run-1',
      featureId: 'F-TEST-1',
      projectDir: '/tmp/proj-x',
    });
    expect(h.capturedCtx.value?.spawnId).toBe('agent_chats-chat-1-abcd1234');
  });

  it('clean stream → resolve sees sawDone with no errors; finish carries the outcome + output tail', async () => {
    h.streamEvents = [
      { kind: 'event', name: 'delta', data: { text: 'hello world' } },
      { kind: 'done', result: { content: [{ text: JSON.stringify({ tokensIn: 1, tokensOut: 1, costUsd: 0 }) }] } },
    ];
    await runTurn();

    expect(h.resolveMock).toHaveBeenCalledWith({
      sawDone: true,
      toolErrorMessage: null,
      lastErrorMessage: null,
      threwMessage: null,
      aborted: false,
    });
    expect(h.finishMock).toHaveBeenCalledTimes(1);
    expect(h.finishMock.mock.calls[0][0]).toMatchObject({
      status: 'done',
      errorMessage: null,
      outputTail: 'hello world',
    });
  });

  it('tool-level error → resolve sees toolErrorMessage; finish still fires exactly once', async () => {
    h.streamEvents = [{ kind: 'error', error: { code: 'X', message: 'dispatch exploded' } }];
    h.resolveMock.mockReturnValue({ status: 'failed', errorMessage: 'dispatch exploded' });
    const { sinkEvents } = await runTurn();

    expect(h.resolveMock).toHaveBeenCalledWith(expect.objectContaining({
      sawDone: false,
      toolErrorMessage: 'dispatch exploded',
    }));
    expect(h.finishMock).toHaveBeenCalledTimes(1);
    expect(h.finishMock.mock.calls[0][0]).toMatchObject({ status: 'failed' });
    expect(sinkEvents.find(([name]) => name === 'error')).toBeTruthy();
  });

  it('thrown dispatch → finish fires from the finally with threwMessage before the throw propagates', async () => {
    h.dispatchMock.mockImplementation(async function* () {
      yield { kind: 'event', name: 'delta', data: { text: 'partial' } };
      throw new Error('ECONNRESET');
    });
    h.resolveMock.mockReturnValue({ status: 'failed', errorMessage: 'ECONNRESET' });

    await runTurn().catch(() => {});

    expect(h.resolveMock).toHaveBeenCalledWith(expect.objectContaining({
      threwMessage: 'ECONNRESET',
      sawDone: false,
    }));
    expect(h.finishMock).toHaveBeenCalledTimes(1);
  });

  it('tracking unavailable (begin → null) → chat streams with the legacy ctx spawnId and no finish call', async () => {
    h.beginMock.mockResolvedValue(null);
    h.streamEvents = [
      { kind: 'done', result: { content: [{ text: JSON.stringify({ finalText: 'ok' }) }] } },
    ];
    const { sinkEvents } = await runTurn();

    expect(h.capturedCtx.value?.spawnId).toBe('agent_chats-chat-1');
    expect(h.finishMock).not.toHaveBeenCalled();
    expect(h.resolveMock).not.toHaveBeenCalled();
    expect(sinkEvents.find(([name]) => name === 'done')).toBeTruthy();
  });
});
