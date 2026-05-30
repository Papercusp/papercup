import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchHit } from '@papercusp/search';

// Both deps are pulled in via dynamic import() inside rerankProseHits, so the
// mocks below intercept those too.
vi.mock('../../credentials', () => ({ readCredentials: vi.fn() }));
vi.mock('@papercusp/search-core', () => ({ rankWithReranker: vi.fn() }));

import { rerankProseHits } from './rerank';
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
    vi.mocked(rankWithReranker).mockImplementation(
      async (_q: string, docs: Array<{ row: SearchHit }>) => docs.map((d) => d.row).reverse(),
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
