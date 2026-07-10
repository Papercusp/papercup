/**
 * search:fulltext / search:semantic — PURE handler-level tests for the
 * post-query shaping logic the two `defineTool` projections own.
 *
 * The heavy lifting (BM25 / pgvector / RRF) lives in `@papercusp/search`
 * (`runFullTextSearch` / `runHybridSearch`) and is unit-tested there. The
 * cross-encoder rerank is `./rerank` (tested in rerank.test.ts) and the
 * embedder cascade is `./embedder`. All three are mocked here so we isolate
 * exactly the handler-only logic:
 *
 *   - scope normalization: empty/absent → the 4 historic default sources
 *     (escalations/brainstorm/turns/decisions, unchanged so existing unscoped
 *     callers see no behavior change); explicit `all` → every registered
 *     source (EI-6984 + session-search-scope-2026-07-05, 7 today); an
 *     explicit subset passes through verbatim;
 *   - `SEARCH_SOURCES.filter(scope.includes(name))` → which sources reach
 *     the engine;
 *   - limit defaulting (5) + workspaceId fallback ('' when ctx.workspaceId
 *     is unset);
 *   - fulltext output projection: `rank: r.score`, `harness_slug` only when
 *     `scope` is present, `query`/`scope`/`total_hits` echo;
 *   - semantic output projection: `mode` default 'hybrid', `embedder_available`
 *     passthrough, the generic `scope` → domain `harness_slug` remap;
 *   - embedding-call failure / no key → graceful fallback: the engine reports
 *     `embedderAvailable: false` and the handler surfaces it, no throw.
 *
 * Each engine mock records the `sources` + ctx it was handed so we can assert
 * the scope→sources translation without a real PG handle.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- Engine mock: records inputs, returns scripted hits. ---------------------
interface EngineCall {
  sourceNames: string[];
  ctx: Record<string, unknown>;
}
const ftCalls: EngineCall[] = [];
const hybridCalls: EngineCall[] = [];

let ftResult = { results: [] as unknown[], totalHits: 0 };
let hybridResult = { results: [] as unknown[], totalHits: 0, embedderAvailable: true };

const runFullTextSearch = vi.fn(async (sources: Array<{ name: string }>, ctx: Record<string, unknown>) => {
  ftCalls.push({ sourceNames: sources.map((s) => s.name), ctx });
  return ftResult;
});
const runHybridSearch = vi.fn(async (sources: Array<{ name: string }>, ctx: Record<string, unknown>) => {
  hybridCalls.push({ sourceNames: sources.map((s) => s.name), ctx });
  return hybridResult;
});

vi.mock('@papercusp/search', () => ({ runFullTextSearch, runHybridSearch }));

// SEARCH_SOURCES: minimal stand-ins mirroring the real registry's 7 names
// (session-search-scope-2026-07-05 added session_turn + coord_message) so the
// handler's `.filter(scope.includes(name))` and its `'all'` expansion
// (SEARCH_SOURCES.map(s => s.name)) see the registry-shaped set.
vi.mock('./sources', () => ({
  SEARCH_SOURCES: [
    { name: 'escalations' },
    { name: 'brainstorm' },
    { name: 'turns' },
    { name: 'decisions' },
    { name: 'work_item' },
    { name: 'session_turn' },
    { name: 'coord_message' },
  ],
}));

// rerank is identity-passthrough (sliced) — its own fail-safe behavior is
// covered in rerank.test.ts; here it must not reorder/drop so we can assert
// the handler's field mapping on a stable list.
vi.mock('./rerank', () => ({
  rerankProseHits: vi.fn(async (_q: string, hits: unknown[], limit: number) => hits.slice(0, limit)),
}));

// embedder: scripted per-test (null = no embedder available).
const buildQueryEmbedder = vi.fn(async () => null as unknown);
// interactiveEmbedAcquireBudgetMs: semantic.ts calls this to compute the
// acquisition budget it passes to buildQueryEmbedder / embedTimeoutMs (EI-9334)
// — a fixed stand-in is fine here since the handler-level tests never assert
// on the budget value itself, only on buildQueryEmbedder's scripted return.
const interactiveEmbedAcquireBudgetMs = vi.fn(() => 4000);
vi.mock('./embedder', () => ({ buildQueryEmbedder, interactiveEmbedAcquireBudgetMs }));

const CTX = (over: Record<string, unknown> = {}) => ({
  tx: (() => {}) as never,
  workspaceId: 'ws_1',
  log: vi.fn(),
  ...over,
});

function payloadOf(res: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(res.content[0].text);
}

beforeEach(() => {
  ftCalls.length = 0;
  hybridCalls.length = 0;
  runFullTextSearch.mockClear();
  runHybridSearch.mockClear();
  buildQueryEmbedder.mockClear();
  ftResult = { results: [], totalHits: 0 };
  hybridResult = { results: [], totalHits: 0, embedderAvailable: true };
});

// =============================================================================
// search:fulltext
// =============================================================================
describe('search:fulltext — scope normalization', () => {
  it('no scope → the 4 default sources, in canonical order', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'pricing decision' } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
    expect(ftCalls[0].sourceNames).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
  });

  // EI-6984: 'work_item' (and the session/coord corpora,
  // session-search-scope-2026-07-05) are opt-in-only for the OMITTED-scope
  // default (a bare search:fulltext call keeps returning exactly the historic
  // 4 sources so existing unscoped callers see no behavior change) but an
  // EXPLICIT scope:['all'] means "every source", so it expands to all 7.
  it('scope:["all"] expands to every registered source (the 4 historic defaults + work_item + session_turn + coord_message)', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['all'] } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual([
      'escalations', 'brainstorm', 'turns', 'decisions', 'work_item', 'session_turn', 'coord_message',
    ]);
  });

  it('an explicit subset is passed through and limits the sources reaching the engine', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['brainstorm', 'decisions'] } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual(['brainstorm', 'decisions']);
    expect(ftCalls[0].sourceNames).toEqual(['brainstorm', 'decisions']);
  });

  // EI-6984: the actual bug this closes — scope:['work_item'] used to be silently
  // dropped (not a recognized enum value at all), so a dedup-before-filing check
  // always reused the same 4-source scope with no error and no work_item results.
  it('scope:["work_item"] is accepted and echoed (the EI-6984 fix) — not silently dropped', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['work_item'] } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual(['work_item']);
  });

  // GAP 12 — scope edge: `!args.scope?.length` (an empty array, distinct from
  // absent/`['all']`) is the third path through the normalization at
  // fulltext.ts:53-56. It must expand to the same 4 defaults, not collapse to
  // "no sources".
  it('scope:[] (empty array) → the 4 defaults reach the engine (not zero sources)', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: [] } as never, CTX() as never);
    expect(payloadOf(res as never).scope).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
    expect(ftCalls[0].sourceNames).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
  });

  // GAP 12 — a scope naming only sources that don't exist in SEARCH_SOURCES →
  // `.filter(scope.includes)` yields zero sources. The engine is still called
  // (with []), returns no hits, and the handler returns results:[] without
  // throwing. (`['all']` is special-cased to the defaults, so the test uses a
  // non-'all' unknown scope value the enum-bypassing `as never` cast allows.)
  it('a scope matching no source → zero sources → results:[], no throw', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x', scope: ['nonexistent-source'] } as never, CTX() as never);
    expect(ftCalls[0].sourceNames).toEqual([]); // nothing reaches the engine
    const p = payloadOf(res as never);
    expect(p.results).toEqual([]);
    expect(p.total_hits).toBe(0);
    expect(p.scope).toEqual(['nonexistent-source']);
  });
});

describe('search:fulltext — limit + workspaceId defaulting', () => {
  it('defaults limit to 5 when omitted', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'x' } as never, CTX() as never);
    expect(ftCalls[0].ctx.limit).toBe(5);
  });

  it('passes the explicit limit through', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'x', limit: 12 } as never, CTX() as never);
    expect(ftCalls[0].ctx.limit).toBe(12);
  });

  it('falls back to empty-string workspaceId when ctx.workspaceId is unset', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'x' } as never, CTX({ workspaceId: undefined }) as never);
    expect(ftCalls[0].ctx.workspaceId).toBe('');
  });

  it('forwards harness_slug as the engine scopeFilter (null when absent)', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'x' } as never, CTX() as never);
    expect(ftCalls[0].ctx.scopeFilter).toBeNull();
    await tool.handler({ query: 'x', harness_slug: 'sheets' } as never, CTX() as never);
    expect(ftCalls[1].ctx.scopeFilter).toBe('sheets');
  });
});

describe('search:fulltext — output projection', () => {
  it('renames hit.score → rank and includes harness_slug only when scope present', async () => {
    ftResult = {
      results: [
        { source: 'escalations', source_id: 'e1', scope: 'sheets', excerpt: 'ex1', highlight: 'h1', score: 0.9 },
        { source: 'turns', source_id: 't1', excerpt: 'ex2', highlight: 'h2', score: 0.4 },
      ],
      totalHits: 2,
    };
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    const p = payloadOf(res as never);
    expect(p.total_hits).toBe(2);
    expect(p.results[0]).toEqual({
      source: 'escalations',
      source_id: 'e1',
      harness_slug: 'sheets',
      excerpt: 'ex1',
      highlight: 'h1',
      rank: 0.9,
    });
    // No scope on the second hit → no harness_slug key (not null).
    expect(p.results[1]).not.toHaveProperty('harness_slug');
    expect(p.results[1].rank).toBe(0.4);
    // `score` field is renamed away — the agent surface uses `rank`.
    expect(JSON.stringify(p.results)).not.toContain('"score"');
  });

  it('echoes the query verbatim in the payload', async () => {
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'the pricing discussion' } as never, CTX() as never);
    expect(payloadOf(res as never).query).toBe('the pricing discussion');
  });
});

// =============================================================================
// search:semantic
// =============================================================================
describe('search:semantic — mode + scope defaulting', () => {
  it('defaults mode to "hybrid"', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'auth strategy' } as never, CTX() as never);
    expect(payloadOf(res as never).mode).toBe('hybrid');
    expect(hybridCalls[0].ctx.mode).toBe('hybrid');
  });

  it('honors an explicit mode="embeddings"', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x', mode: 'embeddings' } as never, CTX() as never);
    expect(payloadOf(res as never).mode).toBe('embeddings');
    expect(hybridCalls[0].ctx.mode).toBe('embeddings');
  });

  it('no scope → 4 default sources reach the engine', async () => {
    const tool = (await import('./semantic')).default;
    await tool.handler({ query: 'x' } as never, CTX() as never);
    expect(hybridCalls[0].sourceNames).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
  });

  // GAP 12 — semantic.ts shares the same `scope?.includes('all') || !scope?.length`
  // normalization (semantic.ts:59-62). Empty array → the 4 defaults.
  it('scope:[] (empty array) → the 4 defaults reach the engine', async () => {
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x', scope: [] } as never, CTX() as never);
    expect(hybridCalls[0].sourceNames).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
    expect(payloadOf(res as never).scope).toEqual(['escalations', 'brainstorm', 'turns', 'decisions']);
  });

  // GAP 12 — a scope matching no source → zero sources → results:[], no throw.
  it('a scope matching no source → zero sources → results:[], no throw', async () => {
    buildQueryEmbedder.mockResolvedValueOnce(null);
    hybridResult = { results: [], totalHits: 0, embedderAvailable: false };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x', scope: ['nope'] } as never, CTX() as never);
    expect(hybridCalls[0].sourceNames).toEqual([]);
    const p = payloadOf(res as never);
    expect(p.results).toEqual([]);
    expect(p.total_hits).toBe(0);
  });
});

describe('search:semantic — embedder availability', () => {
  it('passes the built embedder to the engine and surfaces embedder_available:true', async () => {
    const fakeEmbedder = vi.fn(async () => [0.1, 0.2]);
    buildQueryEmbedder.mockResolvedValueOnce(fakeEmbedder);
    hybridResult = { results: [], totalHits: 0, embedderAvailable: true };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    expect(buildQueryEmbedder).toHaveBeenCalledTimes(1);
    expect(hybridCalls[0].ctx.embedder).toBe(fakeEmbedder);
    expect(payloadOf(res as never).embedder_available).toBe(true);
  });

  it('no embedder (null) → graceful fallback, embedder_available:false, no throw', async () => {
    buildQueryEmbedder.mockResolvedValueOnce(null);
    hybridResult = { results: [], totalHits: 0, embedderAvailable: false };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    expect(hybridCalls[0].ctx.embedder).toBeNull();
    expect(payloadOf(res as never).embedder_available).toBe(false);
  });

  it('embedder builder throwing is NOT caught by the handler (builder is the fail-safe boundary)', async () => {
    // buildQueryEmbedder owns the try/catch internally and returns null on
    // failure; if it rejected, the handler would propagate. Pin that contract
    // so a future refactor that moves the boundary is caught.
    buildQueryEmbedder.mockRejectedValueOnce(new Error('embedder boom'));
    const tool = (await import('./semantic')).default;
    await expect(
      tool.handler({ query: 'x' } as never, CTX() as never),
    ).rejects.toThrow('embedder boom');
  });
});

describe('search:semantic — output projection (scope → harness_slug remap)', () => {
  it('remaps the generic engine `scope` field to domain `harness_slug`', async () => {
    hybridResult = {
      results: [
        { source: 'escalations', source_id: 'e1', scope: 'sheets', excerpt: 'ex', highlight: 'h', score: 0.7, rankers: ['bm25'] },
        { source: 'turns', source_id: 't1', excerpt: 'ex2', highlight: 'h2', score: 0.3, rankers: ['vec'] },
      ],
      totalHits: 2,
      embedderAvailable: true,
    };
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'x' } as never, CTX() as never);
    const p = payloadOf(res as never);
    // Hit WITH scope: `scope` removed, `harness_slug` added; `score` kept (semantic keeps score).
    expect(p.results[0].harness_slug).toBe('sheets');
    expect(p.results[0]).not.toHaveProperty('scope');
    expect(p.results[0].score).toBe(0.7);
    // Hit WITHOUT scope: untouched, no harness_slug key.
    expect(p.results[1]).not.toHaveProperty('harness_slug');
    expect(p.results[1]).not.toHaveProperty('scope');
    expect(p.total_hits).toBe(2);
  });
});
