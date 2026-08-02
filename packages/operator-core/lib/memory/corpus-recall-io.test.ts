/**
 * Live-leg tests for the P-008 second retrieval corpus (D-037).
 *
 * The search engine, the embedder, PG and the flag store are all mocked — what
 * is under test here is the CONTRACT this leg hands the engine (which sources,
 * which scopeFilter, which budgets) and its degradation behaviour, not the
 * engine's own retrieval.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runHybridSearch = vi.fn();
const buildQueryEmbedder = vi.fn(async () => (async () => [0.1, 0.2]) as unknown);
const getFlag = vi.fn(async () => true);

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: {} }) }));
vi.mock('@papercusp/search', () => ({ runHybridSearch }));
vi.mock('../agent-tools/search/sources', () => ({
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
vi.mock('../agent-tools/search/embedder', () => ({ buildQueryEmbedder }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { MEMORY_CORPUS_RECALL: 'papercusp-memory-corpus-recall' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag }));

const { recallCorpusContext } = await import('./corpus-recall-io');

const hit = (over: Record<string, unknown> = {}) => ({
  source: 'work_item',
  source_id: 'WI-6512',
  scope: 'harness:papercusp',
  excerpt: '[bug/open/major] http2 transport regression on the sse endpoint',
  highlight: '',
  score: 0.032,
  ts: null,
  rankers: ['bm25'],
  ...over,
});

const ok = (results: unknown[] = [hit()]) => ({
  results,
  totalHits: results.length,
  embedderAvailable: true,
});

const QUERY = 'why did the http2 transport change on the sse endpoint';
const base = { queryText: QUERY, workspaceId: 'ws-1' };

beforeEach(() => {
  vi.clearAllMocks();
  getFlag.mockResolvedValue(true);
  buildQueryEmbedder.mockResolvedValue((async () => [0.1, 0.2]) as unknown);
  delete process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS;
});

describe('recallCorpusContext — the contract handed to the search engine', () => {
  it('reads ONLY the session_turn + work_item sources', async () => {
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext(base);
    const [sources] = runHybridSearch.mock.calls[0];
    expect((sources as Array<{ name: string }>).map((s) => s.name).sort()).toEqual([
      'session_turn',
      'work_item',
    ]);
  });

  it('passes scopeFilter: null — the regression that would silently empty this leg', async () => {
    // 396,798 of 396,826 session turns carry harness_slug IS NULL, so a
    // harness-scoped SQL filter leaves the turn leg able to match at most 28
    // rows: structurally empty while every surface reports healthy. Harness
    // narrowing belongs in the pure core, on work-items only.
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext({ ...base, harnessSlugs: ['papercusp'] });
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { scopeFilter: unknown }).scopeFilter).toBeNull();
    expect((ctx as { workspaceId: string }).workspaceId).toBe('ws-1');
  });

  it('sends the COMPACT query, never the raw prompt envelope', async () => {
    // The engine ANDs every lexeme; a 1000-char turn-start envelope (the
    // measured median) would match nothing at all.
    runHybridSearch.mockResolvedValue(ok());
    const envelope = `${'envelope preamble boilerplate '.repeat(40)}${QUERY}`;
    await recallCorpusContext({ ...base, queryText: envelope });
    const [, ctx] = runHybridSearch.mock.calls[0];
    const sent = (ctx as { query: string }).query;
    expect(sent.length).toBeLessThan(40);
    expect(sent.split(' ').length).toBeLessThanOrEqual(2);
  });

  it('sends a work-item id ALONE when the turn mentions one', async () => {
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext({ ...base, queryText: 'what happened with WI-6512 and the sse leg' });
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { query: string }).query).toBe('wi-6512');
  });

  it('skips a query with nothing searchable in it', async () => {
    const res = await recallCorpusContext({ ...base, queryText: 'a of to the and' });
    expect(res.block).toBeNull();
    expect(runHybridSearch).not.toHaveBeenCalled();
  });

  it('over-fetches so the pure core has candidates left after filtering', async () => {
    runHybridSearch.mockResolvedValue(ok());
    await recallCorpusContext({ ...base, maxItems: 3 });
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { limit: number }).limit).toBeGreaterThanOrEqual(12);
    expect((ctx as { mode: string }).mode).toBe('hybrid');
  });

  it('still narrows work-items by harness — in the pure core, not the SQL', async () => {
    runHybridSearch.mockResolvedValue(
      ok([hit({ source_id: 'WI-999', scope: 'harness:other' })]),
    );
    const res = await recallCorpusContext({ ...base, harnessSlugs: ['papercusp'] });
    expect(res.lines).toHaveLength(0);
    expect(res.dropped).toContainEqual({ ref: 'WI-999', reason: 'out-of-scope' });
  });
});

describe('recallCorpusContext — output', () => {
  it('renders a pointer block from a hit', async () => {
    runHybridSearch.mockResolvedValue(ok());
    const res = await recallCorpusContext(base);
    expect(res.block).toContain('WI-6512');
    expect(res.block).toContain("work_items:get { id: 'WI-6512' }");
    expect(res.candidateCount).toBe(1);
    expect(res.embedderAvailable).toBe(true);
  });

  it('drops the calling session’s own turns', async () => {
    runHybridSearch.mockResolvedValue(
      ok([hit({ source: 'session_turn', source_id: 'claude:sess-self:4', scope: null })]),
    );
    const res = await recallCorpusContext({ ...base, excludeSessionId: 'sess-self' });
    expect(res.block).toBeNull();
    expect(res.dropped).toContainEqual({ ref: 'claude:sess-self', reason: 'self-session' });
  });

  it('returns an empty block, not null, when the engine returns nothing', async () => {
    runHybridSearch.mockResolvedValue(ok([]));
    const res = await recallCorpusContext(base);
    expect(res.block).toBeNull();
    expect(res.lines).toEqual([]);
  });
});

describe('recallCorpusContext — degradation (never throws, never blocks a turn)', () => {
  it('is a no-op when the flag is OFF', async () => {
    getFlag.mockResolvedValue(false);
    const res = await recallCorpusContext(base);
    expect(res.block).toBeNull();
    expect(runHybridSearch).not.toHaveBeenCalled();
  });

  it('stays ON when the flag store itself fails — a default-ON feature must not fail closed', async () => {
    getFlag.mockRejectedValue(new Error('flags down'));
    runHybridSearch.mockResolvedValue(ok());
    const res = await recallCorpusContext(base);
    expect(res.block).toContain('WI-6512');
  });

  it('skips an empty query without touching the engine', async () => {
    const res = await recallCorpusContext({ ...base, queryText: '   ' });
    expect(res.block).toBeNull();
    expect(runHybridSearch).not.toHaveBeenCalled();
  });

  it('swallows a throwing search', async () => {
    runHybridSearch.mockRejectedValue(new Error('pg down'));
    await expect(recallCorpusContext(base)).resolves.toMatchObject({ block: null });
  });

  it('gives up on its own wall-clock bound instead of stalling the turn', async () => {
    process.env.PAPERCUSP_MEMORY_CORPUS_TIMEOUT_MS = '20';
    runHybridSearch.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok()), 500)),
    );
    const t0 = Date.now();
    const res = await recallCorpusContext(base);
    expect(res.block).toBeNull();
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it('runs BM25-only when no embedder resolves (a cold ONNX start must not stall)', async () => {
    buildQueryEmbedder.mockResolvedValue(null as unknown);
    runHybridSearch.mockResolvedValue({ ...ok(), embedderAvailable: false });
    const res = await recallCorpusContext(base);
    expect(res.block).toContain('WI-6512');
    expect(res.embedderAvailable).toBe(false);
    const [, ctx] = runHybridSearch.mock.calls[0];
    expect((ctx as { embedder: unknown }).embedder).toBeNull();
  });
});
