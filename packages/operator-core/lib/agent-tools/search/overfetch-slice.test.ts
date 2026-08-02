/**
 * The over-fetch → rerank → slice invariant, across all three call sites.
 *
 * Stage B only pays for itself if retrieval hands the reranker a POOL that is
 * bigger than the page (`rerankCandidateCount(limit)`, not `limit`) and the
 * caller-visible page is then sliced back to exactly `limit`. Those two halves
 * live in different layers and are individually tested, but nothing asserted
 * them TOGETHER — and each half is silently wrong in a different, user-visible
 * way:
 *
 *   - forget to over-fetch → the reranker can only shuffle a page retrieval
 *     already chose; it can never pull a buried hit INTO it, which is the whole
 *     reason Stage B exists (P-002);
 *   - forget to slice back (e.g. return the engine's `results` instead of
 *     `reranked`) → a `limit: 5` search quietly returns 20 rows, and a
 *     `limit: 20` one returns the RERANK_MAX_CANDIDATES pool of 24.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM prose-handlers.test.ts: that file mocks
 * `rerankProseHits` to an identity-passthrough so it can assert field mapping on
 * a stable list. That is the right call there, but it means the slice it checks
 * is the MOCK's slice — the real chain (operator `rerankProseHits` →
 * `@papercusp/search-core`'s `rankWithReranker` → `@papercusp/rerank`) is never
 * exercised end-to-end. Here ONLY the leaves are mocked (the SQL engine, the
 * embedder, the credential read, the flag backend, and the cross-encoder
 * SCORER); search-core and the rerank lib run for real, so the page size is the
 * one those layers actually produce.
 *
 * The invariant is asserted on BOTH outcomes, because they take different code
 * paths to the same guarantee: a healthy rerank slices inside search-core
 * (`ordered.slice(0, opts.limit)`), while a degraded one slices in
 * `rerankProseHits`'s own fail-safe passthrough. A regression in either is a
 * page-size bug users see directly.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SearchHit } from '@papercusp/search';

// --- Engine (SQL/BM25/pgvector) mock: records the retrieval size it was asked
// for, returns a scripted pool. This is the ONLY thing standing in for Stage A.
interface EngineCall {
  ctx: Record<string, unknown>;
}
const ftCalls: EngineCall[] = [];
const hybridCalls: EngineCall[] = [];
let pool: SearchHit[] = [];

const runFullTextSearch = vi.fn(async (_sources: unknown, ctx: Record<string, unknown>) => {
  ftCalls.push({ ctx });
  return { results: pool, totalHits: pool.length };
});
const runHybridSearch = vi.fn(async (_sources: unknown, ctx: Record<string, unknown>) => {
  hybridCalls.push({ ctx });
  return { results: pool, totalHits: pool.length, embedderAvailable: true };
});
vi.mock('@papercusp/search', () => ({ runFullTextSearch, runHybridSearch }));

vi.mock('./sources', () => ({
  SEARCH_SOURCES: [
    { name: 'escalations' },
    { name: 'brainstorm' },
    { name: 'turns' },
    { name: 'decisions' },
  ],
}));

vi.mock('./embedder', () => ({
  buildQueryEmbedder: vi.fn(async () => null as unknown),
  interactiveEmbedAcquireBudgetMs: vi.fn(() => 4000),
}));

// No stored/env key → the LOCAL engine, which is the default and the only path
// a desktop install takes.
vi.mock('../../credentials', () => ({ readCredentials: vi.fn(async () => ({})) }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn(async () => true) }));

// The cross-encoder itself is the leaf we script. Everything between this and
// the handler — search-core's bucket/sort/window/slice and the rerank lib's
// fail-safe seam — runs for real.
const scorer = vi.fn(async (_q: string, texts: string[]) => texts.map(() => 0));
vi.mock('../../memory/embed-sidecar-wiring', () => ({
  buildSidecarAwareReranker: vi.fn(async () => scorer),
}));

// --- Route-level deps (the third call site is an HTTP route). -----------------
vi.mock('../../auth', () => ({
  getSessionUser: vi.fn(async () => null),
  getSessionUserOrDefault: vi.fn(async () => ({
    id: 'default-user', username: 'default', display_name: 'User', has_password: false,
  })),
}));
vi.mock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));
// The memories half of /user/search is irrelevant here — report unavailable so
// the route returns `memories: []` and we assert purely on the prose leg.
vi.mock('../../memory/backend', () => ({
  getMemoryBackend: vi.fn(() => ({ available: vi.fn(async () => ({ ok: false })) })),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: vi.fn(async () => []) }),
}));
vi.mock('../../endpoint-route/telemetry', () => ({ recordRouteInvocation: vi.fn() }));

import { Hono } from 'hono';
import {
  RERANK_MAX_CANDIDATES,
  _resetLocalRerankScorerForTests,
  rerankCandidateCount,
} from './rerank';

/** RRF-ordered hit: `h00` is the top retrieval result, `h19` the most buried. */
const hit = (i: number): SearchHit => {
  const id = `h${String(i).padStart(2, '0')}`;
  return {
    source: 'escalations',
    source_id: id,
    excerpt: `body-${id}`,
    highlight: `<mark>body-${id}</mark>`,
    // Descending, so retrieval order is unambiguous and doubles as the
    // `qualityScore` tiebreak the handler passes.
    score: 1 - i / 100,
    rankers: ['bm25'],
  };
};
const poolOf = (n: number) => Array.from({ length: n }, (_, i) => hit(i));

