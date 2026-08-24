/**
 * anthropic-port unit tests (P-007, own-tui-full-divorce-2026-08-24).
 * The parser is pure over an iterable of raw anthropic SSE frames, so every
 * wire behavior is pinned with scripted frames — no SDK, no network. The
 * final test composes the REAL loop over the REAL port (fake wire) to prove
 * the two halves speak the same contract end-to-end.
 */
import { describe, expect, it } from 'vitest';
import {
  buildAnthropicParams,
  createAnthropicPort,
  parseAnthropicStream,
  withCost,
} from './anthropic-port';
import { runAgentLoop, type LoopTool } from './loop';
import { textMessage, type ModelStreamEvent } from './model-port';
import { providerWireToolName } from './model-tool-name-codec';

async function parse(frames: unknown[]): Promise<ModelStreamEvent[]> {
  const out: ModelStreamEvent[] = [];
  for await (const ev of parseAnthropicStream(frames)) out.push(ev);
  return out;
}

describe('buildAnthropicParams', () => {
  it('maps messages, tools, system and temperature onto the wire shape', () => {
    const params = buildAnthropicParams({
      model: 'claude-sonnet-4-6',
      system: 'be terse',
      temperature: 0.3,
      maxTokens: 1234,
      messages: [
        textMessage('user', 'hi'),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool_call', id: 'tc1', name: 'echo', input: { a: 1 } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolCallId: 'tc1', content: { ok: true }, isError: false }],
        },
      ],
      tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }],
    });
    expect(params.model).toBe('claude-sonnet-4-6');
    expect(params.max_tokens).toBe(1234);
    expect(params.temperature).toBe(0.3);
    expect(params.tools).toEqual([{ name: 'echo', description: 'd', input_schema: { type: 'object' } }]);
    const messages = params.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages[1].content[1]).toEqual({ type: 'tool_use', id: 'tc1', name: 'echo', input: { a: 1 } });
    expect(messages[2].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tc1',
      content: '{"ok":true}',
    });
    // system is always framed (OAuth bucket identifier), even for empty input
    expect(Array.isArray(params.system)).toBe(true);
  });

  it('omits temperature for opus models', () => {
    const params = buildAnthropicParams({
      model: 'claude-opus-5',
      temperature: 0.7,
      messages: [textMessage('user', 'hi')],
    });
    expect(params.temperature).toBeUndefined();
  });
});

describe('parseAnthropicStream', () => {
  it('parses text deltas, usage and stop reason', async () => {
    const events = await parse([
      { type: 'message_start', message: { usage: { input_tokens: 11, cache_read_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]);
    expect(events).toEqual([
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
      {
        type: 'stop',
        reason: 'end_turn',
        usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 5 },
      },
    ]);
  });

  it('accumulates input_json_delta frames and emits the tool_call COMPLETE', async () => {
    const events = await parse([
      { type: 'message_start', message: { usage: { input_tokens: 9 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'echo' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"va' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'lue":42}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
      { type: 'message_stop' },
    ]);
    expect(events).toEqual([
      { type: 'tool_call', id: 'tu1', name: 'echo', input: { value: 42 } },
      { type: 'stop', reason: 'tool_use', usage: { inputTokens: 9, outputTokens: 7 } },
    ]);
  });

  it('an empty tool input JSON becomes {}', async () => {
    const events = await parse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'noargs' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]);
    expect(events[0]).toEqual({ type: 'tool_call', id: 't1', name: 'noargs', input: {} });
  });

  it('malformed accumulated JSON surfaces as __unparsed instead of vanishing', async () => {
    const events = await parse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'bad' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"trunc' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    expect(events[0]).toEqual({ type: 'tool_call', id: 't1', name: 'bad', input: { __unparsed: '{"trunc' } });
  });

  it('thinking deltas map to reasoning_delta', async () => {
    const events = await parse([
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    ]);
    expect(events[0]).toEqual({ type: 'reasoning_delta', text: 'hmm' });
  });

  it('an error frame is terminal', async () => {
    const events = await parse([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'par' } },
      { type: 'error', error: { message: 'overloaded' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'never' } },
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'error', message: 'overloaded' });
  });

  it('parallel tool_use blocks at different indices do not cross wires', async () => {
    const events = await parse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'first' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'b', name: 'second' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"n":2}' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"n":1}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]);
    expect(events[0]).toEqual({ type: 'tool_call', id: 'a', name: 'first', input: { n: 1 } });
    expect(events[1]).toEqual({ type: 'tool_call', id: 'b', name: 'second', input: { n: 2 } });
  });
});

