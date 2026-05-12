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
    const { architectChat } = await import('@/lib/agent-tools/architect/chat');
    const { events, ctx } = recordingCtx();

    const result = (await architectChat.handler(
      { promptText: 'pr', cwd: '/tmp' },
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
    const { brainstormChat } = await import('@/lib/agent-tools/architect/chat');
    const { events, ctx } = recordingCtx();

    await brainstormChat.handler({ promptText: 'p', cwd: '/tmp' }, ctx);

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

  it('operator:scan emits delta as { text } and assembles final text', async () => {
    vi.doMock('@/lib/agent-chat-stream', () => ({
      runAgentChat: () =>
        mockAgentChat([
          { type: 'delta', text: 'scan: ' },
          { type: 'delta', text: 'looking...' },
          { type: 'result', costUsd: 0.005, tokensIn: 100, tokensOut: 20 },
        ]),
    }));
    const { default: scan } = await import('@/lib/agent-tools/operator/scan');
    const { events, ctx } = recordingCtx();

    const result = (await scan.handler(
      {
        promptText: 'scan',
        superuserToken: null,
        scannerSessionId: null,
        preferencesJson: '{}',
      },
      ctx,
    )) as { content: Array<{ type: 'text'; text: string }> };

    expect(events.filter((e) => e.name === 'delta')).toEqual([
      { name: 'delta', data: { text: 'scan: ' } },
      { name: 'delta', data: { text: 'looking...' } },
    ]);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.costUsd).toBe(0.005);
    expect(payload.assistantText).toBe('scan: looking...');
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
    const { default: delegate } = await import('@/lib/agent-tools/operator/delegate');
    const { events, ctx } = recordingCtx();

    await delegate.handler(
      {
        promptText: 'p',
        agentSessionId: 'sess_T',
        mcpConfigJson: '{"mcpServers":{}}',
        allowedTools: [],
      },
      ctx,
    );

    const errorEv = events.find((e) => e.name === 'error');
    expect(errorEv).toBeTruthy();
    expect(typeof errorEv!.data).toBe('object');
    expect((errorEv!.data as { message: string }).message).toBe('soft fail');
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
