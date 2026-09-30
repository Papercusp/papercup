import { describe, expect, it } from 'vitest';
import { resolveChunkSurface, splitterVersionOf } from '@papercusp/search';
import {
  CHUNK_SURFACES,
  OPERATOR_TURNS_CHUNK_SURFACE,
  PLANS_CHUNK_SURFACE,
  surfaceStoreTable,
  TEXT_CHUNKS_TABLE,
} from './registry';
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

  it('plans are registered with the D-014 bench arm (P-009)', () => {
    expect(CHUNK_SURFACES).toContain(PLANS_CHUNK_SURFACE);
    const s = PLANS_CHUNK_SURFACE;
    expect(s.surface).toBe('plans');
    expect(s.parent).toEqual({
      table: 'harness_shared.harness_plans',
      key: ['workspace_id', 'harness_slug', 'plan_slug'],
    });
    // D-014: 1,500-character windows, 250 overlap, up to 32 windows, no margin.
    expect(s.splitter).toEqual({ kind: 'window', size: 1500, overlap: 250 });
    expect(s.maxChunks).toBe(32);
    expect(s.chunkMargin ?? 0).toBe(0);
    // The plan's own vector is the gist leg (D-005 readers stay on it).
    expect(s.parentVector).toEqual({
      column: 'embedding',
      profileColumn: 'embedding_profile',
      modeColumn: 'embedding_mode',
    });
    // Shared store, and no coverage-gate search source: plans:search is not one.
    expect(surfaceStoreTable(s)).toBe(TEXT_CHUNKS_TABLE);
    expect(s.searchSource).toBeUndefined();
  });

  it('operator turns are registered with the D-017 bench arm (P-010)', () => {
    expect(CHUNK_SURFACES).toContain(OPERATOR_TURNS_CHUNK_SURFACE);
    const s = OPERATOR_TURNS_CHUNK_SURFACE;
    expect(s.surface).toBe('operator_turns');
    expect(s.parent).toEqual({ table: 'harness_shared.operator_turns', key: ['id'] });
    // D-017: 1,500/250 windows, up to 8, chunk margin 0.06.
    expect(s.splitter).toEqual({ kind: 'window', size: 1500, overlap: 250 });
    expect(s.maxChunks).toBe(8);
    expect(s.chunkMargin).toBe(0.06);
    expect(s.parentVector).toEqual({
      column: 'text_embedding',
      profileColumn: 'text_embedding_profile',
      modeColumn: 'text_embedding_mode',
    });
    expect(surfaceStoreTable(s)).toBe(TEXT_CHUNKS_TABLE);
    // Its chunks feed the search:semantic 'turns' source, so the coverage gate counts them there.
    expect(s.searchSource).toBe('turns');
  });

  it('plan templates are never chunked (they are never searched)', () => {
    expect(PLANS_CHUNK_SURFACE.eligibleSql).toMatch(/\bp\.template_slug IS NULL\b/);
    expect(PLANS_CHUNK_SURFACE.textSql).toBe('p.content');
    expect(PLANS_CHUNK_SURFACE.headerSql).toBe('p.title');
  });

  it('the tick is inert under vitest unless a SQL handle is injected', async () => {
    expect(await runChunkSyncTick()).toEqual({ skipped: 'vitest' });
  });
});
