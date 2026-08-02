/**
 * Stage-B rerank — the operator's reranker seam over `@papercusp/search`'s
 * RRF-fused output. `@papercusp/search` does Stage A (BM25 + pgvector → RRF)
 * and stops there; this adds a cross-encoder relevance reorder (via
 * `@papercusp/search-core` → `@papercusp/rerank`) so the most relevant hits
 * rise to the top of the page. Adopted from Restart's search-core
 * (search-core-papercup-adoption-2026-05-30).
 *
 * ENGINE (plan local-reranker-gte-modernbert-2026-08-02, P-007). This seam used
 * to be dark: with no ZeroEntropy key — the common case, and the only case on a
 * desktop install — it returned the RRF order untouched, so Stage B never ran
 * for anyone. It now defaults to the LOCAL cross-encoder
 * (gte-reranker-modernbert-base, ~150M), which needs no credential and no
 * network: served by the shared embed sidecar when the host runs one (one warm
 * model for the whole box, `/rerank` beside `/embed`), in-process where none is
 * configured. A configured ZeroEntropy key still wins — adding a credential is
 * an explicit act and hosted zerank-2 is the stronger model.
 *
 * Engine selection lives in `resolveProseRerankEngine` alone, so adding the
 * self-hosted zerank-2 (Apache-2.0, 4B) on the GPU host later is one more
 * branch there, not another rewrite of `rerankProseHits`.
 *
 * FLAGS.LOCAL_RERANK (default ON) gates the LOCAL engine only — turning it off
 * restores the pre-P-007 behavior exactly: hosted when a key is configured, RRF
 * passthrough otherwise. It is read per query, not latched at import, so a flip
 * in /admin/features takes effect without restarting the operator.
 *
 * Fail-safe by construction — a rerank outage degrades to retrieval (RRF)
 * order, it never breaks search. Note the two halves are deliberately not in
 * tension: the sidecar client THROWS when a configured sidecar is sick (so the
 * sickness is visible rather than silently absorbed by loading a duplicate
 * model per process), and `@papercusp/rerank`'s single fail-safe seam converts
 * that throw into "keep retrieval order" one layer up. Anything else that can
 * go wrong here — the lib failing to import, the credential read throwing,
 * the sidecar refusing to spawn — lands in the same passthrough below.
 *
 * Domain note: search-core's instruction / LLM-category-match / query-rewrite
 * stages default to e-commerce (Restart sells laptops) and do NOT transfer to
 * agent-memory search — so we use the pure cross-encoder rerank only (no
 * `instruction`, no `llm`). The only tiebreak is the fused RRF/BM25 score, kept
 * within a rerank-score bucket. If we later want instruction-following, pass
 * our OWN agent-memory prompts (never search-core's e-commerce defaults).
 */

import type { RerankScoreFn } from '@papercusp/rerank';
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
 * Wall-clock budget for the whole rerank stage of a prose search. On expiry the
 * page degrades to RRF order through @papercusp/rerank's single fail-safe seam
 * — the same path as an engine outage, so search never throws and never stalls.
 *
 * SIZED FROM THE MEASUREMENT, not guessed. At the {@link RERANK_MAX_CANDIDATES}
 * cap the worst case is 24 × ~45ms ≈ 1.1s on this box, and P-001 found a laptop
 * runs ~1.5–2× slower ⇒ ≈ 2.2s. 4s leaves ~1.8× headroom over that worst case,
 * so a HEALTHY rerank — even a slow laptop at the cap — never trips it, and only
 * genuine pathology does.
 *
 * DELIBERATELY TIGHTER than the library backstop (20s) and than the sidecar
 * client's 15s retry budget, because those bound a HANG while this bounds a
 * user's wait. A search that has already spent 4s reranking has failed its
 * latency contract regardless of whether the sidecar might still recover.
 *
 * ⚠ ACCEPTED TRADEOFF: an in-process COLD START (first query in a fresh process
 * loads a ~150M model) can exceed this, so that first search returns RRF order
 * and later ones rerank normally. That is the correct failure direction —
 * correct results slightly less well ordered, rather than a multi-second stall
 * on someone's first search. It does not arise in the intended deployment,
 * where the sidecar holds the model warm across processes.
 */