/** Score every candidate 0 except `winnerId`, which scores 1. */
function scorerFavoring(winnerId: string) {
  return vi.fn(async (_q: string, texts: string[]) =>
    texts.map((t) => (t.includes(winnerId) ? 1 : 0)),
  );
}

const CTX = () => ({ tx: (() => {}) as never, workspaceId: 'ws_1', log: vi.fn() });
const idsOf = (res: { content: Array<{ text: string }> }) =>
  JSON.parse(res.content[0].text).results.map((r: { source_id: string }) => r.source_id);

beforeEach(() => {
  vi.clearAllMocks();
  _resetLocalRerankScorerForTests();
  ftCalls.length = 0;
  hybridCalls.length = 0;
  pool = poolOf(20);
  scorer.mockImplementation(async (_q: string, texts: string[]) => texts.map(() => 0));
});

// =============================================================================
// The invariant, at each call site
// =============================================================================
describe('search:fulltext — over-fetches a pool, returns exactly `limit`', () => {
  it('retrieves rerankCandidateCount(5)=20 but the page is 5 (rerank healthy)', async () => {
    // Favor a buried hit so the assertion below can only pass on a HEALTHY
    // rerank: a bare length check would also pass on the degraded passthrough
    // (which returns `limit` rows too), making "healthy" untestable.
    scorer.mockImplementation(scorerFavoring('h18'));
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'q', limit: 5 } as never, CTX() as never);

    expect(ftCalls[0].ctx.limit).toBe(rerankCandidateCount(5));
    expect(ftCalls[0].ctx.limit).toBe(20);
    const ids = idsOf(res as never);
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe('h18'); // proves the rerank actually ran
  });

  it('still returns exactly 5 when the reranker is DOWN — the pool never leaks', async () => {
    // The degraded path slices in rerankProseHits' own passthrough, not in
    // search-core, so it is a genuinely different route to the same guarantee.
    scorer.mockRejectedValue(new Error('sidecar down'));
    const tool = (await import('./fulltext')).default;
    const res = await tool.handler({ query: 'q', limit: 5 } as never, CTX() as never);

    expect(ftCalls[0].ctx.limit).toBe(20);
    // Exactly the page, in retrieval order — not the 20-row pool.
    expect(idsOf(res as never)).toEqual(['h00', 'h01', 'h02', 'h03', 'h04']);
  });
});

