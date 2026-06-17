import { describe, expect, it, vi } from 'vitest';
import {
  fromAnthropicResponse,
  makeLiveGaiaLlm,
  toAnthropicMessages,
  toAnthropicTools,
} from './agent-live';
import type { LlmMessage } from './agent';

describe('gaia agent-live — toAnthropicMessages', () => {
  it('maps user text/image/tool_result blocks', () => {
    const messages: LlmMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Q?' },
          { type: 'image', mediaType: 'image/png', dataBase64: 'AAA' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'web_search', input: { query: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu1', content: 'result text' }] },
    ];
    const out = toAnthropicMessages(messages);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'Q?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ]);
    expect(out[1].content).toEqual([{ type: 'tool_use', id: 'tu1', name: 'web_search', input: { query: 'x' } }]);
    expect(out[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'tu1', content: 'result text' }]);
  });

  it('round-trips thinking signature and redacted thinking', () => {
    const messages: LlmMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 'sig123' },
          { type: 'thinking', thinking: '', redactedData: 'REDACTED' },
          { type: 'text', text: 'answer' },
        ],
      },
    ];
    const out = toAnthropicMessages(messages);
    expect(out[0].content).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'sig123' },
      { type: 'redacted_thinking', data: 'REDACTED' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('marks tool_result errors', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: 'boom', isError: true }] },
    ]);
    expect(out[0].content).toEqual([{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }]);
  });
});

describe('gaia agent-live — toAnthropicTools', () => {
  it('maps name/description/inputSchema → input_schema', () => {
    const out = toAnthropicTools([{ name: 'web_search', description: 'd', inputSchema: { type: 'object', properties: {} } }]);
    expect(out).toEqual([{ name: 'web_search', description: 'd', input_schema: { type: 'object', properties: {} } }]);
  });
});

describe('gaia agent-live — fromAnthropicResponse', () => {
  it('maps text/tool_use/thinking blocks + usage incl. cache tokens', () => {
    const res = {
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 's' },
        { type: 'text', text: 'FINAL ANSWER: 7' },
        { type: 'tool_use', id: 'u', name: 'run_python', input: { code: 'print(7)' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    } as unknown as Parameters<typeof fromAnthropicResponse>[0];
    const out = fromAnthropicResponse(res);
    expect(out.stopReason).toBe('tool_use');
    expect(out.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 10, cacheWriteTokens: 5 });
    expect(out.content).toEqual([
      { type: 'thinking', thinking: 'hmm', signature: 's' },
      { type: 'text', text: 'FINAL ANSWER: 7' },
      { type: 'tool_use', id: 'u', name: 'run_python', input: { code: 'print(7)' } },
    ]);
  });

  it('maps redacted_thinking → a thinking block carrying redactedData', () => {
    const res = {
      content: [{ type: 'redacted_thinking', data: 'XYZ' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Parameters<typeof fromAnthropicResponse>[0];
    const out = fromAnthropicResponse(res);
    expect(out.content[0]).toEqual({ type: 'thinking', thinking: '', redactedData: 'XYZ' });
  });
});

describe('gaia agent-live — makeLiveGaiaLlm', () => {
  it('forces max_tokens above the thinking budget and passes mapped params to the client', async () => {
    const create = vi.fn(async () => ({
      content: [{ type: 'text', text: 'FINAL ANSWER: ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 },
    }));
    const llm = makeLiveGaiaLlm({ client: { messages: { create } } as never, thinking: true, thinkingBudgetTokens: 16000 });
    const r = await llm({ system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 8192 });
    expect(r.content[0]).toEqual({ type: 'text', text: 'FINAL ANSWER: ok' });
    const params = create.mock.calls[0][0];
    expect(params.max_tokens).toBe(16000 + 4096); // bumped above the budget
    expect(params.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 });
    expect(params.system).toBe('sys');
  });

  it('omits thinking when disabled and honors the caller maxTokens', async () => {
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    const llm = makeLiveGaiaLlm({ client: { messages: { create } } as never, thinking: false });
    await llm({ system: 's', messages: [], tools: [], maxTokens: 4096 });
    const params = create.mock.calls[0][0];
    expect(params.max_tokens).toBe(4096);
    expect(params.thinking).toBeUndefined();
  });
});
