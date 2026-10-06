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

    expect(await collect(port, { ...request('sonnet:xhigh'), account: 'acct-anthropic' })).toEqual([
      { type: 'stop', reason: 'end_turn' },
    ]);
    expect(seen[0].model).toBe('claude-sonnet-current');
    expect(seen[0].account).toBe('acct-anthropic');
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

    const events = await collect(port, {
      ...request('gpt-5.4:high'),
      account: 'acct-codex',
      maxTokens: 32,
    });
    expect(events.at(-1), JSON.stringify(events)).toMatchObject({
      type: 'stop',
      reason: 'end_turn',
    });
    expect(calls[0]).toMatchObject({
      selection: { provider: 'gateway-codex', modelId: 'gpt-5.4', effort: 'high' },
      gatewayBaseUrl: 'http://gateway.test/v1',
    });
    expect(callOptions[0]).toMatchObject({
      headers: {
        'x-papercusp-priority': 'operator',
        'x-papercusp-account': 'acct-codex',
      },
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

  const apiProviders = [
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    ['mistral', 'MISTRAL_API_KEY'],
    ['groq', 'GROQ_API_KEY'],
    ['xai', 'XAI_API_KEY'],
  ] as const;
  const redirectedCatalog = (provider: string): ModelsDevCatalog => ({
    [provider]: {
      env: ['UNRELATED_PROVIDER_SECRET'],
      models: { 'model-test': { id: 'model-test' } },
    },
  });

  it.each(apiProviders)('does not send a catalog-selected foreign secret to %s', async (provider, keyName) => {
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({
      catalog: redirectedCatalog(provider),
      credentials: async () => ({}),
      env: { UNRELATED_PROVIDER_SECRET: 'foreign-test-secret' },
      createLanguageModel,
    });

    expect(await collect(port, request(`${provider}/model-test`))).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining(keyName) }),
    ]);
    expect(createLanguageModel).not.toHaveBeenCalled();
  });

  it.each(apiProviders)('uses the locally configured %s key despite catalog env metadata', async (provider, keyName) => {
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({
      catalog: redirectedCatalog(provider),
      credentials: async () => ({}),
      env: { [keyName]: ' intended-test-key ', UNRELATED_PROVIDER_SECRET: 'foreign-test-secret' },
      createLanguageModel,
    });

    expect((await collect(port, request(`${provider}/model-test`))).at(-1)).toMatchObject({
      type: 'stop', reason: 'end_turn',
    });
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'intended-test-key' }));
  });

  it.each(apiProviders)('names only local credential configuration when %s has no key', async (provider, keyName) => {
    const port = createRoutedModelPort({
      catalog: redirectedCatalog(provider),
      credentials: async () => ({}),
      env: {},
    });

    const events = await collect(port, request(`${provider}/model-test`));
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', message: expect.stringContaining(keyName) }),
    ]);
    expect(JSON.stringify(events)).not.toContain('UNRELATED_PROVIDER_SECRET');
  });

  it('retains the local Google key alias when catalog metadata omits it', async () => {
    const createLanguageModel = vi.fn(async () => model());
    const port = createRoutedModelPort({
      catalog,
      credentials: async () => ({}),
      env: { GOOGLE_GENERATIVE_AI_API_KEY: '  ', GOOGLE_API_KEY: 'google-alias-test-key' },
      createLanguageModel,
    });

    expect((await collect(port, request('google/gemini-test'))).at(-1)).toMatchObject({ type: 'stop' });
    expect(createLanguageModel).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'google-alias-test-key' }));
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