describe('createAnthropicPort + runAgentLoop end-to-end (fake wire)', () => {
  it('drives a tool round-trip through the real loop over the real port', async () => {
    const canonicalToolName = 'capability:echo';
    const wireToolName = providerWireToolName(canonicalToolName);
    const wires: unknown[][] = [
      // step 0: the model calls echo
      [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'w1', name: wireToolName } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"v":"x"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ],
      // step 1: the model answers
      [
        { type: 'message_start', message: { usage: { input_tokens: 20 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ],
    ];
    const sentParams: Record<string, unknown>[] = [];
    let call = 0;
    const port = createAnthropicPort({
      rawStream: (params) => {
        sentParams.push(params);
        return (async function* () {
          yield* wires[call++];
        })();
      },
    });
    const echo: LoopTool = {
      name: canonicalToolName,
      inputSchema: { type: 'object' },
      execute: async (input) => ({ echoed: input }),
    };
    const events: unknown[] = [];
    for await (const ev of runAgentLoop({
      port,
      model: 'claude-sonnet-4-6',
      messages: [textMessage('user', 'go')],
      tools: [echo],
      priority: 'interactive',
    })) {
      events.push(ev);
    }
    const done = events.find((e) => (e as { type: string }).type === 'done') as {
      stopReason: string;
      finalText: string;
      usage: { inputTokens: number; outputTokens: number };
    };
    expect(done.stopReason).toBe('complete');
    expect(done.finalText).toBe('answer');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_call',
      call: expect.objectContaining({ name: canonicalToolName }),
    }));
    // P-009: the port stamps per-step costUsd (priced model) and the loop
    // sums it — 10in+3out then 20in+2out at $3/$15 per MTok.
    expect(done.usage).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      costUsd: expect.closeTo(0.000165, 9) as unknown as number,
    });
    // the second wire call carried the tool_result back on the wire shape
    const m2 = sentParams[1].messages as Array<{ role: string; content: Array<{ type: string }> }>;
    expect(m2.at(-1)!.content[0].type).toBe('tool_result');
    // the request carried the tool defs
    expect(wireToolName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(wireToolName).not.toBe(canonicalToolName);
    expect(sentParams[0].tools).toEqual([{ name: wireToolName, input_schema: { type: 'object' } }]);
  });
});

// ── P-009: usage → cost stamping ───────────────────────────────────────────

describe('withCost', () => {
  const stop = (usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): Extract<ModelStreamEvent, { type: 'stop' }> => ({
    type: 'stop',
    reason: 'end_turn',
    ...(usage ? { usage } : {}),
  });

  it('stamps costUsd for a priced model ($3/$15 per MTok for sonnet 4.6)', () => {
    const out = withCost(
      'claude-sonnet-4-6',
      stop({ inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    );
    expect(out.usage?.costUsd).toBeCloseTo(18.0, 6);
  });

  it('prices the cache tiers with the documented defaults (0.1× / 1.25×)', () => {
    const out = withCost(
      'claude-sonnet-4-6',
      stop({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      }),
    );
    expect(out.usage?.costUsd).toBeCloseTo(0.3 + 3.75, 6);
  });

  it('leaves an unknown model un-stamped — never a fabricated $0', () => {
    const out = withCost('totally-unknown-model-x', stop({ inputTokens: 5, outputTokens: 5 }));
    expect(out.usage).toBeDefined();
    expect(out.usage?.costUsd).toBeUndefined();
  });

  it('passes a usage-less stop through untouched', () => {
    const ev = stop();
    expect(withCost('claude-sonnet-4-6', ev)).toBe(ev);
  });

  it('the port stamps cost on the live stream path (fake wire)', async () => {
    const port = createAnthropicPort({
      rawStream: () =>
        (async function* () {
          yield { type: 'message_start', message: { usage: { input_tokens: 1_000_000 } } };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hi' },
          };
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 1_000_000 },
          };
          yield { type: 'message_stop' };
        })(),
    });
    const events: ModelStreamEvent[] = [];
    for await (const ev of port.stream({
      model: 'claude-sonnet-4-6',
      messages: [textMessage('user', 'hi')],
    })) {
      events.push(ev);
    }
    const stopEv = events.find((e) => e.type === 'stop') as Extract<
      ModelStreamEvent,
      { type: 'stop' }
    >;
    expect(stopEv.usage?.costUsd).toBeCloseTo(18.0, 6);
  });
});
