/**
 * Phase 3 pilot+fold-in regression test — verifies the migrated
 * streaming tools (architect:chat, brainstorm:chat,
 * operator:converse, operator:delegate) emit the expected event
 * sequence and declare the wire-classification their consumers
 * already depend on.
 *
 * The framework itself (dispatchProjectedToolStream, schema-inferred
 * wire, idle-timeout) is exhaustively tested in @papercusp/agent-mcp.
 * This file is the per-tool boundary check: did we wire the right
 * Zod shapes + emit the right event names from each handler.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

type EmittedEvent = { name: string; data: unknown };

function recordingCtx(over: Record<string, unknown> = {}) {
  const events: EmittedEvent[] = [];
  return {
    events,
    ctx: {
      log: vi.fn(),
      signal: new AbortController().signal,
      progress: vi.fn(),
      emit: (name: string, data: unknown) => events.push({ name, data }),
      workspaceId: 'default',
      harnessSlug: 'sheets',
      role: 'operator' as const,
      runId: 'run_T',
      spawnId: 'spw_T',
      ...over,
    } as never,
  };
}

async function* mockAgentChat(events: Array<unknown>) {
  for (const ev of events) yield ev;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../agent-chat-stream');
  vi.doUnmock('../architect/prompts');
  vi.doUnmock('../../system-principal');
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../delegates');
  vi.doUnmock('../../delegate-summary');
  vi.doUnmock('../../memory/injection');
});

describe('architect:chat + brainstorm:chat (raw-text wire)', () => {
  it('declares delta + error as z.string() so wire stays raw', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    await import('../architect/chat'); // register
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    for (const name of ['architect:chat', 'brainstorm:chat']) {
      const tool = lookupByMcpName(name);
      expect(tool, `${name} registered`).toBeTruthy();
      expect(tool!.eventWireKinds?.delta).toBe('string');
      expect(tool!.eventWireKinds?.error).toBe('string');
      expect(tool!.eventWireKinds?.tool_call).toBe('json');
      expect(tool!.eventWireKinds?.cost).toBe('json');
    }
  });

  it('emits delta as raw text + cost on result', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'Hello ' },
          { type: 'delta', text: 'world' },
          { type: 'tool_call', name: 'chat:ask_choice', input: { options: ['a', 'b'] } },
          { type: 'result', costUsd: 0.0012, tokensIn: 42, tokensOut: 7 },
        ]),
    }));
    // The tool now composes the prompt internally from the harness's
    // SPEC.md / features list. Mock the prompts helpers so the unit
    // test doesn't need a real project on disk + PG. The wire-format
    // shape under test (delta as raw text + cost as JSON) is
    // unaffected by what the prompt actually contains.
    vi.doMock('../architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    const { architectChat } = await import('../architect/chat');
    const { events, ctx } = recordingCtx();

    const result = (await architectChat.handler(
      { harnessSlug: 't', history: [], message: 'hi' },
      ctx,
    )) as { content: Array<{ type: 'text'; text: string }> };

    expect(events).toEqual([
      { name: 'delta', data: 'Hello ' },
      { name: 'delta', data: 'world' },
      { name: 'tool_call', data: { name: 'chat:ask_choice', input: { options: ['a', 'b'] } } },
      { name: 'cost', data: { usd: 0.0012, input: 42, output: 7 } },
    ]);
    expect(result.content[0].text).toBe('Hello world');
  });

  it('emits non-fatal error as raw text without throwing', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'partial' },
          { type: 'error', message: 'tool x failed', stderr: 'EACCES' },
          { type: 'delta', text: ' rest' },
        ]),
    }));
    vi.doMock('../architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    const { brainstormChat } = await import('../architect/chat');
    const { events, ctx } = recordingCtx();

    await brainstormChat.handler({ harnessSlug: 't', history: [], message: 'hi' }, ctx);

    const errorEv = events.find((e) => e.name === 'error');
    expect(errorEv).toBeTruthy();
    expect(typeof errorEv!.data).toBe('string');
    expect(errorEv!.data).toContain('tool x failed');
    expect(errorEv!.data).toContain('EACCES');
  });
});

describe('operator:converse / delegate (JSON-delta wire)', () => {
  // (operator:scan was removed with the scanner card stream —
  // unify-agent-launches D-005; scans fire the `scan` launch blueprint.)
  it('declares delta as object so wire is JSON', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    await import('../operator/converse');
    await import('../operator/delegate');
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    for (const name of ['operator:converse', 'operator:delegate']) {
      const tool = lookupByMcpName(name);
      expect(tool, `${name} registered`).toBeTruthy();
      expect(tool!.eventWireKinds?.delta).toBe('json');
    }
  });

  it('operator:delegate emits error as JSON object (not raw string)', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'thinking' },
          { type: 'tool_call', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'error', message: 'soft fail', stderr: '' },
          { type: 'result', costUsd: 0.001, tokensIn: 5, tokensOut: 5 },
        ]),
    }));
    // operator:delegate is thin sugar over work_items now — the handler runs
    // readSystemPrincipal + createDelegatedTask (the kind=task work_item) +
    // recordDelegateTurn + generateTaskTitle internally. Mock everything
    // PG-touching so the unit test stays unit-y.
    vi.doMock('../../system-principal', () => ({
      readSystemPrincipal: async () => ({
        bearer: 'x', workspaceId: 'default', principalId: 'p_test',
      }),
    }));
    vi.doMock('../../workspace-registry', () => ({
      activeWorkspaceId: () => 'default',
    }));
    vi.doMock('../../delegated-tasks', () => ({
      createDelegatedTask: async () => ({ id: 'WI-1' }),
      findOpenDelegatedTask: async () => null,
      recordDelegateTurn: async () => {},
    }));
    vi.doMock('../../delegate-summary', () => ({
      generateTaskTitle: async () => {},
    }));
    // Skip mem0 — the helper warns when the embedder isn't set up in
    // the test environment and vitest-fail-on-console flips it red.
    vi.doMock('../../memory/injection', () => ({
      buildMemoryContextBlock: async () => null,
      lastUserContext: () => '',
    }));
    const { default: delegate } = await import('../operator/delegate');
    const { events, ctx } = recordingCtx();

    await delegate.handler(
      {
        requestText: 'do the thing',
        sessionId: undefined,
        newSession: false,
      },
      ctx,
    );

    const errorEv = events.find((e) => e.name === 'error');
    expect(errorEv).toBeTruthy();
    expect(typeof errorEv!.data).toBe('object');
    expect((errorEv!.data as { message: string }).message).toBe('soft fail');

    // The new self-contained shape also emits a `session` event upfront.
    const sessionEv = events.find((e) => e.name === 'session');
    expect(sessionEv).toBeTruthy();
    expect((sessionEv!.data as { created: boolean }).created).toBe(true);
  });
});

describe('All four tools — common framework integration', () => {
  it('register with idleTimeoutSec + timeoutSec set (catches deadlocked-child)', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    const { architectChat, brainstormChat } = await import('../architect/chat');
    const { default: converse } = await import('../operator/converse');
    const { default: delegate } = await import('../operator/delegate');

    for (const [name, tool] of [
      ['architect:chat', architectChat],
      ['brainstorm:chat', brainstormChat],
      ['operator:converse', converse],
      ['operator:delegate', delegate],
    ] as const) {
      expect(tool.idleTimeoutSec, `${name} has idleTimeoutSec`).toBeGreaterThan(0);
      expect(tool.timeoutSec, `${name} has timeoutSec`).toBeGreaterThan(0);
    }
  });
});

describe('oracle:chat (JSON-shape delta wire)', () => {
  it('declares delta as z.object (JSON wire), not z.string', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    vi.doMock('../oracle/prompts', () => ({
      composeOraclePrompt: async () => ({ promptText: 'PROMPT', tutorialIsFinalStep: false }),
      buildOracleMcpConfig: async () => ({ mcpServers: {} }),
      oracleToolEventFilter: () => null,
      ORACLE_ALLOWED_TOOLS: [],
    }));
    await import('../oracle/chat');
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    const tool = lookupByMcpName('oracle:chat');
    expect(tool, 'oracle:chat registered').toBeTruthy();
    // Unlike architect:chat (raw text delta), oracle's consumer at
    // OracleDock.tsx:840 does JSON.parse(data).text — wire must be JSON.
    expect(tool!.eventWireKinds?.delta).toBe('json');
    expect(tool!.eventWireKinds?.error).toBe('json');
    expect(tool!.eventWireKinds?.tool_call).toBe('json');
    expect(tool!.eventWireKinds?.cost).toBe('json');
  });

  it('emits delta/cost via JSON wire + returns final text', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'Hello ' },
          { type: 'delta', text: 'world' },
          { type: 'result', costUsd: 0.0012, tokensIn: 30, tokensOut: 5 },
        ]),
    }));
    vi.doMock('../oracle/prompts', () => ({
      composeOraclePrompt: async () => ({ promptText: 'PROMPT', tutorialIsFinalStep: false }),
      buildOracleMcpConfig: async () => ({ mcpServers: {} }),
      oracleToolEventFilter: () => null,
      ORACLE_ALLOWED_TOOLS: [],
    }));
    const { default: oracle } = await import('../oracle/chat');
    const { events, ctx } = recordingCtx();

    const result = (await oracle.handler(
      { messages: [{ role: 'user', content: 'hi' }], currentPath: '', tutorialMode: false },
      ctx,
    )) as { content: Array<{ type: 'text'; text: string }> };

    const deltas = events.filter((e) => e.name === 'delta');
    expect(deltas).toHaveLength(2);
    expect((deltas[0]!.data as { text: string }).text).toBe('Hello ');
    expect((deltas[1]!.data as { text: string }).text).toBe('world');

    const costEv = events.find((e) => e.name === 'cost');
    expect(costEv).toBeTruthy();
    expect((costEv!.data as { usd: number }).usd).toBe(0.0012);

    expect(result.content[0]!.text).toBe('Hello world');
  });

  it('emits tutorial_end when composeOraclePrompt flags final step', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    vi.doMock('../oracle/prompts', () => ({
      composeOraclePrompt: async () => ({ promptText: 'PROMPT', tutorialIsFinalStep: true }),
      buildOracleMcpConfig: async () => ({ mcpServers: {} }),
      oracleToolEventFilter: () => null,
      ORACLE_ALLOWED_TOOLS: [],
    }));
    const { default: oracle } = await import('../oracle/chat');
    const { events, ctx } = recordingCtx();

    await oracle.handler(
      { messages: [{ role: 'user', content: 'stop' }], currentPath: '', tutorialMode: true },
      ctx,
    );

    expect(events.find((e) => e.name === 'tutorial_end')).toBeTruthy();
  });
});

describe('agent_chats:chat (thin-slice JSON-shape delta wire)', () => {
  it('declares delta + error as JSON wire (consumer at ChatPanel.tsx parses)', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    await import('../agent_chats/chat');
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    const tool = lookupByMcpName('agent_chats:chat');
    expect(tool, 'agent_chats:chat registered').toBeTruthy();
    expect(tool!.eventWireKinds?.delta).toBe('json');
    expect(tool!.eventWireKinds?.error).toBe('json');
  });

  it('streams deltas and returns rollup as JSON-encoded ToolResult content', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'one ' },
          { type: 'delta', text: 'two' },
          { type: 'result', costUsd: 0.005, tokensIn: 100, tokensOut: 50, finalText: 'one two' },
        ]),
    }));
    const { default: chat } = await import('../agent_chats/chat');
    const { events, ctx } = recordingCtx();

    const result = (await chat.handler(
      { promptText: 'PROMPT', cwd: '/tmp' },
      ctx,
    )) as { content: Array<{ type: 'text'; text: string }> };

    const deltas = events.filter((e) => e.name === 'delta');
    expect(deltas).toHaveLength(2);

    // Rollup is JSON-stringified in content[0].text — route shim parses.
    const rollup = JSON.parse(result.content[0]!.text) as {
      finalText: string;
      tokensIn: number;
      tokensOut: number;
      costUsd: number;
    };
    expect(rollup.finalText).toBe('one two');
    expect(rollup.tokensIn).toBe(100);
    expect(rollup.tokensOut).toBe(50);
    expect(rollup.costUsd).toBe(0.005);
  });

  it('emits error event when runAgentChat yields a mid-stream error', async () => {
    vi.doMock('../../agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'partial' },
          { type: 'error', message: 'agent crashed', stderr: 'oops' },
        ]),
    }));
    const { default: chat } = await import('../agent_chats/chat');
    const { events, ctx } = recordingCtx();

    await chat.handler({ promptText: 'PROMPT' }, ctx);

    const errorEv = events.find((e) => e.name === 'error');
    expect(errorEv).toBeTruthy();
    expect((errorEv!.data as { message: string }).message).toBe('agent crashed');
  });
});