export const PROSE_RERANK_TIMEOUT_MS = 4_000;

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

let localScorerPromise: Promise<RerankScoreFn> | null = null;

/**
 * The local cross-encoder scorer, built ONCE per process.
 *
 * Memoized rather than rebuilt per query for two reasons, only the first of
 * which is cost: building it resolves — and on an opted-in host may SPAWN —
 * the shared sidecar; and the client it returns carries the sidecar's up/down
 * transition state, so a fresh client per query would report every outage as
 * brand new and could never report the recovery.
 *
 * A FAILED build is never cached (same rule as the query-embed cache): a
 * transient spawn failure must not disable reranking for the life of the
 * process.
 */
function localRerankScorer(): Promise<RerankScoreFn> {
  if (!localScorerPromise) {
    localScorerPromise = import('../../memory/embed-sidecar-wiring')
      .then((m) => m.buildSidecarAwareReranker())
      .catch((err) => {
        localScorerPromise = null;
        throw err;
      });
  }
  return localScorerPromise;
}

/** Test seam: drop the memoized scorer so a test can rebuild it. */
export function _resetLocalRerankScorerForTests(): void {
  localScorerPromise = null;
}

/**
 * Which engine scores this query, and what it needs to run.
 *
 * The ONE place engine selection lives — see the header note. Hosted wins when
 * a key is configured; otherwise the local cross-encoder, which needs no
 * credential.
 *
 * `null` means "score nothing, keep the RRF order" — reachable only when
 * FLAGS.LOCAL_RERANK is OFF and no hosted key is configured, which is exactly
 * the pre-P-007 dark seam this flag can restore.
 */
type ResolvedRerankEngine =
  | { engine: 'zeroentropy'; apiKey: string }
  | { engine: 'local'; scorer: RerankScoreFn };

/**
 * Is the local engine allowed? Read per query, never latched at module load:
 * a flag flipped in /admin/features must take effect without restarting the
 * operator, and latching at import time would pin whatever was true at boot.
 *
 * Fails OPEN (the flag's default) rather than closed: a flag-backend outage
 * must not silently switch reranking off across the fleet, which would look
 * exactly like the reranker being broken.
 */
async function localRerankEnabled(): Promise<boolean> {
  try {
    const [{ FLAGS }, { getFlag }] = await Promise.all([
      import('@papercusp/flags'),
      import('@papercusp/flags/server'),
    ]);
    return await getFlag(FLAGS.LOCAL_RERANK, 'system:search-rerank');
  } catch {
    return true;
  }
}

async function resolveProseRerankEngine(): Promise<ResolvedRerankEngine | null> {
  const apiKey = await rerankApiKey();
  if (apiKey) return { engine: 'zeroentropy', apiKey };
  if (!(await localRerankEnabled())) return null;
  return { engine: 'local', scorer: await localRerankScorer() };
}

/**
 * Rerank fused prose hits with the cross-encoder, returning them in the new
 * relevance order, sliced to `limit`. Degrades to the RRF order (sliced to
 * `limit`) whenever the engine can't score.
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
  // Nothing to reorder → no engine resolution, no rerank import.
  if (hits.length <= 1) return hits.slice(0, limit);

  try {
    const resolved = await resolveProseRerankEngine();
    // Local engine flagged off and no hosted key → the pre-P-007 dark seam.
    if (!resolved) return hits.slice(0, limit);
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
        // Bound the stage so a sick engine degrades the page instead of
        // stalling it (the lib's 20s backstop is a hang guard, not a UX budget).
        rerankTimeoutMs: PROSE_RERANK_TIMEOUT_MS,
        ...(resolved.engine === 'zeroentropy'
          ? { rerankApiKey: resolved.apiKey }
          : { engine: 'local' as const, scorer: resolved.scorer }),
        // Generic relevance rerank: no e-commerce instruction / LLM pass.
        // Within a rerank-score bucket, keep the higher RRF/BM25 hit first.
        qualityScore: (hit) => hit.score,
      },
    );
  } catch {
    // Engine unresolvable, lib/dep unavailable, or a throw that got past the
    // lib's own fail-safe seam → RRF passthrough. Search never breaks here.
    return hits.slice(0, limit);
  }
}
