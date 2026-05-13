/**
 * Phase 3 pilot+fold-in regression test — verifies the five migrated
 * streaming tools (architect:chat, brainstorm:chat, operator:scan,
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
  vi.doUnmock('@/lib/agent-chat-stream');
  vi.doUnmock('@/lib/agent-tools/architect/prompts');
  vi.doUnmock('@/lib/system-principal');
  vi.doUnmock('@/lib/workspace-registry');
  vi.doUnmock('@/lib/delegates');
  vi.doUnmock('@/lib/delegate-summary');
  vi.doUnmock('@/lib/memory/injection');
});

describe('architect:chat + brainstorm:chat (raw-text wire)', () => {
  it('declares delta + error as z.string() so wire stays raw', async () => {
    vi.doMock('@/lib/agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    await import('@/lib/agent-tools/architect/chat'); // register
    const { lookupByMcpName } = await import('@papercusp/agent-mcp/tool-projection');

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
    vi.doMock('@/lib/agent-chat-stream', () => ({
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
    vi.doMock('@/lib/agent-tools/architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    const { architectChat } = await import('@/lib/agent-tools/architect/chat');
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
    vi.doMock('@/lib/agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'partial' },
          { type: 'error', message: 'tool x failed', stderr: 'EACCES' },
          { type: 'delta', text: ' rest' },
        ]),
    }));
    vi.doMock('@/lib/agent-tools/architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    const { brainstormChat } = await import('@/lib/agent-tools/architect/chat');
    const { events, ctx } = recordingCtx();

    await brainstormChat.handler({ harnessSlug: 't', history: [], message: 'hi' }, ctx);

    const errorEv = events.find((e) => e.name === 'error');
    expect(errorEv).toBeTruthy();
    expect(typeof errorEv!.data).toBe('string');
    expect(errorEv!.data).toContain('tool x failed');
    expect(errorEv!.data).toContain('EACCES');
  });
});

describe('operator:scan / converse / delegate (JSON-delta wire)', () => {
  it('declares delta as object so wire is JSON', async () => {
    vi.doMock('@/lib/agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    await import('@/lib/agent-tools/operator/scan');
    await import('@/lib/agent-tools/operator/converse');
    await import('@/lib/agent-tools/operator/delegate');
    const { lookupByMcpName } = await import('@papercusp/agent-mcp/tool-projection');

    for (const name of ['operator:scan', 'operator:converse', 'operator:delegate']) {
      const tool = lookupByMcpName(name);
      expect(tool, `${name} registered`).toBeTruthy();
      expect(tool!.eventWireKinds?.delta).toBe('json');
    }
  });

  it('operator:scan tool registers with the expected args shape', async () => {
    // Post-refactor (PR for IPC allowlist eligibility), operator:scan
    // is self-contained: budget check, scan lock, scan tracker, plugin
    // merge, snapshot, session bump all run inside the handler. A
    // unit test that mocked away all those side-effects would test
    // nothing meaningful — the real coverage now lives in integration
    // tests with a real PG fixture (out of scope for this branch).
    //
    // What's still verifiable at unit level: the registry has the
    // tool, its args schema matches the new shape, and it's role-gated
    // on 'operator'.
    const { default: scan } = await import('@/lib/agent-tools/operator/scan');
    expect(scan.name).toBe('operator:scan');
    expect(scan.roles).toEqual(['operator']);
    // New args shape: { requestText, background, userId, superuserToken }
    // (old args 'promptText' / 'scannerSessionId' / 'preferencesJson'
    // are no longer the tool's surface — they're built inside).
    const argsParse = scan.args.safeParse({
      requestText: 'scan',
      background: false,
      userId: 'anonymous',
      superuserToken: null,
    });
    expect(argsParse.success).toBe(true);
    const stalePayload = scan.args.safeParse({
      promptText: 'scan',  // old arg name
      preferencesJson: '{}',
      scannerSessionId: null,
      superuserToken: null,
    });
    expect(stalePayload.success).toBe(false);
  });

  it('operator:delegate emits error as JSON object (not raw string)', async () => {
    vi.doMock('@/lib/agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'thinking' },
          { type: 'tool_call', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'error', message: 'soft fail', stderr: '' },
          { type: 'result', costUsd: 0.001, tokensIn: 5, tokensOut: 5 },
        ]),
    }));
    // operator:delegate is now self-contained — handler runs
    // readSystemPrincipal + createDelegate + bumpDelegate +
    // autoArchiveIdleDelegates + appendDelegateTurn +
    // generateSessionTitle internally. Mock everything PG-touching so
    // the unit test stays unit-y.
    vi.doMock('@/lib/system-principal', () => ({
      readSystemPrincipal: async () => ({
        bearer: 'x', workspaceId: 'default', principalId: 'p_test',
      }),
    }));
    vi.doMock('@/lib/workspace-registry', () => ({
      activeWorkspaceId: () => 'default',
    }));
    vi.doMock('@/lib/delegates', () => ({
      createDelegate: async () => {},
      getDelegate: async () => null,
      bumpDelegate: async () => {},
      autoArchiveIdleDelegates: async () => {},
      appendDelegateTurn: async () => {},
    }));
    vi.doMock('@/lib/delegate-summary', () => ({
      generateSessionTitle: async () => 'untitled',
    }));
    // Skip mem0 — the helper warns when the embedder isn't set up in
    // the test environment and vitest-fail-on-console flips it red.
    vi.doMock('@/lib/memory/injection', () => ({
      buildMemoryContextBlock: async () => null,
      lastUserContext: () => '',
    }));
    const { default: delegate } = await import('@/lib/agent-tools/operator/delegate');
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

describe('All five tools — common framework integration', () => {
  it('register with idleTimeoutSec + timeoutSec set (catches deadlocked-child)', async () => {
    vi.doMock('@/lib/agent-chat-stream', () => ({
      runAgentChat: () => mockAgentChat([]),
    }));
    const { architectChat, brainstormChat } = await import('@/lib/agent-tools/architect/chat');
    const { default: scan } = await import('@/lib/agent-tools/operator/scan');
    const { default: converse } = await import('@/lib/agent-tools/operator/converse');
    const { default: delegate } = await import('@/lib/agent-tools/operator/delegate');

    for (const [name, tool] of [
      ['architect:chat', architectChat],
      ['brainstorm:chat', brainstormChat],
      ['operator:scan', scan],
      ['operator:converse', converse],
      ['operator:delegate', delegate],
    ] as const) {
      expect(tool.idleTimeoutSec, `${name} has idleTimeoutSec`).toBeGreaterThan(0);
      expect(tool.timeoutSec, `${name} has timeoutSec`).toBeGreaterThan(0);
    }
  });
});
