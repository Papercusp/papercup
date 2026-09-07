import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchHit } from '@papercusp/search';

// All three deps are pulled in via dynamic import() inside rerankProseHits, so
// the mocks below intercept those too.
vi.mock('../../credentials', () => ({ readCredentials: vi.fn() }));
vi.mock('@papercusp/search-core', () => ({ rankWithReranker: vi.fn() }));
vi.mock('../../memory/embed-sidecar-wiring', () => ({ buildSidecarAwareReranker: vi.fn() }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: vi.fn() }));

import {
  PROSE_RERANK_TIMEOUT_MS,
  PROSE_RERANK_ENGINE_DECISION_TTL_MS,
  RERANK_MAX_CANDIDATES,
  RERANK_OVERFETCH,
  _resetLocalRerankScorerForTests,
  _resetProseRerankEngineDecisionForTests,
  rerankCandidateCount,
  rerankPageHead,
  rerankProseHits,
  rerankRows,
  rerankText,
} from './rerank';
// Real constants (not mocked): the ordering between these three IS the guard.
import { DEFAULT_RERANK_TIMEOUT_MS, DEFAULT_SIDECAR_TIMEOUT_MS } from '@papercusp/rerank';
import { readCredentials } from '../../credentials';
import { rankWithReranker } from '@papercusp/search-core';
import { buildSidecarAwareReranker } from '../../memory/embed-sidecar-wiring';
import { getFlag } from '@papercusp/flags/server';

const hit = (source_id: string, score: number, excerpt = `body-${source_id}`): SearchHit => ({
  source: 'escalations',
  source_id,
  excerpt,
  highlight: `<mark>${excerpt}</mark>`,
  score,
  rankers: ['lexical'],
});

// RRF order: a (0.9) > b (0.5) > c (0.1).
const HITS = [hit('a', 0.9), hit('b', 0.5), hit('c', 0.1)];

/** A local scorer that scores by position, so a reorder is observable. */
const scorer = vi.fn(async (_q: string, texts: string[]) => texts.map((_t, i) => i / 10));

const savedEnv = process.env.ZEROENTROPY_API_KEY;
beforeEach(() => {
  vi.clearAllMocks();
  _resetLocalRerankScorerForTests();
  _resetProseRerankEngineDecisionForTests();
  delete process.env.ZEROENTROPY_API_KEY;
  vi.mocked(readCredentials).mockResolvedValue({});
  vi.mocked(buildSidecarAwareReranker).mockResolvedValue(scorer);
  vi.mocked(getFlag).mockResolvedValue(true); // FLAGS.LOCAL_RERANK default ON
});
afterEach(() => {
  vi.useRealTimers();
  if (savedEnv === undefined) delete process.env.ZEROENTROPY_API_KEY;
  else process.env.ZEROENTROPY_API_KEY = savedEnv;
});

describe('rerankProseHits — fail-safe', () => {
  it('≤1 hit → passthrough without resolving an engine at all', async () => {
    expect(await rerankProseHits('q', [HITS[0]], 5)).toEqual([HITS[0]]);
    expect(await rerankProseHits('q', [], 5)).toEqual([]);
    expect(readCredentials).not.toHaveBeenCalled();
    expect(buildSidecarAwareReranker).not.toHaveBeenCalled();
    expect(rankWithReranker).not.toHaveBeenCalled();
  });

  it('key present but the reranker throws → RRF passthrough (outage never breaks search)', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ zeroentropy_api_key: 'ze_test' });
    vi.mocked(rankWithReranker).mockRejectedValue(new Error('rerank api down'));
    const out = await rerankProseHits('q', HITS, 5);
    expect(out).toEqual(HITS);
  });

  it('local scorer unbuildable (no sidecar, no runtime) → RRF passthrough, sliced', async () => {
    // The local engine is the DEFAULT path now, so its build failure is the
    // one most likely to be hit in the field — it must degrade, not throw.
    vi.mocked(buildSidecarAwareReranker).mockRejectedValue(new Error('no sidecar'));
    expect(await rerankProseHits('q', HITS, 2)).toEqual(HITS.slice(0, 2));
    expect(rankWithReranker).not.toHaveBeenCalled();
  });

  it('a failed scorer build is NOT cached — the next query retries it', async () => {
    // A transient spawn failure must not disable reranking for the life of the
    // process, which is exactly what memoizing the rejected promise would do.
    vi.mocked(buildSidecarAwareReranker).mockRejectedValueOnce(new Error('spawn raced'));
    await rerankProseHits('q', HITS, 5);
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);
    await rerankProseHits('q', HITS, 5);
    expect(buildSidecarAwareReranker).toHaveBeenCalledTimes(2);
    expect(rankWithReranker).toHaveBeenCalledTimes(1);
  });
});

