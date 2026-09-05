import { describe, expect, it, vi } from 'vitest';
import { createQueryEmbedderWarmup } from './query-embedder-warmup';

const resolved = (embed: (text: string, signal?: AbortSignal) => Promise<number[]>, dims = 768) => ({
  mode: 'gemma',
  dims,
  embed,
});

describe('createQueryEmbedderWarmup', () => {
  it('single-flights cold selection, returns lexical-safe rejection, then publishes the exact embedder', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const embed = vi.fn(async () => [0.1]);
    const resolveEmbedder = vi.fn(async () => {
      await gate;
      return resolved(embed);
    });
    const warmup = createQueryEmbedderWarmup({
      warmupText: 'warmup',
      retryTokenPrefix: 'query',
      resolve: resolveEmbedder,
    });

    const first = warmup.select();
    const second = warmup.select();
    expect(resolveEmbedder).toHaveBeenCalledTimes(1);
    expect(first.resolved).toBeNull();
    expect(second.retry).toEqual(first.retry);
    await expect(first.embedder('query')).rejects.toThrow(/warming up/);

    release();
    await warmup.warm();
    const selected = warmup.select();
    expect(selected.resolved?.embed).toBe(embed);
    expect(selected.embedder).toBe(embed);
    expect(embed).toHaveBeenCalledWith('warmup');
  });

  it('keeps a settled failure visible and does not advertise retry after the failed attempt', async () => {
    const resolveEmbedder = vi.fn(async () => {
      throw new Error('sidecar unavailable');
    });
    const warmup = createQueryEmbedderWarmup({
      warmupText: 'warmup',
      retryTokenPrefix: 'query',
      resolve: resolveEmbedder,
    });

    const first = warmup.select();
    expect(first.retry).toBeDefined();
    await warmup.warm();
    const second = warmup.select();
    expect(second.retry).toBeUndefined();
    await expect(second.embedder('query')).rejects.toThrow(/sidecar unavailable/);
  });

  it('rejects an incompatible dimension before publishing the exact embedder', async () => {
    const embed = vi.fn(async () => [0.1]);
    const warmup = createQueryEmbedderWarmup({
      warmupText: 'warmup',
      retryTokenPrefix: 'query',
      resolve: async () => resolved(embed, 1024),
      validate: (value) => (value.dims === 768 ? null : `wrong dims ${value.dims}`),
    });

    await expect(warmup.warm()).resolves.toBe(false);
    const selected = warmup.select();
    expect(selected.resolved).toBeNull();
    expect(selected.retry).toBeUndefined();
    await expect(selected.embedder('query')).rejects.toThrow('wrong dims 1024');
    expect(embed).not.toHaveBeenCalled();
  });
});
