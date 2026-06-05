/**
 * Route-level tests for the `/oracle/*` routes — Phase A1
 * (endpoint-hono-elimination-2026-05-21). Migrated from the
 * `registerOracle` block of `_hono/chat-shim-routes.test.ts` when the
 * oracle router moved off Hono onto `defineTool`
 * (`routes/oracle/index.ts`).
 *
 * The load-bearing assertion is `closed === true`: the `/oracle/chat`
 * SSE stream must TERMINATE on its own after the turn. A handler whose
 * `setup()` resolves without `sink.close()` leaves the consumer's
 * `reader.read()` hanging on heartbeats forever — the audit-round-10
 * regression class.
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

function postReq(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CTX: RouteContext = {
  principal: null,
  input: undefined,
  params: {},
  log: () => {},
  signal: new AbortController().signal,
};

const MOCKED_MODULES = [
  '../../agent-chat-stream',
  '../../agent-tools/oracle/prompts',
  '../../agent-tools',
  '../../workspace-registry',
  '../../auth',
  '@papercusp/flags/server',
  '@papercusp/flags',
];

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  for (const m of MOCKED_MODULES) vi.doUnmock(m);
});

/** Set up the mocked deps, register the real oracle:chat tool, return the chat handler. */
async function oracleChatHandler(
  chatEvents: Array<Record<string, unknown>>,
  opts: { flagOn?: boolean } = {},
): Promise<(req: Request) => Promise<Response>> {
  vi.doMock('../../agent-chat-stream', () => ({ runAgentChat: () => gen(chatEvents) }));
  vi.doMock('../../agent-tools/oracle/prompts', () => ({
    composeOraclePrompt: vi.fn(async () => ({ promptText: 'SYSTEM PROMPT', tutorialIsFinalStep: false })),
    buildOracleMcpConfig: vi.fn(async () => ({ mcpServers: {} })),
    oracleToolEventFilter: () => null,
    ORACLE_ALLOWED_TOOLS: [] as string[],
    readOracleConfig: vi.fn(async () => ({ prompt: '', memory: '', prompt_path: '', memory_path: '' })),
    writeOracleConfig: vi.fn(async () => {}),
  }));
  vi.doMock('../../agent-tools', () => ({}));
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
  vi.doMock('../../auth', () => ({ getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1' })) }));
  vi.doMock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => opts.flagOn !== false) }));
  vi.doMock('@papercusp/flags', () => ({ FLAGS: { ORACLE: 'oracle' } }));

  await import('../../agent-tools/oracle/chat');
  const routes = (await import('../routes/oracle/index')).default as RouteDefinition<undefined>[];
  const chat = routes.find((r) => r.method === 'POST' && r.path === '/oracle/chat');
  if (!chat) throw new Error('oracle chat route not found');
  return (req: Request) => Promise.resolve(chat.handler(req, CTX));
}

describe('POST /oracle/chat — route handler', () => {
  it('streams delta + terminal done and CLOSES the stream (round-10 guard)', async () => {
    const handler = await oracleChatHandler([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
      { type: 'result', costUsd: 0.012 },
    ]);
    const res = await handler(postReq('/oracle/chat', { messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(200);
    const { text, closed } = await drainSse(res.body, 5000);
    expect(closed, 'oracle SSE stream must close after the turn, not hang on heartbeats').toBe(true);
    expect(text).toContain('event: delta');
    expect(text).toContain('Hello ');
    expect(text).toContain('event: done');
  });

  it('rejects a body with no messages[] array with 400', async () => {
    const handler = await oracleChatHandler([]);
    const res = await handler(postReq('/oracle/chat', { message: 'hi' }));
    expect(res.status).toBe(400);
  });

  it('404s when the ORACLE flag is off', async () => {
    const handler = await oracleChatHandler([], { flagOn: false });
    const res = await handler(postReq('/oracle/chat', { messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(404);
  });

  it('runId is UUID-shaped and unique per request (regression for Bug #1)', async () => {
    const seenRunIds: string[] = [];
    vi.doMock('@papercusp/agent-mcp', async (orig) => {
      const real = (await orig()) as Record<string, unknown>;
      return {
        ...real,
        dispatchProjectedToolStream: async function* (
          _tool: unknown,
          _name: string,
          _input: unknown,
          ctx: { runId: string },
        ) {
          seenRunIds.push(ctx.runId);
          yield { kind: 'done' as const, result: { content: [] } };
        },
      };
    });
    const handler = await oracleChatHandler([]);
    await handler(postReq('/oracle/chat', { messages: [{ role: 'user', content: 'hi' }] }));
    await handler(postReq('/oracle/chat', { messages: [{ role: 'user', content: 'hi' }] }));
    vi.doUnmock('@papercusp/agent-mcp');

    expect(seenRunIds).toHaveLength(2);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(seenRunIds[0]).toMatch(UUID_RE);
    expect(seenRunIds[1]).toMatch(UUID_RE);
    expect(seenRunIds[0], 'runIds must differ per request').not.toBe(seenRunIds[1]);
    expect(seenRunIds[0]).not.toMatch(/^oracle-\d+$/);
  });
});