describe('search:semantic — over-fetches a pool, returns exactly `limit`', () => {
  it('retrieves 20 but the page is 5 (rerank healthy)', async () => {
    scorer.mockImplementation(scorerFavoring('h18'));
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'q', limit: 5 } as never, CTX() as never);

    expect(hybridCalls[0].ctx.limit).toBe(20);
    const ids = idsOf(res as never);
    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe('h18'); // proves the rerank actually ran
  });

  it('still returns exactly 5 when the reranker is DOWN', async () => {
    scorer.mockRejectedValue(new Error('sidecar down'));
    const tool = (await import('./semantic')).default;
    const res = await tool.handler({ query: 'q', limit: 5 } as never, CTX() as never);

    expect(idsOf(res as never)).toEqual(['h00', 'h01', 'h02', 'h03', 'h04']);
  });
});

describe('/api/user/search — the site where the candidate CAP binds', () => {
  async function callRoute(qs: string) {
    const [{ registerRoute }, route] = await Promise.all([
      import('../../endpoint-route/define-route'),
      import('../../endpoint-route/routes/user/search'),
    ]);
    const app = new Hono();
    registerRoute(app, route.default as never);
    const res = await app.request(`/user/search${qs}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { prose: Array<{ source_id: string }> };
  }

  it('limit 20 retrieves the CAP (24), not 20 and not 4×20 — and returns 20', async () => {
    // This route's limit reaches 20, so RERANK_MAX_CANDIDATES (not the 4×
    // multiplier) is what bounds retrieval here — the one call site where the
    // difference is observable.
    pool = poolOf(RERANK_MAX_CANDIDATES);
    // h22 sits beyond the 20-row page, so it can only reach it via the 4 extra
    // candidates the cap still allows — and its presence proves the rerank ran.
    scorer.mockImplementation(scorerFavoring('h22'));
    const body = await callRoute('?q=hello&limit=20');

    expect(ftCalls[0].ctx.limit).toBe(RERANK_MAX_CANDIDATES);
    expect(ftCalls[0].ctx.limit).toBe(24);
    expect(ftCalls[0].ctx.limit).toBeLessThan(20 * 4);
    expect(body.prose).toHaveLength(20);
    expect(body.prose[0].source_id).toBe('h22');
  });

  it('returns exactly `limit` when the reranker is DOWN', async () => {
    pool = poolOf(RERANK_MAX_CANDIDATES);
    scorer.mockRejectedValue(new Error('sidecar down'));
    const body = await callRoute('?q=hello&limit=20');

    expect(body.prose).toHaveLength(20);
    expect(body.prose[0].source_id).toBe('h00');
  });
});

// =============================================================================
// What the over-fetch is FOR
// =============================================================================
describe('the over-fetch pays for itself', () => {
  it('pulls a hit buried BEYOND the page into it — impossible without over-fetching', async () => {
    // h18 is 18th in retrieval order: far outside a limit-5 page. Reranking an
    // already-sliced page could never surface it; reranking the over-fetched
    // pool must. This is the entire justification for RERANK_OVERFETCH.
    scorer.mockImplementation(scorerFavoring('h18'));

    const tool = (await import('./fulltext')).default;
    const ids = idsOf((await tool.handler({ query: 'q', limit: 5 } as never, CTX() as never)) as never);

    expect(ids).toHaveLength(5);
    expect(ids[0]).toBe('h18');
    // The rest keep retrieval order behind the winner (equal rerank scores are
    // bucketed, then broken by the RRF qualityScore the handler passes).
    expect(ids.slice(1)).toEqual(['h00', 'h01', 'h02', 'h03']);
  });

  it('the scored pool is the WHOLE over-fetch, not just the page', async () => {
    const tool = (await import('./fulltext')).default;
    await tool.handler({ query: 'q', limit: 5 } as never, CTX() as never);

    // If the reranker only ever saw `limit` texts, a buried hit could not win.
    expect(scorer).toHaveBeenCalledTimes(1);
    expect(scorer.mock.calls[0][1]).toHaveLength(20);
  });
});
