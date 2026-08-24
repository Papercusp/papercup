import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
