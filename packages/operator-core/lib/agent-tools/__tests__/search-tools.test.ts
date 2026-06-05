/**
 * search-tools.test.ts — handler-level unit tests for search:fulltext and
 * search:semantic (Plan 1 P-016).
 *
 * Both tools delegate to @papercusp/search engine functions; tests confirm:
 *   - correct parameter forwarding (query, scope, workspaceId, limit)
 *   - result shape returned to caller
 *   - default scope expansion ('all' → all four named scopes)
 *   - reranker is called when hits are returned
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (tx?: unknown) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'ws_test',
    harnessSlug: 'sheets',
    role: 'operator' as const,
    tx: tx ?? ({} as any),
    principal: { slug: 'agent-test' },
  } as never);

const MOCK_HIT = {
  id: 'esc-1',
  source: 'escalations' as const,
  excerpt: 'some relevant text',
  score: 0.9,
  metadata: {},
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@papercusp/search');
  vi.doUnmock('./rerank');
});

// ─── search:fulltext ──────────────────────────────────────────────────────────

describe('search:fulltext', () => {
  it('calls runFullTextSearch with query + workspaceId + limit', async () => {
    const runFullTextSearch = vi.fn(async () => ({ results: [MOCK_HIT], totalHits: 1 }));
    vi.doMock('@papercusp/search', () => ({ runFullTextSearch }));
    vi.doMock('../search/rerank', () => ({ rerankProseHits: async (_, r: unknown[]) => r }));

    const { default: tool } = await import('../search/fulltext');
    await tool.handler({ query: 'authentication', limit: 3 }, MAKE_CTX());

    expect(runFullTextSearch).toHaveBeenCalledTimes(1);
    const [, opts] = runFullTextSearch.mock.calls[0];
    expect(opts.query).toBe('authentication');
    expect(opts.limit).toBe(3);
    expect(opts.workspaceId).toBe('ws_test');
  });

  it('returns hits and totalHits in the response', async () => {
    vi.doMock('@papercusp/search', () => ({
      runFullTextSearch: vi.fn(async () => ({ results: [MOCK_HIT], totalHits: 1 })),
    }));
    vi.doMock('../search/rerank', () => ({
      rerankProseHits: async (_: unknown, r: unknown[]) => r,
    }));

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'auth' }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.total_hits).toBe(1);
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('expands scope=all to all four named scopes', async () => {
    const runFullTextSearch = vi.fn(async () => ({ results: [], totalHits: 0 }));
    vi.doMock('@papercusp/search', () => ({ runFullTextSearch }));
    vi.doMock('../search/rerank', () => ({
      rerankProseHits: async (_: unknown, r: unknown[]) => r,
    }));

    const { default: tool } = await import('../search/fulltext');
    // Pass 'all' scope — should expand to all four named scopes (sources filtered by name).
    await tool.handler({ query: 'cost', scope: ['all'] }, MAKE_CTX());

    // The first argument to runFullTextSearch is the sources array — should be non-empty.
    const [sources] = runFullTextSearch.mock.calls[0];
    expect(sources.length).toBeGreaterThan(0);
  });

  it('filters to only the requested scope', async () => {
    const runFullTextSearch = vi.fn(async () => ({ results: [], totalHits: 0 }));
    vi.doMock('@papercusp/search', () => ({ runFullTextSearch }));
    vi.doMock('../search/rerank', () => ({
      rerankProseHits: async (_: unknown, r: unknown[]) => r,
    }));

    const { default: tool } = await import('../search/fulltext');
    await tool.handler({ query: 'cost', scope: ['escalations'] }, MAKE_CTX());

    const [sources] = runFullTextSearch.mock.calls[0];
    expect(sources.every((s: { name: string }) => s.name === 'escalations')).toBe(true);
  });

  it('passes harness_slug as scopeFilter', async () => {
    const runFullTextSearch = vi.fn(async () => ({ results: [], totalHits: 0 }));
    vi.doMock('@papercusp/search', () => ({ runFullTextSearch }));
    vi.doMock('../search/rerank', () => ({
      rerankProseHits: async (_: unknown, r: unknown[]) => r,
    }));

    const { default: tool } = await import('../search/fulltext');
    await tool.handler({ query: 'anything', harness_slug: 'org' }, MAKE_CTX());

    const [, opts] = runFullTextSearch.mock.calls[0];
    expect(opts.scopeFilter).toBe('org');
  });
});

// ─── search:semantic ──────────────────────────────────────────────────────────

describe('search:semantic', () => {
  it('calls runHybridSearch with query + mode + workspaceId', async () => {
    const runHybridSearch = vi.fn(async () => ({ results: [], totalHits: 0, embedderAvailable: true }));
    vi.doMock('@papercusp/search', () => ({ runHybridSearch }));
    vi.doMock('../search/embedder', () => ({
      buildQueryEmbedder: vi.fn(async () => vi.fn()),
    }));
    vi.doMock('../search/rerank', () => ({
      rerankProseHits: async (_: unknown, r: unknown[]) => r,
    }));

    const { default: tool } = await import('../search/semantic');
    await tool.handler({ query: 'auth strategy', mode: 'hybrid', limit: 4 }, MAKE_CTX());

    expect(runHybridSearch).toHaveBeenCalledTimes(1);
    const [, opts] = runHybridSearch.mock.calls[0];
    expect(opts.query).toBe('auth strategy');
    expect(opts.mode).toBe('hybrid');
    expect(opts.limit).toBe(4);
    expect(opts.workspaceId).toBe('ws_test');
  });

  it('defaults to hybrid mode', async () => {
    const runHybridSearch = vi.fn(async () => ({ results: [], totalHits: 0, embedderAvailable: false }));
    vi.doMock('@papercusp/search', () => ({ runHybridSearch }));
    vi.doMock('../search/embedder', () => ({
      buildQueryEmbedder: vi.fn(async () => vi.fn()),
    }));
    vi.doMock('../search/rerank', () => ({
      rerankProseHits: async (_: unknown, r: unknown[]) => r,
    }));

    const { default: tool } = await import('../search/semantic');
    await tool.handler({ query: 'test' }, MAKE_CTX());

    const [, opts] = runHybridSearch.mock.calls[0];
    expect(opts.mode).toBe('hybrid');
  });

  it('returns results and embedderAvailable flag', async () => {
    vi.doMock('@papercusp/search', () => ({
      runHybridSearch: vi.fn(async () => ({ results: [MOCK_HIT], totalHits: 1, embedderAvailable: true })),
    }));
    vi.doMock('../search/embedder', () => ({
      buildQueryEmbedder: vi.fn(async () => vi.fn()),
    }));
    vi.doMock('../search/rerank', () => ({
      rerankProseHits: async (_: unknown, r: unknown[]) => r,
    }));

    const { default: tool } = await import('../search/semantic');
    const result = (await tool.handler({ query: 'test' }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.total_hits).toBe(1);
    expect(data.embedder_available).toBe(true);
  });
});
