/**
 * Route-level tests for the two LLM-streaming Hono shims that wrap
 * projected tools:
 *   - POST /oracle/chat                          (registerOracle)
 *   - POST /:slug/agent-chats/:chatId/messages   (registerAgentChats)
 *
 * Unlike hono-shim-dispatch.test.ts — which exercises a *replica*
 * forwarder helper — these mount the REAL route handlers on a Hono app
 * and drain the live SSE Response body.
 *
 * The load-bearing assertion is `closed === true`: the SSE stream must
 * TERMINATE on its own after the turn. A shim whose setup() resolves
 * without sink.close() leaves the consumer's reader.read() hanging on
 * heartbeats forever — the audit-round-10 regression class, and the
 * exact bug that shipped in _hono/oracle.ts (fixed in fd42ccda) while
 * the replica-based test stayed green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

/**
 * Drain an SSE ReadableStream. Returns the accumulated text and whether
 * the stream closed on its own within `maxMs`. `closed: false` is the
 * round-10 hang — the stream is still open, emitting heartbeats.
 */
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

const MOCKED_MODULES = [
  '@/lib/agent-chat-stream',
  '@/lib/agent-tools/oracle/prompts',
  '@/lib/agent-tools/index',
  '@/lib/workspace-registry',
  '@/lib/auth',
  '@papercusp/flags/server',
  '@papercusp/flags',
  '@restart/db-org',
  '@papercusp/orchestrator/role-prompt',
  '@/lib/memory/injection',
  '@/lib/harness-registry',
  '@/lib/agent-chats-data',
  '@/lib/operator-notes',
  '@/lib/sync-sse',
  '@papercusp/agent-mcp',
];

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  for (const m of MOCKED_MODULES) vi.doUnmock(m);
});

describe('POST /oracle/chat — registerOracle shim route', () => {
  async function mountOracle(
    chatEvents: Array<Record<string, unknown>>,
    opts: { flagOn?: boolean } = {},
  ): Promise<Hono> {
    vi.doMock('@/lib/agent-chat-stream', () => ({
      runAgentChat: () => gen(chatEvents),
    }));
    vi.doMock('@/lib/agent-tools/oracle/prompts', () => ({
      composeOraclePrompt: vi.fn(async () => ({
        promptText: 'SYSTEM PROMPT',
        tutorialIsFinalStep: false,
      })),
      buildOracleMcpConfig: vi.fn(async () => ({ mcpServers: {} })),
      oracleToolEventFilter: () => null,
      ORACLE_ALLOWED_TOOLS: [] as string[],
      readOracleConfig: vi.fn(async () => ({
        prompt: '', memory: '', prompt_path: '', memory_path: '',
      })),
      writeOracleConfig: vi.fn(async () => {}),
    }));
    vi.doMock('@/lib/agent-tools/index', () => ({}));
    vi.doMock('@/lib/workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('@/lib/auth', () => ({
      getSessionUserOrDefault: vi.fn(async () => ({ id: 'user-1' })),
    }));
    vi.doMock('@papercusp/flags/server', () => ({
      getFlag: vi.fn(async () => opts.flagOn !== false),
    }));
    vi.doMock('@papercusp/flags', () => ({ FLAGS: { ORACLE: 'oracle' } }));

    // Register the real oracle:chat tool against the mocked prompt/stream deps.
    await import('@/lib/agent-tools/oracle/chat');
    const { registerOracle } = await import('./oracle');
    const app = new Hono();
    registerOracle(app);
    return app;
  }

  it('streams delta + terminal done and CLOSES the stream (round-10 guard)', async () => {
    const app = await mountOracle([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
      { type: 'result', costUsd: 0.012 },
    ]);
    const res = await app.fetch(
      postReq('/oracle/chat', { messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    const { text, closed } = await drainSse(res.body, 5000);
    expect(closed, 'oracle SSE stream must close after the turn, not hang on heartbeats').toBe(true);
    expect(text).toContain('event: delta');
    expect(text).toContain('Hello ');
    expect(text).toContain('event: done');
  });

  it('rejects a body with no messages[] array (the VoiceAppBridge bug shape) with 400', async () => {
    const app = await mountOracle([]);
    const res = await app.fetch(postReq('/oracle/chat', { message: 'hi' }));
    expect(res.status).toBe(400);
  });

  it('404s when the ORACLE flag is off', async () => {
    const app = await mountOracle([], { flagOn: false });
    const res = await app.fetch(
      postReq('/oracle/chat', { messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(404);
  });

  // Phase-4 T2.2 audit follow-up — `_hono/oracle.ts` was previously
  // setting `runId: \`oracle-${Date.now()}\`` and missed the
  // d460b747 sweep that migrated every other MCP-spawn site to
  // `globalThis.crypto.randomUUID()`. Two concurrent oracle:chat calls
  // in the same workspace within the same millisecond would have
  // shared a replay buffer; a reconnecting client could replay events
  // from the OTHER call.
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
          // Yield a minimal terminal event so the route closes cleanly.
          yield { kind: 'done' as const, result: { content: [] } };
        },
      };
    });

    const app = await mountOracle([]);
    await app.fetch(postReq('/oracle/chat', { messages: [{ role: 'user', content: 'hi' }] }));
    await app.fetch(postReq('/oracle/chat', { messages: [{ role: 'user', content: 'hi' }] }));

    expect(seenRunIds).toHaveLength(2);
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(seenRunIds[0]).toMatch(UUID_RE);
    expect(seenRunIds[1]).toMatch(UUID_RE);
    expect(seenRunIds[0], 'runIds must differ per request').not.toBe(seenRunIds[1]);
    // And the OLD pattern must not reappear under any code path.
    expect(seenRunIds[0]).not.toMatch(/^oracle-\d+$/);
    expect(seenRunIds[1]).not.toMatch(/^oracle-\d+$/);
  });
});

