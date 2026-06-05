/**
 * Stage-B rerank — the operator's reranker seam over `@papercusp/search`'s
 * RRF-fused output. `@papercusp/search` does Stage A (BM25 + pgvector → RRF)
 * and stops there; this adds a cross-encoder relevance reorder (zerank-2 via
 * `@papercusp/search-core` → `@papercusp/rerank`) so the most relevant hits
 * rise to the top of the page. Adopted from Restart's search-core
 * (search-core-papercup-adoption-2026-05-30).
 *
 * Fail-safe by construction — a rerank outage degrades to retrieval (RRF)
 * order, it never breaks search:
 *  - No ZeroEntropy key in `operator_credentials` (the common case) → we skip
 *    the rerank import entirely and return the RRF order unchanged. This is
 *    the adoption-safety property: the wiring lands now and the rerank "turns
 *    on" the day a key is added, with zero risk of regressing today's order.
 *  - Key present but the rerank lib / its `zeroentropy` dep fails to import or
 *    throws → caught, RRF order returned.
 *
 * Domain note: search-core's instruction / LLM-category-match / query-rewrite
 * stages default to e-commerce (Restart sells laptops) and do NOT transfer to
 * agent-memory search — so we use the pure cross-encoder rerank only (no
 * `instruction`, no `llm`). The only tiebreak is the fused RRF/BM25 score, kept
 * within a rerank-score bucket. If we later want instruction-following, pass
 * our OWN agent-memory prompts (never search-core's e-commerce defaults).
 */

import type { SearchHit } from '@papercusp/search';

/** Read the rerank key from operator_credentials, falling back to the env var. */
async function rerankApiKey(): Promise<string | undefined> {
  try {
    const { readCredentials } = await import('../../credentials');
    const creds = await readCredentials();
    if (creds.zeroentropy_api_key) return creds.zeroentropy_api_key;
  } catch {
    /* fall through to env */
  }
  return process.env.ZEROENTROPY_API_KEY || undefined;
}

/**
 * Rerank fused prose hits with the cross-encoder, returning them in the new
 * relevance order, sliced to `limit`. Pure passthrough when no key is
 * configured (the RRF order, sliced to `limit`).
 *
 * `hits` is the already-fused/sliced page from `@papercusp/search`; this
 * reorders it. (Over-fetching a larger candidate pool so the reranker can pull
 * a buried hit *into* the page is the natural next step once a key exists and a
 * golden-set eval justifies it — see the adoption plan.)
 */
export async function rerankProseHits(
  query: string,
  hits: SearchHit[],
  limit: number,
): Promise<SearchHit[]> {
  // Nothing to reorder, or no key anywhere → RRF order, no rerank import.
  if (hits.length <= 1) return hits.slice(0, limit);
  const apiKey = await rerankApiKey();
  if (!apiKey) return hits.slice(0, limit);

  try {
    const { rankWithReranker } = await import('@papercusp/search-core');
    return await rankWithReranker<SearchHit>(
      query,
      hits.map((hit) => ({
        id: `${hit.source}:${hit.source_id}`,
        text: hit.excerpt, // what the cross-encoder scores against the query
        row: hit, // carried through untouched
      })),
      {
        limit,
        rerankApiKey: apiKey,
        // Generic relevance rerank: no e-commerce instruction / LLM pass.
        // Within a rerank-score bucket, keep the higher RRF/BM25 hit first.
        qualityScore: (hit) => hit.score,
      },
    );
  } catch {
    // Rerank lib/dep unavailable or threw → RRF passthrough.
    return hits.slice(0, limit);
  }
}
