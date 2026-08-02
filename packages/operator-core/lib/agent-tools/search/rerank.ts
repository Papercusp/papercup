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

/**
 * Over-fetch factor: how many candidates to RETRIEVE per requested result.
 *
 * A reranker can only reorder what retrieval handed it, so reranking an
 * already-sliced page is nearly pointless — it can shuffle the page but can
 * never pull a buried hit INTO it. Retrieving `limit * RERANK_OVERFETCH` and
 * letting the reranker choose the final `limit` is what makes Stage B worth
 * paying for at all.
 */
export const RERANK_OVERFETCH = 4;

/**
 * Hard ceiling on candidates scored per query.
 *
 * MEASURED (P-001 spike, 2026-08-01, gte-reranker-modernbert-base @ q8, pinned
 * to 4 cores): ~45ms per query/document pair, and it does NOT improve with more
 * cores (4 pinned cores matched a 128-core box under load 136). So cost is
 * linear in candidates with no parallelism escape hatch, and the cap — not the
 * multiplier — is what bounds worst-case latency.
 *
 * Both prose search tools default to `limit` 5 (max 20). Without a cap, a
 * `limit: 20` call would rerank 80 pairs ≈ 3.6s. At 24 the worst case is
 * ≈ 1.1s while the common `limit: 5` path still gets a full 4× pool.
 */
export const RERANK_MAX_CANDIDATES = 24;

/**
 * How many hits to RETRIEVE so the reranker has a real pool to choose from.
 * Never returns fewer than `limit` (an over-fetch must never under-fetch).
 */
export function rerankCandidateCount(limit: number): number {
  return Math.max(limit, Math.min(limit * RERANK_OVERFETCH, RERANK_MAX_CANDIDATES));
}

/**
 * The text a cross-encoder should score against the query.
 *
 * ⚠ NOT `hit.excerpt`. In `sources.ts`, `excerpt` is `trunc(body)` — literally
 * `body.slice(0, 200)`, the first 200 characters of the document — while the
 * MATCH-CENTRED text (`ts_headline`, up to 2 fragments around the query terms)
 * lands in a separate `highlight` field that the rerank path never read.
 *
 * Scoring the excerpt therefore asks the cross-encoder "is this document's
 * OPENING about the query?" — which for any document whose relevant passage is
 * not in its first 200 chars is the wrong question, and it silently demotes
 * exactly the long documents a reranker is most useful for.
 *
 * So: lead with the matched fragments (marker tags stripped — `<mark>` is a
 * rendering concern and would just be tokenizer noise), then append the opening
 * for topical context when it adds anything. Both fields are already on every
 * `SearchHit`, so this costs no extra retrieval.
 */
export function rerankText(hit: SearchHit): string {
  const highlight = (hit.highlight ?? '').replace(/<\/?mark>/g, '').trim();
  const excerpt = (hit.excerpt ?? '').trim();
  if (!highlight) return excerpt;
  if (!excerpt || highlight.includes(excerpt) || excerpt.includes(highlight)) return highlight;
  return `${highlight} … ${excerpt}`;
}

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
 * `hits` is the OVER-FETCHED candidate pool from `@papercusp/search` — size the
 * retrieval call with `rerankCandidateCount(limit)`, not `limit`. This reorders
 * that pool and slices to `limit`, so the reranker can pull a buried hit INTO
 * the page instead of only shuffling a page retrieval already chose.
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
        text: rerankText(hit), // match-centred text, NOT the head-of-doc excerpt
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
