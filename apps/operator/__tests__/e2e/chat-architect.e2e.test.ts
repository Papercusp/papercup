/**
 * Step F (Tier-1 follow-up arc): architect:chat end-to-end test using
 * the fake-agent-chat fixture.
 *
 * Distinct from `streaming-tools-migration.test.ts` (wire-format unit
 * test). This test exercises the full handler path + asserts:
 *   - modality propagates from defineTool → registry (round-13 #36 regression)
 *   - replayBufferSize is set on the projected tool (round-13 #34 regression)
 *   - emitted events match what the fake generator produced
 *
 * The fixture lives in lib/test-fixtures/fake-agent-chat.ts and is
 * reused by step 6's brainstorm/oracle/converse/delegate tests.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fakeRunAgentChat } from '@papercusp/operator-core/lib/test-fixtures/fake-agent-chat';

type Emitted = { name: string; data: unknown };

function recordingCtx() {
  const events: Emitted[] = [];
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
      runId: 'run_F',
      spawnId: 'spw_F',
    } as never,
  };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@papercusp/operator-core/lib/agent-chat-stream');
  vi.doUnmock('@papercusp/operator-core/lib/agent-tools/architect/prompts');
  vi.doUnmock('@papercusp/operator-core/lib/memory/injection');
});

describe('architect:chat e2e (via fake-agent-chat fixture)', () => {
  it('emits the scripted event sequence through the handler', async () => {
    vi.doMock('@papercusp/operator-core/lib/agent-chat-stream', () => ({
      runAgentChat: () =>
        fakeRunAgentChat({
          deltas: [{ text: 'Hello ' }, { text: 'world' }],
          toolCalls: [
            { afterDelta: 1, name: 'chat:ask_choice', input: { options: ['a', 'b'] } },
          ],
          result: { costUsd: 0.005, tokensIn: 12, tokensOut: 3 },
        }),
    }));
    vi.doMock('@papercusp/operator-core/lib/agent-tools/architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    vi.doMock('@papercusp/operator-core/lib/memory/injection', () => ({
      buildMemoryContextBlock: async () => null,
    }));

    const { architectChat } = await import('@papercusp/operator-core/lib/agent-tools/architect/chat');
    const { events, ctx } = recordingCtx();

    const result = (await architectChat.handler(
      { harnessSlug: 't', history: [], message: 'hi' },
      ctx,
    )) as { content: Array<{ type: 'text'; text: string }> };

    expect(events).toEqual([
      { name: 'delta', data: 'Hello ' },
      { name: 'delta', data: 'world' },
      { name: 'tool_call', data: { name: 'chat:ask_choice', input: { options: ['a', 'b'] } } },
      { name: 'cost', data: { usd: 0.005, input: 12, output: 3 } },
    ]);
    expect(result.content[0].text).toBe('Hello world');
  });

  it('architect:chat declares modality in the projected registry (round-13 #36 regression)', async () => {
    vi.doMock('@papercusp/operator-core/lib/agent-chat-stream', () => ({
      runAgentChat: () => fakeRunAgentChat({}),
    }));
    vi.doMock('@papercusp/operator-core/lib/agent-tools/architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    await import('@papercusp/operator-core/lib/agent-tools/architect/chat'); // register
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    const tool = lookupByMcpName('architect:chat');
    expect(tool).toBeTruthy();
    // Modality may be undefined (default → ['text','voice'] per prompt-assembly)
    // OR an explicit array. Either way it must NOT be null — null would mean
    // the defineTool → registry forwarding is broken (the actual round-13 #36 bug).
    expect(tool!.modality === undefined || Array.isArray(tool!.modality)).toBe(true);
  });

  it('architect:chat declares replayBufferSize > 0 (round-13 #34 regression)', async () => {
    vi.doMock('@papercusp/operator-core/lib/agent-chat-stream', () => ({
      runAgentChat: () => fakeRunAgentChat({}),
    }));
    vi.doMock('@papercusp/operator-core/lib/agent-tools/architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    await import('@papercusp/operator-core/lib/agent-tools/architect/chat'); // register
    const { lookupByMcpName } = await import('@papercusp/agent-mcp');

    const tool = lookupByMcpName('architect:chat');
    expect(tool).toBeTruthy();
    expect(tool!.replayBufferSize).toBeGreaterThan(0);
    // Verify the buffer-size value matches the source-of-truth in chat.ts:
    expect(tool!.replayBufferSize).toBe(5000);
  });

  it('error short-circuit propagates as an error event without terminating the result', async () => {
    vi.doMock('@papercusp/operator-core/lib/agent-chat-stream', () => ({
      runAgentChat: () =>
        fakeRunAgentChat({
          deltas: [{ text: 'partial' }],
          error: { message: 'tool x failed', stderr: 'EACCES', afterDelta: 0 },
        }),
    }));
    vi.doMock('@papercusp/operator-core/lib/agent-tools/architect/prompts', () => ({
      resolveSlug: async () => ({ slug: 't', path: '/tmp' }),
      composeArchitectPrompt: async () => 'PROMPT',
      composeBrainstormPrompt: async () => 'PROMPT',
    }));
    vi.doMock('@papercusp/operator-core/lib/memory/injection', () => ({
      buildMemoryContextBlock: async () => null,
    }));

    const { architectChat } = await import('@papercusp/operator-core/lib/agent-tools/architect/chat');
    const { events, ctx } = recordingCtx();

    const result = (await architectChat.handler(
      { harnessSlug: 't', history: [], message: 'hi' },
      ctx,
    )) as { content: Array<{ type: 'text'; text: string }> };

    // Error short-circuits the fake gen → no `cost` event since no `result`.
    expect(events.map((e) => e.name)).toEqual(['delta', 'error']);
    expect((events[1].data as string)).toContain('tool x failed');
    expect(result.content[0].text).toBe('partial');
  });
});
