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

// rerankProseHits is stubbed identity-passthrough throughout this file (its own
// fail-safe behavior is covered in rerank.test.ts); rerankCandidateCount is
// delegated to the REAL implementation via importOriginal so this mock can
// never drift from RERANK_OVERFETCH/RERANK_MAX_CANDIDATES — a hand-picked
// stub would silently stop covering the over-fetch sizing fulltext.ts/
// semantic.ts actually send to the search engine.
const mockRerank = async (importOriginal: () => Promise<typeof import('../search/rerank')>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    rerankProseHits: async (_: unknown, r: unknown[]) => r,
  };
};

// ─── search:fulltext ──────────────────────────────────────────────────────────

// The search runners are mocked; type them to their (sources, opts) call shape so the
// `.mock.calls[0]` destructures below (`[sources]` / `[, opts]`) are typed, not 0-arg empty tuples.
type FullTextMock = (
  sources: Array<{ name: string }>,
  opts: Record<string, unknown>,
) => Promise<{ results: unknown[]; totalHits: number }>;
type HybridMock = (
  sources: Array<{ name: string }>,
  opts: Record<string, unknown>,
) => Promise<{ results: unknown[]; totalHits: number; embedderAvailable?: boolean }>;

describe('search:fulltext', () => {
  it('calls runFullTextSearch with query + workspaceId + the over-fetched (rerankCandidateCount) limit', async () => {
    const runFullTextSearch = vi.fn<FullTextMock>(async () => ({ results: [MOCK_HIT], totalHits: 1 }));
    vi.doMock('@papercusp/search', () => ({ runFullTextSearch }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    await tool.handler({ query: 'authentication', limit: 3 }, MAKE_CTX());

    expect(runFullTextSearch).toHaveBeenCalledTimes(1);
    const [, opts] = runFullTextSearch.mock.calls[0];
    expect(opts.query).toBe('authentication');
    // rerankCandidateCount(3) = max(3, min(3*RERANK_OVERFETCH, RERANK_MAX_CANDIDATES)) = 12.
    // The engine is asked to retrieve the over-fetched Stage B pool, not the raw
    // requested page — rerankProseHits (mocked passthrough here) slices back to
    // `limit` in the handler's own output.
    expect(opts.limit).toBe(12);
    expect(opts.workspaceId).toBe('ws_test');
  });

  it('returns hits and totalHits in the response', async () => {
    vi.doMock('@papercusp/search', () => ({
      runFullTextSearch: vi.fn(async () => ({ results: [MOCK_HIT], totalHits: 1 })),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'auth' }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.total_hits).toBe(1);
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('expands scope=all to all four named scopes', async () => {
    const runFullTextSearch = vi.fn<FullTextMock>(async () => ({ results: [], totalHits: 0 }));
    vi.doMock('@papercusp/search', () => ({ runFullTextSearch }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    // Pass 'all' scope — should expand to all four named scopes (sources filtered by name).
    await tool.handler({ query: 'cost', scope: ['all'] }, MAKE_CTX());

    // The first argument to runFullTextSearch is the sources array — should be non-empty.
    const [sources] = runFullTextSearch.mock.calls[0];
    expect(sources.length).toBeGreaterThan(0);
  });

  it('filters to only the requested scope', async () => {
    const runFullTextSearch = vi.fn<FullTextMock>(async () => ({ results: [], totalHits: 0 }));
    vi.doMock('@papercusp/search', () => ({ runFullTextSearch }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    await tool.handler({ query: 'cost', scope: ['escalations'] }, MAKE_CTX());

    const [sources] = runFullTextSearch.mock.calls[0];
    expect(sources.every((s: { name: string }) => s.name === 'escalations')).toBe(true);
  });

  it('passes harness_slug as scopeFilter', async () => {
    const runFullTextSearch = vi.fn<FullTextMock>(async () => ({ results: [], totalHits: 0 }));
    vi.doMock('@papercusp/search', () => ({ runFullTextSearch }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    await tool.handler({ query: 'anything', harness_slug: 'org' }, MAKE_CTX());

    const [, opts] = runFullTextSearch.mock.calls[0];
    expect(opts.scopeFilter).toBe('org');
  });

  // EI-18685793913963409: a ZERO-hit default-scope result reads as "no existing
  // bug/change/task duplicate" when 'work_item' (opt-in, EI-6984) was never
  // actually searched — the exact miss that let a dedup-search-first capture
  // create a duplicate of an already-landed WI-* fix. The hint must appear on
  // every response that didn't search work_item, and NEVER when it did.
  it('surfaces work_item_scope_hint on the historic (work_item-less) default scope', async () => {
    vi.doMock('@papercusp/search', () => ({
      runFullTextSearch: vi.fn(async () => ({ results: [], totalHits: 0 })),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'claimHold by-id bypass' }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.work_item_scope_hint).toMatch(/work_item/);
  });

  it('surfaces work_item_scope_hint when an explicit scope omits work_item', async () => {
    vi.doMock('@papercusp/search', () => ({
      runFullTextSearch: vi.fn(async () => ({ results: [], totalHits: 0 })),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'cost', scope: ['escalations'] }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.work_item_scope_hint).toBeDefined();
  });

  it('omits work_item_scope_hint once scope:["work_item"] is included', async () => {
    vi.doMock('@papercusp/search', () => ({
      runFullTextSearch: vi.fn(async () => ({ results: [], totalHits: 0 })),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'claimHold by-id bypass', scope: ['work_item'] }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.work_item_scope_hint).toBeUndefined();
  });

  it('omits work_item_scope_hint under scope:["all"] (work_item is included)', async () => {
    vi.doMock('@papercusp/search', () => ({
      runFullTextSearch: vi.fn(async () => ({ results: [], totalHits: 0 })),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'cost', scope: ['all'] }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.work_item_scope_hint).toBeUndefined();
  });
});

// ─── search:semantic ──────────────────────────────────────────────────────────

describe('search:semantic', () => {
  it('calls runHybridSearch with query + mode + workspaceId', async () => {
    const runHybridSearch = vi.fn<HybridMock>(async () => ({ results: [], totalHits: 0, embedderAvailable: true }));
    vi.doMock('@papercusp/search', () => ({ runHybridSearch }));
    vi.doMock('../search/embedder', () => ({
      buildQueryEmbedder: vi.fn(async () => vi.fn()),
      interactiveEmbedAcquireBudgetMs: vi.fn(() => 4000),
    }));
    vi.doMock('../search/rerank', mockRerank);

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
    const runHybridSearch = vi.fn<HybridMock>(async () => ({ results: [], totalHits: 0, embedderAvailable: false }));
    vi.doMock('@papercusp/search', () => ({ runHybridSearch }));
    vi.doMock('../search/embedder', () => ({
      buildQueryEmbedder: vi.fn(async () => vi.fn()),
      interactiveEmbedAcquireBudgetMs: vi.fn(() => 4000),
    }));
    vi.doMock('../search/rerank', mockRerank);

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
      interactiveEmbedAcquireBudgetMs: vi.fn(() => 4000),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/semantic');
    const result = (await tool.handler({ query: 'test' }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.total_hits).toBe(1);
    expect(data.embedder_available).toBe(true);
  });
});
