import { describe, expect, it } from 'vitest';
import { resolveChunkSurface, splitterVersionOf } from '@papercusp/search';
import { CHUNK_SURFACES } from './registry';
import { runChunkSyncTick } from './tick';

describe('chunk surface registry', () => {
  it('every entry is valid, so a registry mistake fails here instead of at sync time', () => {
    for (const s of CHUNK_SURFACES) expect(() => resolveChunkSurface(s), s.surface).not.toThrow();
  });

  it('surface names are unique (they partition the shared chunk table)', () => {
    const names = CHUNK_SURFACES.map((s) => s.surface);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every entry reads its version from the parent, so detection never hashes parent text in SQL', () => {
    for (const s of CHUNK_SURFACES) expect(s.versionSql, s.surface).toBeTruthy();
  });

  it('splitter versions are distinct per splitter shape (a registry edit re-cuts)', () => {
    const a = splitterVersionOf({ splitter: { kind: 'window', size: 1500, overlap: 250 }, maxChunks: 8 });
    const b = splitterVersionOf({ splitter: { kind: 'window', size: 1500, overlap: 250 }, maxChunks: 32 });
    expect(a).not.toBe(b);
  });

  it('the tick is inert under vitest unless a SQL handle is injected', async () => {
    expect(await runChunkSyncTick()).toEqual({ skipped: 'vitest' });
  });
});
