import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyLoopModelSpec,
  loadModelsDevCatalog,
  resetModelsDevCatalogCache,
  resolveLoopModelSpec,
  type ModelsDevCatalog,
} from './model-selection';

const catalog: ModelsDevCatalog = {
  anthropic: {
    id: 'anthropic',
    npm: '@ai-sdk/anthropic',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      'claude-sonnet-old': {
        id: 'claude-sonnet-old',
        family: 'claude-sonnet',
        release_date: '2025-01-01',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
      'claude-sonnet-new': {
        id: 'claude-sonnet-new',
        family: 'claude-sonnet',
        release_date: '2026-08-01',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] }],
      },
    },
  },
  openai: {
    id: 'openai',
    npm: '@ai-sdk/openai',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-test': {
        id: 'gpt-test',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    },
  },
  google: {
    id: 'google',
    npm: '@ai-sdk/google',
    env: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    models: {
      'gemini-test': {
        id: 'gemini-test',
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    },
  },
};

afterEach(() => {
  resetModelsDevCatalogCache();
  vi.restoreAllMocks();
});

describe('resolveLoopModelSpec', () => {
  it('resolves psu Claude aliases to the newest models.dev family member and preserves effort', () => {
    expect(resolveLoopModelSpec('sonnet[1m]:xhigh', catalog)).toMatchObject({
      modelId: 'claude-sonnet-new',
      effort: 'xhigh',
      provider: 'gateway-anthropic',
    });
  });

  it('maps psu Codex aliases onto the subscription gateway', () => {
    expect(resolveLoopModelSpec('terra:max', catalog)).toMatchObject({
      modelId: 'gpt-5.6-terra',
      effort: 'max',
      provider: 'gateway-codex',
    });
  });

  it('uses explicit AI SDK providers for API-key models', () => {
    expect(resolveLoopModelSpec('google/gemini-test:high', catalog)).toMatchObject({
      modelId: 'gemini-test',
      effort: 'high',
      provider: 'google',
    });
  });

  it('preserves the nested OpenRouter model id and effort without requiring a catalog', () => {
    expect(resolveLoopModelSpec('openrouter/vendor/model-v2:high', null)).toMatchObject({
      provider: 'openrouter', modelId: 'vendor/model-v2', effort: 'high', metadata: null,
    });
  });

  it('only peels a recognized effort suffix, preserving colon-bearing model ids', () => {
    expect(resolveLoopModelSpec('openai/vendor:model-v2:0', catalog)).toMatchObject({
      modelId: 'vendor:model-v2:0',
      effort: null,
      provider: 'openai',
    });
  });

  it('refuses an unsupported effort instead of silently lowering it', () => {
    expect(() => resolveLoopModelSpec('openai/gpt-test:max', catalog)).toThrow(
      /allowed effort values: low\|high.*Refusing to silently lower/s,
    );
  });

  it('fails closed for an unknown unqualified provider id', () => {
    expect(() => resolveLoopModelSpec('mystery-model', null)).toThrow(/use <provider>\/<model>/);
  });
});

describe('classifyLoopModelSpec', () => {
  it('marks subscription gateway and AI SDK provider specs executable without a catalog', () => {
    expect(classifyLoopModelSpec('sonnet[1m]:high')).toEqual({
      executable: true,
      provider: 'gateway-anthropic',
    });
    expect(classifyLoopModelSpec('openai/gpt-5.4:max')).toEqual({
      executable: true,
      provider: 'openai',
    });
  });

  it('marks OpenRouter syntax executable without choosing an account or model default', () => {
    expect(classifyLoopModelSpec('openrouter/stealth/ox-alpha:max')).toEqual({
      executable: true,
      provider: 'openrouter',
    });
  });

  it('fails closed for unknown bare ids instead of guessing a provider', () => {
    const capability = classifyLoopModelSpec('mystery-model');
    expect(capability.executable).toBe(false);
    if (!capability.executable) expect(capability.reason).toMatch(/use <provider>\/\<model>/);
  });
});

describe('loadModelsDevCatalog', () => {
  it('deduplicates concurrent fetches and caches the validated object', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 }));
    const [a, b] = await Promise.all([
      loadModelsDevCatalog({ fetchImpl, now: () => 1 }),
      loadModelsDevCatalog({ fetchImpl, now: () => 1 }),
    ]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await loadModelsDevCatalog({ fetchImpl, now: () => 2 })).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed fetch', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('down', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(catalog), { status: 200 }));
    await expect(loadModelsDevCatalog({ fetchImpl, now: () => 1 })).rejects.toThrow(/HTTP 503/);
    await expect(loadModelsDevCatalog({ fetchImpl, now: () => 2 })).resolves.toEqual(catalog);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