describe('rerankProseHits — engine selection', () => {
  it('no key anywhere → LOCAL engine with the sidecar-aware scorer (the seam is no longer dark)', async () => {
    vi.mocked(rankWithReranker).mockImplementation(async (_q, docs) =>
      docs.map((d) => d.row as SearchHit).reverse(),
    );

    const out = await rerankProseHits('q', HITS, 5);
    expect(out.map((h) => h.source_id)).toEqual(['c', 'b', 'a']);

    const opts = vi.mocked(rankWithReranker).mock.calls[0][2];
    expect(opts.engine).toBe('local');
    expect(opts.scorer).toBe(scorer);
    // No credential is involved on the local path.
    expect(opts.rerankApiKey).toBeUndefined();
  });

  it('forwards the search latency budget on BOTH engines, so neither can stall a page', async () => {
    // The budget is the only thing standing between a sick engine and a hung
    // search, and it is a plain option — silently droppable. Assert it on both
    // branches: a hosted-only assertion would not catch losing it on the local
    // path (the default engine), and vice versa.
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);

    await rerankProseHits('q', HITS, 5); // local (no key configured)
    expect(vi.mocked(rankWithReranker).mock.calls[0][2].rerankTimeoutMs).toBe(PROSE_RERANK_TIMEOUT_MS);

    _resetProseRerankEngineDecisionForTests();
    vi.mocked(readCredentials).mockResolvedValue({ zeroentropy_api_key: 'ze_test' });
    await rerankProseHits('q', HITS, 5); // hosted
    expect(vi.mocked(rankWithReranker).mock.calls[1][2].rerankTimeoutMs).toBe(PROSE_RERANK_TIMEOUT_MS);
  });

  it('a caller with a tighter bound can override the budget, so it degrades instead of killing the leg', async () => {
    // P-008 prerequisite. The 4s default is correct for the interactive search
    // surfaces this wrapper was written for and WRONG for the corpus leg of
    // context injection, which wraps its whole recall in a 2,000ms withBound —
    // half the default. Without an override a slow rerank does not degrade the
    // page: `recallCorpusContext` returns empty('timed-out') and the agent gets
    // NO pointer section at all, which is strictly worse than not reranking.
    //
    // Measured (bench/corpus-rerank-reach-cli.ts, hybrid arm, n=120, 2026-08-09):
    // one-stage rerank breaches that 2s bound on 2/120 queries (1.7%). Those two
    // are exactly the queries this override converts from "no pointer section"
    // into "RRF order" — which is why it is a prerequisite and not a nicety.
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);

    await rerankProseHits('q', HITS, 5, { rerankTimeoutMs: 1_500 });

    const opts = vi.mocked(rankWithReranker).mock.calls[0][2];
    expect(opts.rerankTimeoutMs).toBe(1_500);
    // The override must be strictly under the caller's own bound to leave room
    // for the rest of the leg — a bound equal to it still takes the leg down.
    expect(opts.rerankTimeoutMs!).toBeLessThan(2_000);
  });

  it('omitting the override keeps the default, so existing callers are untouched', async () => {
    // The override is additive: every caller that does not opt in must be
    // byte-identical to before. An optional parameter that silently changed the
    // default would move four other search surfaces at once.
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);

    await rerankProseHits('q', HITS, 5);

    expect(vi.mocked(rankWithReranker).mock.calls[0][2].rerankTimeoutMs).toBe(PROSE_RERANK_TIMEOUT_MS);
  });

  it('the search budget is tighter than the layers below it, or it guards nothing', async () => {
    // A budget above the sidecar's own 15s retry budget would never bind: the
    // sidecar would give up first and this would be decorative. Encode the
    // ordering so a later bump to either number has to stay coherent.
    expect(PROSE_RERANK_TIMEOUT_MS).toBeLessThan(DEFAULT_SIDECAR_TIMEOUT_MS);
    expect(DEFAULT_SIDECAR_TIMEOUT_MS).toBeLessThan(DEFAULT_RERANK_TIMEOUT_MS);
  });

  it('a configured key still wins — hosted, with no local scorer built', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ zeroentropy_api_key: 'ze_test' });
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);

    await rerankProseHits('q', HITS, 5);
    const opts = vi.mocked(rankWithReranker).mock.calls[0][2];
    expect(opts.rerankApiKey).toBe('ze_test');
    expect(opts.engine).toBeUndefined();
    expect(opts.scorer).toBeUndefined();
    expect(buildSidecarAwareReranker).not.toHaveBeenCalled();
  });

  it('reuses the hosted-vs-local decision instead of reading credentials per search', async () => {
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);

    await rerankProseHits('q', HITS, 5);
    await rerankProseHits('q2', HITS, 5);

    expect(readCredentials).toHaveBeenCalledTimes(1);
    // The credential optimization must not latch the independent feature flag.
    expect(getFlag).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent cold searches onto one credential read', async () => {
    let releaseCredentials!: (value: Awaited<ReturnType<typeof readCredentials>>) => void;
    const pendingCredentials = new Promise<Awaited<ReturnType<typeof readCredentials>>>((resolve) => {
      releaseCredentials = resolve;
    });
    vi.mocked(readCredentials).mockReturnValue(pendingCredentials);
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);

    const first = rerankProseHits('q', HITS, 5);
    const second = rerankProseHits('q2', HITS, 5);
    await vi.waitFor(() => expect(readCredentials).toHaveBeenCalledTimes(1));
    releaseCredentials({});
    await Promise.all([first, second]);

    expect(readCredentials).toHaveBeenCalledTimes(1);
    expect(rankWithReranker).toHaveBeenCalledTimes(2);
  });

  it('refreshes the decision after its TTL so a newly added key needs no restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);

    await rerankProseHits('local-1', HITS, 5);
    vi.mocked(readCredentials).mockResolvedValue({ zeroentropy_api_key: 'ze_added' });

    vi.advanceTimersByTime(PROSE_RERANK_ENGINE_DECISION_TTL_MS - 1);
    await rerankProseHits('local-2', HITS, 5);
    expect(readCredentials).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rankWithReranker).mock.calls[1][2].engine).toBe('local');

    vi.advanceTimersByTime(1);
    await rerankProseHits('hosted', HITS, 5);
    expect(readCredentials).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rankWithReranker).mock.calls[2][2].rerankApiKey).toBe('ze_added');
  });

  it('does not negative-cache a failed credential read', async () => {
    vi.mocked(readCredentials)
      .mockRejectedValueOnce(new Error('credentials PG unavailable'))
      .mockResolvedValue({ zeroentropy_api_key: 'ze_recovered' });
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);

    await rerankProseHits('degraded-read', HITS, 5);
    await rerankProseHits('recovered-read', HITS, 5);

    expect(readCredentials).toHaveBeenCalledTimes(2);
    expect(vi.mocked(rankWithReranker).mock.calls[0][2].engine).toBe('local');
    expect(vi.mocked(rankWithReranker).mock.calls[1][2].rerankApiKey).toBe('ze_recovered');
  });

  it('FLAGS.LOCAL_RERANK off + no key → the pre-P-007 dark seam, byte-identically', async () => {
    // The kill-switch contract: OFF must return to a state we shipped and ran
    // for months (RRF passthrough), not to some third path.
    vi.mocked(getFlag).mockResolvedValue(false);
    const out = await rerankProseHits('q', HITS, 2);
    expect(out).toEqual(HITS.slice(0, 2));
    expect(rankWithReranker).not.toHaveBeenCalled();
    expect(buildSidecarAwareReranker).not.toHaveBeenCalled();
  });

  it('FLAGS.LOCAL_RERANK off does NOT disable the hosted engine — it gates the local one only', async () => {
    vi.mocked(getFlag).mockResolvedValue(false);
    vi.mocked(readCredentials).mockResolvedValue({ zeroentropy_api_key: 'ze_test' });
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);
    await rerankProseHits('q', HITS, 5);
    expect(vi.mocked(rankWithReranker).mock.calls[0][2].rerankApiKey).toBe('ze_test');
  });

  it('flag backend throwing FAILS OPEN — an outage must not silently switch reranking off fleet-wide', async () => {
    // Failing closed would look exactly like the reranker being broken, across
    // every worker at once, with nothing pointing at the flag backend.
    vi.mocked(getFlag).mockRejectedValue(new Error('posthog unreachable'));
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);
    await rerankProseHits('q', HITS, 5);
    expect(vi.mocked(rankWithReranker).mock.calls[0][2].engine).toBe('local');
  });

  it('reads the flag PER QUERY so an /admin/features flip needs no restart', async () => {
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);
    await rerankProseHits('q', HITS, 5);
    vi.mocked(getFlag).mockResolvedValue(false);
    const out = await rerankProseHits('q2', HITS, 5);
    expect(out).toEqual(HITS); // second query saw the flip
    expect(rankWithReranker).toHaveBeenCalledTimes(1);
  });

  it('builds the local scorer ONCE per process, not per query', async () => {
    // Rebuilding per query would re-resolve (and possibly re-spawn) the sidecar
    // and reset the client's up/down transition state every single search.
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);
    await rerankProseHits('q', HITS, 5);
    await rerankProseHits('q2', HITS, 5);
    expect(buildSidecarAwareReranker).toHaveBeenCalledTimes(1);
    expect(rankWithReranker).toHaveBeenCalledTimes(2);
  });
});

