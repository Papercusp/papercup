/**
 * Route-level tests for `POST /api/harness/:slug/agent-chats/:chatId/messages`
 * — Phase A2 (endpoint-hono-elimination-2026-05-21). Migrated from the
 * `registerAgentChats` block of `_hono/chat-shim-routes.test.ts` when the
 * agent-chats router moved off Hono onto `defineTool`
 * (`routes/agent-chats/index.ts`).
 *
 * The load-bearing assertion is `closed === true`: the SSE stream must
 * terminate on its own after the turn (the audit-round-10 regression
 * class). Drives the route handler directly with a hand-built
 * `RouteContext`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RouteContext, RouteDefinition } from '../define-route';

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

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

async function* gen(events: Array<Record<string, unknown>>) {
  for (const ev of events) yield ev;
}

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/harness/x/agent-chats/x/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const MOCKED_MODULES = [
  '../../agent-chat-stream',
  '../../agent-tools',
  '../../workspace-registry',
  '../../memory/injection',
  '../../harness-registry',
  '../../sync-sse',
  '../../operator-notes',
  '@papercusp/orchestrator/role-prompt',
  '../../agent-chats-data',
  '@papercusp/db-org',
];

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  for (const m of MOCKED_MODULES) vi.doUnmock(m);
});

const SLUG = 'test-harness';
const CHAT = 'CHAT-1';

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

function ctxFor(chatId: string): RouteContext {
  return {
    principal: null,
    input: undefined,
    params: { slug: SLUG, chatId },
    log: () => {},
    signal: new AbortController().signal,
  };
}

/**
 * Set up the mocked deps, register the real agent_chats:chat tool, return
 * the messages-route handler + a capture of the SQL UPDATEs run.
 */
async function agentChatsMessagesHandler(
  chatEvents: Array<Record<string, unknown>>,
  chatRow: Record<string, unknown> | null,
): Promise<{ handler: (req: Request, chatId: string) => Promise<Response>; updates: string[] }> {
  const updates: string[] = [];
  vi.doMock('../../agent-chat-stream', () => ({ runAgentChat: () => gen(chatEvents) }));
  vi.doMock('../../agent-tools', () => ({}));
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
  vi.doMock('../../memory/injection', () => ({ buildMemoryContextBlock: vi.fn(async () => null) }));
  vi.doMock('../../harness-registry', () => ({ loadHarnessRegistry: vi.fn(async () => ({ projects: [] })) }));
  vi.doMock('../../sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
  vi.doMock('../../operator-notes', () => ({ projectDirForSlug: vi.fn(async () => '/tmp/proj') }));
  vi.doMock('@papercusp/orchestrator/role-prompt', () => ({
    assembleRolePrompt: () => ({ text: 'ROLE PROMPT', meta: { runId: 'run-test' } }),
  }));
  vi.doMock('../../agent-chats-data', () => ({
    readFeatureLockState: vi.fn(async () => null),
    rowToChat: (row: Record<string, unknown>) => row,
  }));
  vi.doMock('@papercusp/db-org', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('@papercusp/db-org');
    return {
      ...actual,
      getLegacyClient: () => ({
        prepare: (sql: string) => ({
          get: async () => (/^SELECT \* FROM agent_chats/.test(sql.trim()) ? chatRow : { total: 0 }),
          run: async () => { updates.push(sql.trim()); },
        }),
      }),
    };
  });

  await import('../../agent-tools/agent_chats/chat');
  const routes = (await import('../routes/agent-chats/index')).default as RouteDefinition<undefined>[];
  const messages = routes.find(
    (r) => r.method === 'POST' && r.path === '/harness/:slug/agent-chats/:chatId/messages',
  );
  if (!messages) throw new Error('agent-chats messages route not found');
  return {
    handler: (req: Request, chatId: string) => Promise.resolve(messages.handler(req, ctxFor(chatId))),
    updates,
  };
}

describe('POST /harness/:slug/agent-chats/:chatId/messages — route handler', () => {
  it('streams delta + terminal done and CLOSES the stream (round-10 guard)', async () => {
    const { handler, updates } = await agentChatsMessagesHandler(
      [
        { type: 'delta', text: 'Hi ' },
        { type: 'delta', text: 'there' },
        { type: 'result', tokensIn: 12, tokensOut: 4, costUsd: 0.003, finalText: 'Hi there' },
      ],
      { ...baseRow },
    );
    const res = await handler(postReq({ content: 'hello' }), CHAT);
    expect(res.status).toBe(200);
    const { text, closed } = await drainSse(res.body, 5000);
    expect(closed, 'agent_chats SSE stream must close after the turn').toBe(true);
    expect(text).toContain('event: delta');
    expect(text).toContain('Hi ');
    expect(text).toContain('event: done');
    // Both the user-turn and assistant-turn UPDATEs must have persisted.
    expect(updates.length).toBe(2);
  });

  it('404s when the chat row does not exist', async () => {
    const { handler } = await agentChatsMessagesHandler([], null);
    const res = await handler(postReq({ content: 'hello' }), 'missing');
    expect(res.status).toBe(404);
  });

  it('400s on empty content', async () => {
    const { handler } = await agentChatsMessagesHandler([], { ...baseRow });
    const res = await handler(postReq({ content: '   ' }), CHAT);
    expect(res.status).toBe(400);
  });
});
