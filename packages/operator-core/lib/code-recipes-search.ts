/**
 * code-recipes-search.ts — hybrid dedup/search over `harness_shared.code_recipes`
 * (code-recipes-2026-06-21 Phase 2, P-004 / P-011 / D-009).
 *
 * A recipe SearchSource that RIDES @papercusp/search (no new search engine):
 *   - bm25 leg  — `title_tsv` (the migration-349 GENERATED tsvector over
 *     title+description), `ts_rank_cd` like every search/sources.ts surface.
 *   - embedding leg — cosine over the `embedding vector(384)` column
 *     (`embedding <=> qVec::vector`), 1 - distance as the similarity.
 * Both legs are GLOBAL — recipes are a fleet-wide capability (P-001, reversing the
 * D-005 hive-scoping); the SearchSource still receives workspaceId/scopeFilter from
 * the @papercusp/search engine API but ignores them. Each leg degrades-on-error
 * inside runHybridSearch (a missing index / absent embedding column logs + skips,
 * never throws). This mirrors sources.ts EXACTLY.
 *
 * `searchSimilarRecipes` fuses that hybrid (lexical + cosine) read with a
 * STRUCTURAL signal — Jaccard overlap of the candidate's `tools_used` against
 * the new script's tool-set — so a recipe that calls the SAME tools is boosted
 * above one that merely shares words. Pure ranked READ (D-003: dedup is SOFT,
 * never a block); the caller surfaces the top-N in the code:run result and the
 * LLM decides reuse-vs-proceed.
 *
 * Transport-agnostic: takes the `sql` handle (the code:run capture path's
 * workspace-resolved getOrgPg() connection, or a testcontainer handle).
 *
 * Server-only.
 */
import type postgres from 'postgres';
import { runHybridSearch, type SearchSource, type SearchSourceParams, type Listing } from '@papercusp/search';

/**
 * EI-9312: bound the ACTUAL per-query embed call, not just the embedder's
 * ACQUISITION. `recipes:search` already bounds resolving WHICH embedder to
 * use (buildQueryEmbedder's acquireBudgetMs, WI-3922) but historically never
 * passed `embedTimeoutMs` to runHybridSearch — so once an embedder was
 * resolved (e.g. a warm local pipeline, or the OpenAI fetch with no client-side
 * timeout), the actual `embedder(query)` invocation ran fully UNBOUNDED inside
 * runHybridSearch, and a slow/hung embed call could still blow the tool's 60s
 * budget (the watchdog-tracked ~4% recipes:search timeout class). Mirrors the
 * acquire budget's default (4s) — plenty for a warm embedder, small next to
 * the 60s tool timeout.
 */
const RECIPE_EMBED_CALL_TIMEOUT_MS = 4000;

const trunc = (s: string): string => s.slice(0, 200) + (s.length > 200 ? '…' : '');

/**
 * The `code_recipes` SearchSource — GLOBAL (recipes are a fleet-wide capability,
 * P-001). The engine still hands it workspaceId/scopeFilter but it does not filter
 * on them. Both legs carry id/title/description/run_count/tools_used in the row
 * payload so the caller can blend + return them without a second read.
 */
export const codeRecipesSource: SearchSource = {
  name: 'code_recipes',
  async bm25({ sql, query, limit }: SearchSourceParams): Promise<Listing> {
    const rows = (await sql`
      SELECT id, title, description, run_count, tools_used,
             ts_rank_cd(title_tsv, plainto_tsquery('english', ${query})) AS rank
        FROM harness_shared.code_recipes
       WHERE status = 'active'
         AND title_tsv @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC LIMIT ${limit}
    `) as unknown as Array<{ id: string; title: string; description: string; run_count: number | string; tools_used: string[] | null; rank: number }>;
    return rows.map((r) => ({
      key: `code_recipes:${r.id}`,
      score: r.rank,
      row: {
        source: 'code_recipes',
        source_id: r.id,
        excerpt: trunc(`${r.title} — ${r.description}`),
        highlight: r.title,
        score: r.rank,
        rankers: ['bm25'],
      },
    }));
  },
  async embedding({ sql, limit, qVec }): Promise<Listing> {
    const rows = (await sql`
      SELECT id, title, description, run_count, tools_used,
             1 - (embedding <=> ${qVec}::vector) AS sim
        FROM harness_shared.code_recipes
       WHERE status = 'active'
         AND embedding IS NOT NULL
    ORDER BY embedding <=> ${qVec}::vector
       LIMIT ${limit}
    `) as unknown as Array<{ id: string; title: string; description: string; run_count: number | string; tools_used: string[] | null; sim: number }>;
    return rows.map((r) => ({
      key: `code_recipes:${r.id}`,
      score: r.sim,
      row: {
        source: 'code_recipes',
        source_id: r.id,
        excerpt: trunc(`${r.title} — ${r.description}`),
        highlight: r.title,
        score: r.sim,
        rankers: ['embeddings'],
      },
    }));
  },
};