describe('rerankProseHits — active', () => {
  it('key present → maps hits to {id,text,row}, passes generic opts, returns reranker order', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ zeroentropy_api_key: 'ze_test' });
    // Reranker reverses the order to prove the new order is honored.
    vi.mocked(rankWithReranker).mockImplementation(async (_q, docs) =>
      docs.map((d) => d.row as SearchHit).reverse(),
    );

    const out = await rerankProseHits('q', HITS, 5);
    expect(out.map((h) => h.source_id)).toEqual(['c', 'b', 'a']);

    const [query, docs, opts] = vi.mocked(rankWithReranker).mock.calls[0];
    expect(query).toBe('q');
    expect(docs).toEqual([
      { id: 'escalations:a', text: 'body-a', row: HITS[0] },
      { id: 'escalations:b', text: 'body-b', row: HITS[1] },
      { id: 'escalations:c', text: 'body-c', row: HITS[2] },
    ]);
    expect(opts.limit).toBe(5);
    expect(opts.rerankApiKey).toBe('ze_test');
    // Generic rerank: no e-commerce instruction / LLM pass.
    expect(opts.instruction).toBeUndefined();
    expect(opts.llm).toBeUndefined();
    // Within-bucket tiebreak is the fused RRF/BM25 score.
    expect(opts.qualityScore?.(HITS[0])).toBe(0.9);
  });

  it('env-var key works when no credential is stored', async () => {
    process.env.ZEROENTROPY_API_KEY = 'ze_env';
    vi.mocked(rankWithReranker).mockResolvedValue(HITS);
    await rerankProseHits('q', HITS, 5);
    expect(vi.mocked(rankWithReranker).mock.calls[0][2].rerankApiKey).toBe('ze_env');
  });
});

