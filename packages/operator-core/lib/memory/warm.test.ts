import { describe, it, expect, vi } from 'vitest';
import { warmMemoryEmbedder } from './warm';
import type { MemoryBackend } from '@papercusp/memory';

function fakeBackend(over: Partial<MemoryBackend>): MemoryBackend {
  return {
    name: 'fake',
    available: async () => ({ ok: true }),
    remember: async () => ({ ids: [] }),
    search: async () => [],
    list: async () => [],
    get: async () => null,
    forget: async () => {},
    update: async () => {},
    ...over,
  } as MemoryBackend;
}

describe('warmMemoryEmbedder (P-004a)', () => {
  it('fires one throwaway search when the backend is available', async () => {
    const search = vi.fn(async () => []);
    await warmMemoryEmbedder(fakeBackend({ search: search as MemoryBackend['search'] }));
    expect(search).toHaveBeenCalledTimes(1);
    const [, opts] = search.mock.calls[0] as unknown as Parameters<MemoryBackend['search']>;
    expect(opts).toMatchObject({ scope: '__warmup__' });
  });

  it('skips the search when the backend is unavailable', async () => {
    const search = vi.fn(async () => []);
    await warmMemoryEmbedder(
      fakeBackend({ available: async () => ({ ok: false, reason: 'mem0_unavailable' }), search: search as MemoryBackend['search'] }),
    );
    expect(search).not.toHaveBeenCalled();
  });

  it('never throws even if available() or search() rejects (best-effort)', async () => {
    await expect(
      warmMemoryEmbedder(fakeBackend({ available: async () => { throw new Error('boom'); } })),
    ).resolves.toBeUndefined();
    await expect(
      warmMemoryEmbedder(fakeBackend({ search: async () => { throw new Error('boom'); } })),
    ).resolves.toBeUndefined();
  });
});
