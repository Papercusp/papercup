import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import {
  aiSdkWireToolName,
  buildAiSdkCallOptions,
  createAiSdkPort,
  effortProviderOptions,
  toAiSdkPrompt,
} from './ai-sdk-port';
import type { ModelMessage, ModelRequest } from './model-port';

function stream(parts: LanguageModelV3StreamPart[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function fakeModel(
  parts: LanguageModelV3StreamPart[],
  observe?: (options: LanguageModelV3CallOptions) => void,
): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'openai.responses',
    modelId: 'gpt-5.4',
    supportedUrls: {},
    async doStream(options) {
      observe?.(options);
      return { stream: stream(parts) };
    },
    async doGenerate() {
      throw new Error('not used');
    },
  };
}

const messages: ModelMessage[] = [
  { role: 'user', content: [{ type: 'text', text: 'inspect it' }] },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'checking' },
      { type: 'tool_call', id: 'call-1', name: 'files:read', input: { path: 'a.ts' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolCallId: 'call-1', content: { ok: true } }],
  },
];

describe('AI SDK v6 prompt mapping', () => {
  it('keeps provider types behind ModelPort and preserves tool correlation', () => {
    expect(toAiSdkPrompt('system', messages)).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'inspect it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'files:read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'files:read',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
    ]);
  });

  it('maps effort onto each provider native option without changing the public spec', () => {
    expect(effortProviderOptions('openai', 'xhigh')).toEqual({ openai: { reasoningEffort: 'xhigh' } });
    expect(effortProviderOptions('anthropic', 'high')).toEqual({ anthropic: { effort: 'high' } });
    expect(effortProviderOptions('openrouter', 'high')).toEqual({
      openrouter: { reasoning: { effort: 'high' } },
    });
    expect(effortProviderOptions('google', 'medium')).toEqual({
      google: { thinkingConfig: { thinkingLevel: 'medium' } },
    });
  });

  it('encodes namespaced projected-tool names into stable provider-safe aliases', () => {
    const encoded = aiSdkWireToolName('capability:read');
    expect(encoded).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(encoded).not.toBe('capability:read');
    expect(aiSdkWireToolName('capability:read')).toBe(encoded);
    expect(aiSdkWireToolName('capability_read')).toBe('capability_read');
    expect(aiSdkWireToolName('capability:write')).not.toBe(encoded);
  });

  it('builds tools, abort, headers, and effort on the provider-spec call', () => {
    const signal = new AbortController().signal;
    const req: ModelRequest = {
      model: 'openai/gpt-5.4:high',
      system: 'system',
      messages,
      tools: [{ name: 'files:read', inputSchema: { type: 'object' } }],
      maxTokens: 123,
      signal,
    };
    expect(buildAiSdkCallOptions(req, {
      model: fakeModel([]),
      provider: 'openai',
      modelId: 'gpt-5.4',
      effort: 'high',
      headers: { 'x-test': 'yes' },
    })).toMatchObject({
      maxOutputTokens: 123,
      abortSignal: signal,
      headers: { 'x-test': 'yes' },
      providerOptions: { openai: { reasoningEffort: 'high' } },
      tools: [{
        type: 'function',
        name: aiSdkWireToolName('files:read'),
        inputSchema: { type: 'object' },
      }],
      toolChoice: { type: 'auto' },
    });
  });
});

describe('createAiSdkPort', () => {
  it('maps v3 text/reasoning/tool/finish stream parts onto ModelStreamEvent', async () => {
    let observed: LanguageModelV3CallOptions | null = null;
    const model = fakeModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-delta', id: 'text-1', delta: 'hello' },
      { type: 'reasoning-delta', id: 'reason-1', delta: 'think' },
      {
        type: 'tool-call',
        toolCallId: 'call-2',
        toolName: aiSdkWireToolName('files:read'),
        input: '{"path":"b.ts"}',
      },
      {
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 1 },
          outputTokens: { total: 4, text: 3, reasoning: 1 },
        },
      },
    ], (options) => { observed = options; });
    const port = createAiSdkPort({
      resolveModel: () => ({ model, provider: 'openai', modelId: 'gpt-5.4', effort: 'high' }),
    });

    const events = [];
    for await (const event of port.stream({
      model: 'openai/gpt-5.4:high',
      messages,
      tools: [{ name: 'files:read', inputSchema: { type: 'object' } }],
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'text_delta', text: 'hello' },
      { type: 'reasoning_delta', text: 'think' },
      { type: 'tool_call', id: 'call-2', name: 'files:read', input: { path: 'b.ts' } },
      expect.objectContaining({
        type: 'stop',
        reason: 'tool_use',
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheCreationTokens: 1,
        }),
      }),
    ]);
    expect(observed).toMatchObject({ providerOptions: { openai: { reasoningEffort: 'high' } } });
    expect(observed).toMatchObject({
      tools: [{ name: aiSdkWireToolName('files:read') }],
    });
  });

  it('surfaces a truncated provider stream as an error instead of inventing a stop', async () => {
    const port = createAiSdkPort({
      resolveModel: () => ({
        model: fakeModel([{ type: 'text-delta', id: 't', delta: 'partial' }]),
        provider: 'openai',
        modelId: 'gpt-5.4',
      }),
    });
    const events = [];
    for await (const event of port.stream({ model: 'openai/gpt-5.4', messages: [] })) events.push(event);
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'AI SDK provider stream ended without a finish event',
    });
  });
});