describe('POST /:slug/agent-chats/:chatId/messages — registerAgentChats shim route', () => {
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

  async function mountAgentChats(
    chatEvents: Array<Record<string, unknown>>,
    chatRow: Record<string, unknown> | null,
  ): Promise<{ app: Hono; updates: string[] }> {
    const updates: string[] = [];
    vi.doMock('@/lib/agent-chat-stream', () => ({ runAgentChat: () => gen(chatEvents) }));
    vi.doMock('@/lib/agent-tools/index', () => ({}));
    vi.doMock('@/lib/workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
    vi.doMock('@/lib/memory/injection', () => ({
      buildMemoryContextBlock: vi.fn(async () => null),
    }));
    vi.doMock('@/lib/harness-registry', () => ({
      loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
    }));
    vi.doMock('@/lib/sync-sse', () => ({ notifySyncInvalidate: vi.fn() }));
    vi.doMock('@/lib/operator-notes', () => ({
      projectDirForSlug: vi.fn(async () => '/tmp/proj'),
    }));
    vi.doMock('@papercusp/orchestrator/role-prompt', () => ({
      assembleRolePrompt: () => ({ text: 'ROLE PROMPT', meta: { runId: 'run-test' } }),
    }));
    vi.doMock('@/lib/agent-chats-data', () => ({
      readFeatureLockState: vi.fn(async () => null),
      rowToChat: (row: Record<string, unknown>) => row,
    }));
    vi.doMock('@restart/db-org', async () => {
      const actual = await vi.importActual<Record<string, unknown>>('@restart/db-org');
      return {
        ...actual,
        getLegacyClient: () => ({
          prepare: (sql: string) => ({
            get: async () =>
              /^SELECT \* FROM agent_chats/.test(sql.trim()) ? chatRow : { total: 0 },
            run: async () => {
              updates.push(sql.trim());
            },
          }),
        }),
      };
    });

    await import('@/lib/agent-tools/agent_chats/chat');
    const { registerAgentChats } = await import('./agent-chats');
    const app = new Hono();
    registerAgentChats(app);
    return { app, updates };
  }

  it('streams delta + terminal done and CLOSES the stream (round-10 guard)', async () => {
    const { app, updates } = await mountAgentChats(
      [
        { type: 'delta', text: 'Hi ' },
        { type: 'delta', text: 'there' },
        { type: 'result', tokensIn: 12, tokensOut: 4, costUsd: 0.003, finalText: 'Hi there' },
      ],
      { ...baseRow },
    );
    const res = await app.fetch(
      postReq(`/${SLUG}/agent-chats/${CHAT}/messages`, { content: 'hello' }),
    );
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
    const { app } = await mountAgentChats([], null);
    const res = await app.fetch(
      postReq(`/${SLUG}/agent-chats/missing/messages`, { content: 'hello' }),
    );
    expect(res.status).toBe(404);
  });

  it('400s on empty content', async () => {
    const { app } = await mountAgentChats([], { ...baseRow });
    const res = await app.fetch(
      postReq(`/${SLUG}/agent-chats/${CHAT}/messages`, { content: '   ' }),
    );
    expect(res.status).toBe(400);
  });
});
