import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchHit } from '@papercusp/search';

// Both deps are pulled in via dynamic import() inside rerankProseHits, so the
// mocks below intercept those too.
vi.mock('../../credentials', () => ({ readCredentials: vi.fn() }));
vi.mock('@papercusp/search-core', () => ({ rankWithReranker: vi.fn() }));

import {
  RERANK_MAX_CANDIDATES,
  RERANK_OVERFETCH,
  rerankCandidateCount,
  rerankProseHits,
  rerankText,
} from './rerank';
import { readCredentials } from '../../credentials';
import { rankWithReranker } from '@papercusp/search-core';

const hit = (source_id: string, score: number, excerpt = `body-${source_id}`): SearchHit => ({
  source: 'escalations',
  source_id,
  excerpt,
  highlight: `<mark>${excerpt}</mark>`,
  score,
  rankers: ['bm25'],
});

// RRF order: a (0.9) > b (0.5) > c (0.1).
const HITS = [hit('a', 0.9), hit('b', 0.5), hit('c', 0.1)];

const savedEnv = process.env.ZEROENTROPY_API_KEY;
beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ZEROENTROPY_API_KEY;
  vi.mocked(readCredentials).mockResolvedValue({});
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.ZEROENTROPY_API_KEY;
  else process.env.ZEROENTROPY_API_KEY = savedEnv;
});

describe('rerankProseHits — fail-safe', () => {
  it('no key anywhere → returns RRF order unchanged, never imports the reranker', async () => {
    const out = await rerankProseHits('q', HITS, 5);
    expect(out).toEqual(HITS);
    expect(rankWithReranker).not.toHaveBeenCalled();
  });

  it('no key → still slices to limit (RRF top-N)', async () => {
    const out = await rerankProseHits('q', HITS, 2);
    expect(out.map((h) => h.source_id)).toEqual(['a', 'b']);
    expect(rankWithReranker).not.toHaveBeenCalled();
  });

  it('≤1 hit → passthrough without reading credentials', async () => {
    expect(await rerankProseHits('q', [HITS[0]], 5)).toEqual([HITS[0]]);
    expect(await rerankProseHits('q', [], 5)).toEqual([]);
    expect(readCredentials).not.toHaveBeenCalled();
    expect(rankWithReranker).not.toHaveBeenCalled();
  });

  it('key present but the reranker throws → RRF passthrough (outage never breaks search)', async () => {
    vi.mocked(readCredentials).mockResolvedValue({ zeroentropy_api_key: 'ze_test' });
    vi.mocked(rankWithReranker).mockRejectedValue(new Error('rerank api down'));
    const out = await rerankProseHits('q', HITS, 5);
    expect(out).toEqual(HITS);
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
    rankers: ['bm25'],
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