export interface SimilarRecipe {
  id: string;
  title: string;
  description: string;
  runCount: number;
  /** The recipe's canonical tool-set — carried so callers can gate low-value (≤1-tool)
   *  recipes out of the reuse surfaces (recipes-reuse-activation-2026-06-22 P-004). */
  toolsUsed: string[];
  /** Blended 0..1 similarity (fused hybrid score normalized + tool-set Jaccard). */
  similarity: number;
}

export interface SearchSimilarRecipesInput {
  title: string;
  description: string;
  /** The new script's canonical tool-set (the structural-overlap signal). */
  toolsUsed: string[];
  /** Pre-computed title+description embedding (384-dim), or null when unavailable. */
  embedding: number[] | null;
  /** Exclude this recipe id (the just-upserted recipe must not match itself). */
  excludeId?: string;
  /** Top-N to return (default 5). */
  limit?: number;
}

/** Jaccard overlap of two tool-sets — |A∩B| / |A∪B|, 0 when both empty. */
function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setB = new Set(b);
  let inter = 0;
  const union = new Set<string>(a);
  for (const t of b) union.add(t);
  for (const t of new Set(a)) if (setB.has(t)) inter++;
  return union.size === 0 ? 0 : inter / union.size;
}

/**
 * Rank prior recipes similar to a (new) recipe over the hybrid hybrid engine,
 * blended with a structural tool-set-overlap signal. SOFT — purely a ranked
 * read; failure-free is the caller's contract, but this fn itself never throws
 * on a search-leg error (runHybridSearch try/catches each source).
 *
 * Blend: the fused RRF score (lexical + cosine) is normalized to 0..1 against
 * the top hit in this result set, then averaged with the per-candidate Jaccard
 * tool-set overlap — `similarity = (normalizedFused + jaccard) / 2`. A recipe
 * that BOTH reads as semantically close AND calls the same tools scores highest;
 * a pure word-match with a disjoint tool-set is damped, and a structural twin
 * with low lexical overlap is lifted. Re-sorts by the blended score, top-N.
 */
export async function searchSimilarRecipes(
  sql: postgres.Sql,
  input: SearchSimilarRecipesInput,
  deps: { embedder?: ((text: string) => Promise<number[]>) | null; log?: (msg: string) => void } = {},
): Promise<SimilarRecipe[]> {
  const limit = input.limit ?? 5;
  const query = `${input.title}\n${input.description}`;

  // Feed the PRE-COMPUTED embedding straight through as a one-shot embedder so
  // runHybridSearch reuses it (no second embed of the same text) — the cosine
  // leg still runs even when no live embedder was wired, as long as the caller
  // computed the vector once for the upsert.
  const embedder =
    input.embedding && input.embedding.length > 0
      ? async () => input.embedding as number[]
      : (deps.embedder ?? null);

  // Over-fetch so the exclude + structural re-rank have headroom before top-N.
  const { results } = await runHybridSearch([codeRecipesSource], {
    sql,
    query,
    // recipes are global (P-001): the engine requires a workspaceId/scopeFilter but
    // codeRecipesSource ignores them — pass non-filtering placeholders.
    workspaceId: '',
    scopeFilter: null,
    limit: limit + (input.excludeId ? 1 : 0) + 5,
    mode: 'hybrid',
    embedder,
    embedTimeoutMs: RECIPE_EMBED_CALL_TIMEOUT_MS,
    log: deps.log,
  });

  // Pull the candidates' canonical fields + tools_used in ONE batched read —
  // the neutral SearchHit row intentionally doesn't carry tools_used / run_count
  // through @papercusp/search's schema-agnostic shape.
  const ids = results.map((r) => r.source_id).filter((id) => id !== input.excludeId);
  if (ids.length === 0) return [];
  const metaRows = (await sql`
    SELECT id, title, description, run_count, tools_used
      FROM harness_shared.code_recipes
     WHERE id = ANY(${ids})
  `) as unknown as Array<{
    id: string;
    title: string;
    description: string;
    run_count: number | string;
    tools_used: string[] | null;
  }>;
  const metaById = new Map(metaRows.map((m) => [m.id, m]));

  const maxFused = Math.max(...results.map((r) => r.score), 1e-9);

  const blended: SimilarRecipe[] = [];
  for (const hit of results) {
    if (hit.source_id === input.excludeId) continue;
    const meta = metaById.get(hit.source_id);
    if (!meta) continue; // dropped between search + meta read (e.g. retired)
    const normalizedFused = maxFused > 0 ? hit.score / maxFused : 0;
    const overlap = jaccard(input.toolsUsed, meta.tools_used ?? []);
    const similarity = (normalizedFused + overlap) / 2;
    blended.push({
      id: meta.id,
      title: meta.title,
      description: meta.description,
      runCount: typeof meta.run_count === 'number' ? meta.run_count : parseInt(meta.run_count, 10),
      toolsUsed: meta.tools_used ?? [],
      similarity,
    });
  }

  blended.sort((a, b) => b.similarity - a.similarity);
  return blended.slice(0, limit);
}
