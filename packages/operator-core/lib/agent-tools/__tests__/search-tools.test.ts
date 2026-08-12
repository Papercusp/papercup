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
// Safe as a TOP-LEVEL import here (unlike the sibling prose-handlers/
// overfetch-slice tests): this file uses `vi.doMock`, which is NOT hoisted, so
// importing the real module at file scope cannot run a factory early.
// `emptyLegs` is pure, so the real one is the right one regardless of mocking.
import { emptyLegs } from '@papercusp/search';

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
    // Both prose tools call rerankPageHead (not rerankProseHits) since their cap
    // rose to 50 — above RERANK_MAX_CANDIDATES. Stub it too: the real one calls
    // the module-internal rerankProseHits, so overriding only that leaves the
    // live cross-encoder path running inside these unit tests.
    rerankPageHead: async (_: unknown, r: unknown[], limit: number) => r.slice(0, limit),
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
) => Promise<{
  results: unknown[];
  totalHits: number;
  embedderAvailable?: boolean;
  // P-020: REQUIRED, mirroring the engine — a stub allowed to omit the leg
  // report would let this suite go green against a shape the engine never
  // returns, which is how a mock starts certifying a contract it has drifted
  // from.
  legs: ReturnType<typeof emptyLegs>;
}>;

describe('search:fulltext', () => {
  it('documents the default and maximum limit in the public schema', async () => {
    const { default: tool } = await import('../search/fulltext');
    const limit = (tool.args as any).shape.limit;
    expect(limit.description).toContain('default 5');
    expect(limit.description).toContain('maximum 50');
  });

  // EI-20275475712246963: the cap was 20 and callers legitimately wanting a
  // bigger page got `invalid_args`. It was filed FOUR times; the first "fix"
  // only documented the ceiling in the describe string, which cannot stop a
  // caller from asking for 40. Pin the accept/reject boundary itself.
  it('accepts a limit above the old cap of 20, and still rejects one past 50', async () => {
    const { default: tool } = await import('../search/fulltext');
    const limit = (tool.args as any).shape.limit;
    expect(limit.safeParse(40).success).toBe(true);
    expect(limit.safeParse(50).success).toBe(true);
    expect(limit.safeParse(51).success).toBe(false);
    expect(limit.safeParse(0).success).toBe(false);
  });

  // The cap above 24 is only affordable because Stage B is routed through
  // rerankPageHead, which honours RERANK_MAX_CANDIDATES as a CANDIDATE budget.
  // Calling rerankProseHits here instead would score the whole 50-row page at a
  // MEASURED ~45ms/pair and blow PROSE_RERANK_TIMEOUT_MS into a full degrade —
  // so the routing, not just the number, is what makes the raised cap correct.
  it('routes Stage B through rerankPageHead so scored pairs stay capped at a big limit', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({ ...MOCK_HIT, source_id: `hit_${i}` }));
    const rerankPageHead = vi.fn(async (_q: unknown, r: unknown[], limit: number) => r.slice(0, limit));
    const rerankProseHits = vi.fn(async (_q: unknown, r: unknown[]) => r);
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runFullTextSearch: vi.fn(async () => ({ results: rows, totalHits: rows.length })),
    }));
    vi.doMock('../search/rerank', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../search/rerank')>()),
      rerankProseHits,
      rerankPageHead,
    }));

    const { default: tool } = await import('../search/fulltext');
    const res: any = await tool.handler({ query: 'authentication', limit: 50 }, MAKE_CTX());

    expect(rerankPageHead).toHaveBeenCalledTimes(1);
    expect(rerankProseHits).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text).results).toHaveLength(50);
  });

  it('calls runFullTextSearch with query + workspaceId + the over-fetched (rerankCandidateCount) limit', async () => {
    const runFullTextSearch = vi.fn<FullTextMock>(async () => ({ results: [MOCK_HIT], totalHits: 1 }));
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runFullTextSearch,
    }));
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
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
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
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runFullTextSearch,
    }));
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
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runFullTextSearch,
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    await tool.handler({ query: 'cost', scope: ['escalations'] }, MAKE_CTX());

    const [sources] = runFullTextSearch.mock.calls[0];
    expect(sources.every((s: { name: string }) => s.name === 'escalations')).toBe(true);
  });

  it('passes harness_slug as scopeFilter', async () => {
    const runFullTextSearch = vi.fn<FullTextMock>(async () => ({ results: [], totalHits: 0 }));
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runFullTextSearch,
    }));
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
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runFullTextSearch: vi.fn(async () => ({ results: [], totalHits: 0 })),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'claimHold by-id bypass' }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.work_item_scope_hint).toMatch(/work_item/);
  });

  it('surfaces work_item_scope_hint when an explicit scope omits work_item', async () => {
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runFullTextSearch: vi.fn(async () => ({ results: [], totalHits: 0 })),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'cost', scope: ['escalations'] }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.work_item_scope_hint).toBeDefined();
  });

  it('omits work_item_scope_hint once scope:["work_item"] is included', async () => {
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runFullTextSearch: vi.fn(async () => ({ results: [], totalHits: 0 })),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/fulltext');
    const result = (await tool.handler({ query: 'claimHold by-id bypass', scope: ['work_item'] }, MAKE_CTX())) as any;
    const data = JSON.parse(result.content[0].text);
    expect(data.work_item_scope_hint).toBeUndefined();
  });

  it('omits work_item_scope_hint under scope:["all"] (work_item is included)', async () => {
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
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
  // Fixed with fulltext as ONE condition (EI-20275475712246963): the sibling
  // prose tool carried a byte-identical `.max(20)` on the same Stage B seam, so
  // raising only one would have left the other filing the same bug.
  it('accepts a limit above the old cap of 20, and still rejects one past 50', async () => {
    const { default: tool } = await import('../search/semantic');
    const limit = (tool.args as any).shape.limit;
    expect(limit.safeParse(40).success).toBe(true);
    expect(limit.safeParse(50).success).toBe(true);
    expect(limit.safeParse(51).success).toBe(false);
  });

  it('calls runHybridSearch with query + mode + workspaceId', async () => {
    const runHybridSearch = vi.fn<HybridMock>(async () => ({ results: [], totalHits: 0, embedderAvailable: true, legs: emptyLegs() }));
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runHybridSearch,
    }));
    vi.doMock('../search/embedder', async (importOriginal) => ({
      // importOriginal keeps the rest of the module real — notably
      // `embedderModeOf`, which the P-017 floor policy calls. A wholesale stub
      // would leave it undefined; the policy's try/catch would swallow the
      // throw and still yield "no floor", so these tests would pass for the
      // WRONG reason and stop being evidence about the floor at all.
      ...(await importOriginal<typeof import('../search/embedder')>()),
      buildQueryEmbedder: vi.fn(async () => vi.fn()),
      // P-001/P-017: semantic.ts acquires the RESOLVED embedder; the engine now
      // derives the floor from that embedder INSTANCE. 'test' is deliberately
      // an UNMEASURED mode, and the stub embedder was never registered by the
      // real factory, so no floor applies and these wiring assertions stay
      // independent of the floor's value.
      buildQueryEmbedderResolved: vi.fn(async () => ({ mode: 'test', dims: 768, embed: vi.fn() })),
      interactiveEmbedAcquireBudgetMs: vi.fn(() => 4000),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/semantic');
    await tool.handler({ query: 'auth strategy', mode: 'hybrid', limit: 4 }, MAKE_CTX());

    expect(runHybridSearch).toHaveBeenCalledTimes(1);
    const [, opts] = runHybridSearch.mock.calls[0];
    expect(opts.query).toBe('auth strategy');
    expect(opts.mode).toBe('hybrid');
    // rerankCandidateCount(4) = max(4, min(4*RERANK_OVERFETCH, RERANK_MAX_CANDIDATES)) = 16.
    expect(opts.limit).toBe(16);
    expect(opts.workspaceId).toBe('ws_test');
  });

  it('defaults to hybrid mode', async () => {
    const runHybridSearch = vi.fn<HybridMock>(async () => ({ results: [], totalHits: 0, embedderAvailable: false, legs: emptyLegs() }));
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runHybridSearch,
    }));
    vi.doMock('../search/embedder', async (importOriginal) => ({
      // importOriginal keeps the rest of the module real — notably
      // `embedderModeOf`, which the P-017 floor policy calls. A wholesale stub
      // would leave it undefined; the policy's try/catch would swallow the
      // throw and still yield "no floor", so these tests would pass for the
      // WRONG reason and stop being evidence about the floor at all.
      ...(await importOriginal<typeof import('../search/embedder')>()),
      buildQueryEmbedder: vi.fn(async () => vi.fn()),
      // P-001/P-017: semantic.ts acquires the RESOLVED embedder; the engine now
      // derives the floor from that embedder INSTANCE. 'test' is deliberately
      // an UNMEASURED mode, and the stub embedder was never registered by the
      // real factory, so no floor applies and these wiring assertions stay
      // independent of the floor's value.
      buildQueryEmbedderResolved: vi.fn(async () => ({ mode: 'test', dims: 768, embed: vi.fn() })),
      interactiveEmbedAcquireBudgetMs: vi.fn(() => 4000),
    }));
    vi.doMock('../search/rerank', mockRerank);

    const { default: tool } = await import('../search/semantic');
    await tool.handler({ query: 'test' }, MAKE_CTX());

    const [, opts] = runHybridSearch.mock.calls[0];
    expect(opts.mode).toBe('hybrid');
  });

  it('returns results and embedderAvailable flag', async () => {
    vi.doMock('@papercusp/search', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@papercusp/search')>()),
      runHybridSearch: vi.fn(async () => ({ results: [MOCK_HIT], totalHits: 1, embedderAvailable: true, legs: emptyLegs() })),
    }));
    vi.doMock('../search/embedder', async (importOriginal) => ({
      // importOriginal keeps the rest of the module real — notably
      // `embedderModeOf`, which the P-017 floor policy calls. A wholesale stub
      // would leave it undefined; the policy's try/catch would swallow the
      // throw and still yield "no floor", so these tests would pass for the
      // WRONG reason and stop being evidence about the floor at all.
      ...(await importOriginal<typeof import('../search/embedder')>()),
      buildQueryEmbedder: vi.fn(async () => vi.fn()),
      // P-001/P-017: semantic.ts acquires the RESOLVED embedder; the engine now
      // derives the floor from that embedder INSTANCE. 'test' is deliberately
      // an UNMEASURED mode, and the stub embedder was never registered by the
      // real factory, so no floor applies and these wiring assertions stay
      // independent of the floor's value.
      buildQueryEmbedderResolved: vi.fn(async () => ({ mode: 'test', dims: 768, embed: vi.fn() })),
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
