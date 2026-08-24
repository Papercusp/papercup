import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it, vi } from 'vitest';
import type { ModelPort, ModelRequest, ModelStreamEvent } from './model-port';
import type { ModelsDevCatalog } from './model-selection';
import { createRoutedModelPort, type ProviderFactoryArgs } from './provider-router';

const catalog: ModelsDevCatalog = {
  anthropic: {
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-sonnet-current': {
        id: 'claude-sonnet-current',
        family: 'claude-sonnet',
        release_date: '2026-08-01',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      },
    },
  },
  openai: {
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-5.4': {
        id: 'gpt-5.4',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      },
    },
  },
  google: {
    env: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    models: {
      'gemini-test': { id: 'gemini-test', reasoning: false },
    },
  },
};

const request = (modelSpec: string): ModelRequest => ({
  model: modelSpec,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  priority: 'operator',
});

function model(parts: LanguageModelV3StreamPart[] = [{
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
}], observe?: (options: Parameters<LanguageModelV3['doStream']>[0]) => void): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'fake',
    modelId: 'fake',
    supportedUrls: {},
    async doGenerate() { throw new Error('unused'); },
    async doStream(options) {
      observe?.(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

async function collect(port: ModelPort, req: ModelRequest): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of port.stream(req)) events.push(event);
  return events;
}

describe('createRoutedModelPort', () => {
  it('keeps bare Claude aliases on the native subscription gateway', async () => {
    const seen: ModelRequest[] = [];
    const native: ModelPort = {
      async *stream(req) {
        seen.push(req);
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({ catalog, anthropicPort: native, createLanguageModel });

    expect(await collect(port, request('sonnet:xhigh'))).toEqual([{ type: 'stop', reason: 'end_turn' }]);
    expect(seen[0].model).toBe('claude-sonnet-current');
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('routes bare OpenAI ids through the Codex subscription gateway with effort and priority', async () => {
    const calls: ProviderFactoryArgs[] = [];
    const callOptions: Parameters<LanguageModelV3['doStream']>[0][] = [];
    const port = createRoutedModelPort({
      catalog,
      gatewayBaseUrl: 'http://gateway.test/v1',
      createLanguageModel: async (args) => {
        calls.push(args);
        return model(undefined, (options) => callOptions.push(options));
      },
    });

    const events = await collect(port, { ...request('gpt-5.4:high'), maxTokens: 32 });
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'end_turn' });
    expect(calls[0]).toMatchObject({
      selection: { provider: 'gateway-codex', modelId: 'gpt-5.4', effort: 'high' },
      gatewayBaseUrl: 'http://gateway.test/v1',
    });
    expect(callOptions[0]).toMatchObject({
      headers: { 'x-papercusp-priority': 'operator' },
      providerOptions: { openai: { reasoningEffort: 'high' } },
    });
    expect(callOptions[0]).not.toHaveProperty('maxOutputTokens');
  });

  it('uses a stored OpenAI key for explicitly provider-qualified API calls', async () => {
    const calls: ProviderFactoryArgs[] = [];
    const port = createRoutedModelPort({
      catalog,
      credentials: async () => ({ openai_api_key: 'stored-openai-key' }),
      env: {},
      createLanguageModel: async (args) => {
        calls.push(args);
        return model();
      },
    });

    await collect(port, request('openai/gpt-5.4:high'));
    expect(calls[0]).toMatchObject({
      apiKey: 'stored-openai-key',
      selection: { provider: 'openai', modelId: 'gpt-5.4', effort: 'high' },
    });
  });

  it('fails before provider creation when an API-key provider has no credential', async () => {
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({
      catalog,
      credentials: async () => ({}),
      env: {},
      createLanguageModel,
    });

    expect(await collect(port, request('google/gemini-test'))).toEqual([
      expect.objectContaining({
        type: 'error',
        message: expect.stringMatching(/GOOGLE_GENERATIVE_AI_API_KEY/),
      }),
    ]);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it('surfaces credential-store failure as a ModelPort error event', async () => {
    const port = createRoutedModelPort({
      catalog,
      credentials: async () => { throw new Error('store unavailable'); },
      env: {},
    });
    expect(await collect(port, request('openai/gpt-5.4'))).toEqual([
      {
        type: 'error',
        message: 'failed to read provider credentials: store unavailable',
      },
    ]);
  });

  it('keeps known subscription families working when models.dev is unavailable', async () => {
    const native: ModelPort = {
      async *stream(req) {
        yield { type: 'error', message: req.model };
      },
    };
    const port = createRoutedModelPort({
      loadCatalog: async () => { throw new Error('offline'); },
      anthropicPort: native,
    });
    expect(await collect(port, request('claude-sonnet-4-6'))).toEqual([
      { type: 'error', message: 'claude-sonnet-4-6' },
    ]);
  });
});