describe('rerankText — scores the MATCHED passage, not the document opening', () => {
  const mk = (excerpt: string, highlight: string): SearchHit => ({
    source: 'docs',
    source_id: 'd1',
    excerpt,
    highlight,
    score: 1,
    rankers: ['lexical'],
  });

  it('strips <mark> tags — they are a rendering concern, not model input', () => {
    expect(rerankText(mk('', '<mark>pgbouncer</mark> pooling'))).toBe('pgbouncer pooling');
  });

  it('leads with the matched fragment when it differs from the head-of-doc excerpt', () => {
    // The real failure mode: a long doc whose relevant passage is nowhere near
    // its first 200 chars. `excerpt` is body.slice(0,200), so scoring it alone
    // asks the wrong question.
    const out = rerankText(mk('This document describes the release process.', '<mark>rerank</mark> latency budget'));
    expect(out.startsWith('rerank latency budget')).toBe(true);
    expect(out).toContain('This document describes the release process.');
  });

  it('falls back to the excerpt when no highlight is present (vector leg runs no ts_headline)', () => {
    expect(rerankText(mk('body text only', ''))).toBe('body text only');
  });

  it('does not duplicate text when one field contains the other', () => {
    expect(rerankText(mk('body-a', '<mark>body-a</mark>'))).toBe('body-a');
  });

  it('never returns mark markup for any combination', () => {
    for (const h of ['<mark>x</mark>', '', 'plain', '<mark>a</mark> … <mark>b</mark>']) {
      expect(rerankText(mk('some excerpt', h))).not.toContain('<mark>');
    }
  });
});

describe('rerankCandidateCount — over-fetch sizing', () => {
  it('over-fetches by RERANK_OVERFETCH while under the cap', () => {
    // The common path: both prose tools default to limit 5.
    expect(rerankCandidateCount(5)).toBe(5 * RERANK_OVERFETCH);
    expect(rerankCandidateCount(1)).toBe(1 * RERANK_OVERFETCH);
  });

  it('clamps to RERANK_MAX_CANDIDATES so worst-case latency stays bounded', () => {
    // Both tools cap `limit` at 20; 20 * 4 = 80 pairs ≈ 3.6s at the measured
    // ~45ms/pair, which is exactly what the cap exists to prevent.
    expect(rerankCandidateCount(20)).toBe(RERANK_MAX_CANDIDATES);
    expect(rerankCandidateCount(20)).toBeLessThan(20 * RERANK_OVERFETCH);
  });

  it('NEVER under-fetches — an over-fetch that returns fewer than `limit` would truncate the page', () => {
    // Guards the cap/limit interaction: if `limit` ever exceeds the cap, the
    // cap must not win, or the caller silently loses results it asked for.
    const beyondCap = RERANK_MAX_CANDIDATES + 10;
    expect(rerankCandidateCount(beyondCap)).toBe(beyondCap);
    for (const limit of [1, 3, 5, 10, 20, 24, 50, 100]) {
      expect(rerankCandidateCount(limit)).toBeGreaterThanOrEqual(limit);
    }
  });

  it('is monotonic in limit (a bigger page never retrieves a smaller pool)', () => {
    let prev = 0;
    for (let limit = 1; limit <= 60; limit++) {
      const n = rerankCandidateCount(limit);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

/**
 * P-010 — Stage B for a page BIGGER than the candidate cap.
 *
 * `rerankCandidateCount` never under-fetches (`Math.max(limit, …)`), so for any
 * `limit` at or above RERANK_MAX_CANDIDATES it returns `limit` and the
 * over-fetch degenerates to the page itself. Both prose tools cap at 20 so they
 * never reach that; the transcript-search route asks for 30–50 and does. These
 * pin the property that makes the wiring safe: cost is bounded by the MEASURED
 * cap regardless of how big a page a caller asks for.
 */
describe('rerankPageHead — candidate budget, not page size', () => {
  const page = (n: number) => Array.from({ length: n }, (_, i) => hit(`h${i}`, 1 - i / 100));
  // Reverses to make a reorder observable, and — unlike the simpler stand-ins
  // above — HONORS opts.limit, because that is what the real
  // `rankWithReranker` does and it is precisely the behaviour under test here:
  // whether the pool the reranker chose from was bigger than the page.
  const reverseRerank = () =>
    vi.mocked(rankWithReranker).mockImplementation(async (_q, docs, opts) =>
      docs.map((d) => d.row as SearchHit).reverse().slice(0, opts.limit),
    );

  it('pool at or below the cap → plain rerankProseHits (real over-fetch)', async () => {
    reverseRerank();
    const out = await rerankPageHead('q', page(RERANK_MAX_CANDIDATES), 5);
    // The reranker saw the WHOLE pool and chose the page from it — so it can
    // pull a buried hit IN, not merely shuffle a page retrieval already picked.
    expect(vi.mocked(rankWithReranker).mock.calls[0][1]).toHaveLength(RERANK_MAX_CANDIDATES);
    expect(out).toHaveLength(5);
    expect(out[0].source_id).toBe(`h${RERANK_MAX_CANDIDATES - 1}`);
  });

  it('page BEYOND the cap → scores exactly the cap, never the whole page', async () => {
    // The desktop pill's real page size, and the HUD's.
    for (const hitLimit of [30, 50]) {
      vi.mocked(rankWithReranker).mockClear();
      reverseRerank();
      const out = await rerankPageHead('q', page(hitLimit), hitLimit);
      // THE BUDGET: ~45ms/pair × 24 ≈ 1.1s worst case, whatever the page size.
      expect(vi.mocked(rankWithReranker).mock.calls[0][1]).toHaveLength(RERANK_MAX_CANDIDATES);
      // The page is still whole — a candidate budget must not truncate results.
      expect(out).toHaveLength(hitLimit);
    }
  });

  it('reranks the head and rides the tail through in retrieval order', async () => {
    reverseRerank();
    const ids = (await rerankPageHead('q', page(30), 30)).map((h) => h.source_id);
    // Head: the first 24, reversed by the reranker.
    expect(ids.slice(0, RERANK_MAX_CANDIDATES)).toEqual(
      Array.from({ length: RERANK_MAX_CANDIDATES }, (_, i) => `h${RERANK_MAX_CANDIDATES - 1 - i}`),
    );
    // Tail: untouched, still in retrieval order beneath it.
    expect(ids.slice(RERANK_MAX_CANDIDATES)).toEqual(['h24', 'h25', 'h26', 'h27', 'h28', 'h29']);
  });

  it('a page beyond the cap still slices to a SMALLER requested limit', async () => {
    reverseRerank();
    const out = await rerankPageHead('q', page(40), 10);
    expect(out).toHaveLength(10);
    expect(out[0].source_id).toBe(`h${RERANK_MAX_CANDIDATES - 1}`);
  });

  it('FAIL-SAFE: a rerank outage degrades a big page to retrieval order, whole', async () => {
    vi.mocked(rankWithReranker).mockRejectedValue(new Error('sidecar down'));
    const pool = page(30);
    const out = await rerankPageHead('q', pool, 30);
    expect(out.map((h) => h.source_id)).toEqual(pool.map((h) => h.source_id));
  });
});

/**
 * `rerankRows` is the row-shape-agnostic core extracted for P-008 so the corpus
 * leg could rerank its own `CorpusHit` without adapting it into a `SearchHit`.
 * These pin the two properties a second caller depends on and that
 * `rerankProseHits`'s own tests structurally cannot cover, because it always
 * passes a page-sized `limit` and never observes the outcome callback.
 */
describe('rerankRows — the generic core', () => {
  it('local-only callers cannot dispatch hosted reranking even with a configured key', async () => {
    process.env.ZEROENTROPY_API_KEY = 'ze_test';
    vi.mocked(readCredentials).mockResolvedValue({ zeroentropy_api_key: 'ze_test' });
    vi.mocked(rankWithReranker).mockImplementation(async (_q, docs) => docs.map((d) => d.row));
    await rerankRows('q', HITS, {
      engine: 'local', limit: 3, id: (r) => r.source_id, text: (r) => r.excerpt, rerankTimeoutMs: 1000,
    });
    expect(readCredentials).not.toHaveBeenCalled();
    expect(rankWithReranker).toHaveBeenCalledWith('q', expect.any(Array),
      expect.objectContaining({ engine: 'local', scorer }));
    expect(vi.mocked(rankWithReranker).mock.calls[0]![2]).not.toHaveProperty('rerankApiKey');
  });
  type Row = { id: string; text: string; q: number };
  const rows: Row[] = [
    { id: 'r1', text: 't1', q: 0.9 },
    { id: 'r2', text: 't2', q: 0.5 },
    { id: 'r3', text: 't3', q: 0.1 },
    { id: 'r4', text: 't4', q: 0.05 },
  ];
  type Outcome = { attempted: boolean; reason?: string; engine?: string | null; scored?: number };
  const opts = (over: Record<string, unknown> = {}) => ({
    limit: rows.length,
    id: (r: Row) => r.id,
    text: (r: Row) => r.text,
    qualityScore: (r: Row) => r.q,
    rerankTimeoutMs: 1_000,
    ...over,
  });
  /** Reverse the pool, honouring whatever `limit` the caller passed. */
  const reversing = () =>
    vi.mocked(rankWithReranker).mockImplementation(async (_q, docs, o) =>
      [...docs].reverse().slice(0, (o as { limit: number }).limit).map((d) => d.row),
    );

  it('REORDERS WITHOUT CUTTING when limit === rows.length — the corpus leg depends on this', async () => {
    // THE PROPERTY, not a constant. The corpus leg reranks its 4x over-fetched
    // pool and lets `selectCorpusLines` take the cut, because selection drops
    // self-session echoes / out-of-scope work-items / no-overlap hits BEFORE its
    // own 6-item cap. Slicing to the page HERE would starve those filters and
    // silently turn a reorder into a truncation — admitting FEWER lines than
    // before, which no line-count acceptance would catch (D-066).
    reversing();
    const out = await rerankRows<Row>('q', rows, opts());
    expect(out).toHaveLength(rows.length); // nothing dropped
    expect(out.map((r) => r.id)).toEqual(['r4', 'r3', 'r2', 'r1']); // genuinely reordered
  });

  it('a caller that DOES want a page still gets one — limit is honoured', async () => {
    reversing();
    const out = await rerankRows<Row>('q', rows, opts({ limit: 2 }));
    expect(out.map((r) => r.id)).toEqual(['r4', 'r3']);
  });

  it('engine throws → input order kept, nothing dropped, reported NOT attempted', async () => {
    vi.mocked(rankWithReranker).mockRejectedValue(new Error('engine down'));
    const seen: Outcome[] = [];
    const out = await rerankRows<Row>('q', rows, opts({ onOutcome: (o: Outcome) => seen.push(o) }));
    expect(out.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(seen).toHaveLength(1);
    expect(seen[0].attempted).toBe(false);
  });

  it('no engine resolvable → passthrough reported NOT attempted, so an A/B can VOID itself', async () => {
    // The measurement-integrity contract, and the reason `onOutcome` exists at
    // all. A dead engine produces output BYTE-IDENTICAL to a rerank-disabled
    // control arm, so without this signal a treatment arm that quietly lost its
    // engine reports a clean null that reads as "reranking does not help" — and
    // the natural response to that null is to abandon the feature
    // (context-injection-retrieval-reach-and-visibility-2026-08-03#D-093).
    vi.mocked(getFlag).mockResolvedValue(false); // LOCAL_RERANK off, and no hosted key
    const seen: Outcome[] = [];
    const out = await rerankRows<Row>('q', rows, opts({ onOutcome: (o: Outcome) => seen.push(o) }));
    expect(out.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(seen).toEqual([{ attempted: false, reason: 'no-engine' }]);
  });

  it('success reports attempted EXACTLY ONCE — a bench counts engaged calls with it', async () => {
    vi.mocked(rankWithReranker).mockImplementation(async (_q, docs) => docs.map((d) => d.row));
    const seen: Outcome[] = [];
    await rerankRows<Row>('q', rows, opts({ onOutcome: (o: Outcome) => seen.push(o) }));
    expect(seen).toHaveLength(1);
    expect(seen[0].attempted).toBe(true);
  });

  /**
   * WI-37670 — the failure this whole callback exists to catch, and the ONE
   * case it used to miss. An engine resolves, `rankWithReranker` returns
   * normally, and the cross-encoder scored NOTHING: the rows are retrieval
   * order, byte-identical to a disabled reranker, and the old contract reported
   * `attempted: true, reason: 'local'` — an honest-looking success.
   *
   * Measured 2026-08-10: 238/238 queries of the WI-37653 bench looked exactly
   * like that, because four concurrent calls serialize on ONE inference thread,
   * so each call's wall clock is ~4x its own compute and every one blew the
   * budget. Only a separate "did the order ever move" guard caught it.
   */
  describe('a stage that ran but scored NOTHING is a non-engagement, not a success', () => {
    /** `rankWithReranker` returning input order after reporting a degrade. */
    const degradingWith = (degradeReason?: string) =>
      vi.mocked(rankWithReranker).mockImplementation(async (_q, docs, o) => {
        (o as { onRerankStage?: (i: unknown) => void }).onRerankStage?.({
          scored: 0,
          total: docs.length,
          ...(degradeReason ? { degradeReason } : {}),
        });
        return docs.map((d) => d.row);
      });

    it('reports NOT attempted, names the reason, and still names the engine', async () => {
      degradingWith('timeout');
      const seen: Outcome[] = [];
      const out = await rerankRows<Row>('q', rows, opts({ onOutcome: (o: Outcome) => seen.push(o) }));
      expect(out.map((r) => r.id)).toEqual(['r1', 'r2', 'r3', 'r4']); // retrieval order
      expect(seen).toEqual([
        { attempted: false, reason: 'degraded:timeout', engine: 'local', scored: 0 },
      ]);
    });

    it('falls back to a generic reason when the library named none', async () => {
      degradingWith(undefined);
      const seen: Outcome[] = [];
      await rerankRows<Row>('q', rows, opts({ onOutcome: (o: Outcome) => seen.push(o) }));
      expect(seen[0].reason).toBe('degraded:no-rows-scored');
    });

    /**
     * CONTROL 1 — a stage that DID score must still report attempted. Without
     * it, the assertions above pass against an implementation that reports every
     * call as degraded, which is the same bug with the sign flipped: a bench
     * would then void every valid run instead of publishing every void one.
     */
    it('a stage that scored rows reports attempted WITH its count', async () => {
      vi.mocked(rankWithReranker).mockImplementation(async (_q, docs, o) => {
        (o as { onRerankStage?: (i: unknown) => void }).onRerankStage?.({
          scored: docs.length,
          total: docs.length,
        });
        return docs.map((d) => d.row);
      });
      const seen: Outcome[] = [];
      await rerankRows<Row>('q', rows, opts({ onOutcome: (o: Outcome) => seen.push(o) }));
      expect(seen).toEqual([{ attempted: true, reason: 'local', engine: 'local', scored: 4 }]);
    });

    /**
     * CONTROL 2 — a PARTIAL degrade is still an engagement. Flipping on "some
     * pairs were dropped" would void runs that produced a real reordering.
     */
    it('a PARTIAL score is still attempted', async () => {
      vi.mocked(rankWithReranker).mockImplementation(async (_q, docs, o) => {
        (o as { onRerankStage?: (i: unknown) => void }).onRerankStage?.({
          scored: 1,
          total: docs.length,
        });
        return docs.map((d) => d.row);
      });
      const seen: Outcome[] = [];
      await rerankRows<Row>('q', rows, opts({ onOutcome: (o: Outcome) => seen.push(o) }));
      expect(seen).toEqual([{ attempted: true, reason: 'local', engine: 'local', scored: 1 }]);
    });

    /**
     * A search-core build that predates `onRerankStage` reports nothing at all.
     * That is UNKNOWN, not zero — reading it as zero would flip every call on
     * such a build to a phantom degrade.
     */
    it('a search-core that never calls onRerankStage keeps the old attempted reading', async () => {
      vi.mocked(rankWithReranker).mockImplementation(async (_q, docs) => docs.map((d) => d.row));
      const seen: Outcome[] = [];
      await rerankRows<Row>('q', rows, opts({ onOutcome: (o: Outcome) => seen.push(o) }));
      expect(seen).toEqual([{ attempted: true, reason: 'local', engine: 'local' }]);
    });
  });

  it('≤1 row → vacuous, so no engine is resolved and it says so', async () => {
    const seen: Outcome[] = [];
    const out = await rerankRows<Row>('q', [rows[0]], opts({ onOutcome: (o: Outcome) => seen.push(o) }));
    expect(out).toEqual([rows[0]]);
    expect(seen).toEqual([{ attempted: false, reason: 'nothing-to-reorder' }]);
    expect(vi.mocked(rankWithReranker)).not.toHaveBeenCalled();
  });
});

/**
 * The cross-encoder score is the ONLY per-hit number that is a true relevance
 * MAGNITUDE — the fused `score` is rank-derived, so thresholding on it is a rank
 * cutoff `limit` already performs. It used to be computed and discarded, which
 * is why a relevance floor could not be expressed at all.
 *
 * The load-bearing case is the LAST one: an unscored row must come back with the
 * field ABSENT, never 0. `@papercusp/rerank`'s degrade path reports `score: 0`
 * for rows it never judged, so collapsing that into the field would make every
 * degraded hit look maximally irrelevant — and a floor calibrated on that data
 * would be silently wrong in the safe-looking direction.
 */
describe('rerankProseHits — cross-encoder score exposure', () => {
  /** Drive `onRerankScores` with a caller-supplied score per row, in row order. */
  const scoringWith = (scores: Array<number | null>) =>
    vi.mocked(rankWithReranker).mockImplementation(async (_q, docs, o) => {
      const rows = docs.map((d) => d.row as SearchHit);
      (o as { onRerankScores?: (r: Array<{ row: SearchHit; score: number | null }>) => void })
        .onRerankScores?.(rows.map((row, i) => ({ row, score: scores[i] ?? null })));
      return rows.slice(0, o.limit);
    });

  it('attaches the score the cross-encoder gave each returned hit', async () => {
    scoringWith([0.9, 0.5, 0.1]);
    const out = await rerankProseHits('q', HITS, 3);
    expect(out.map((h) => h.rerankScore)).toEqual([0.9, 0.5, 0.1]);
  });

  it('does not mutate the caller’s hits — the annotation is a copy', async () => {
    scoringWith([0.9, 0.5, 0.1]);
    await rerankProseHits('q', HITS, 3);
    expect(HITS.every((h) => !('rerankScore' in h))).toBe(true);
  });

  it('a stage that never reached the engine annotates nothing', async () => {
    vi.mocked(rankWithReranker).mockRejectedValue(new Error('rerank api down'));
    const out = await rerankProseHits('q', HITS, 3);
    expect(out.every((h) => !('rerankScore' in h))).toBe(true);
  });

  it('leaves rerankScore ABSENT for an unscored row — never 0', async () => {
    scoringWith([0.9, null, null]);
    const out = await rerankProseHits('q', HITS, 3);
    expect(out[0].rerankScore).toBe(0.9);
    expect(out[1]).not.toHaveProperty('rerankScore');
    expect(out[2]).not.toHaveProperty('rerankScore');
    // The whole point: absent ≠ 0. A consumer filtering `>= 0.2` must DROP these
    // as unknown, not keep them as a scored zero.
    expect(out.filter((h) => typeof h.rerankScore === 'number')).toHaveLength(1);
  });
});
