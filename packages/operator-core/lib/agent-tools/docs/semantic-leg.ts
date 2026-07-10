/**
 * semantic-leg — the P-009 docs:search embedding leg
 * (shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Ranks the query vector against migration-552 doc_sections (text synced by
 * search/doc-embed-sync.ts, vectors filled by the embed-backfill sweep) in the
 * ACTIVE embedding space only (`embedding_mode = <active>` — cosine across
 * spaces is noise), dedupes to the best section per page, and returns
 * page-level hits the handler appends AFTER the lexical results.
 *
 * FAIL-OPEN is the prime directive: no embedder, migration 552 absent, dims
 * mismatch (harrier@1024 vs vector(384)), or any throw returns null and
 * docs:search stays lexical-only. Under vitest the leg is inert unless deps
 * are injected (the real resolver lazy-loads an ONNX model — the WI-3792
 * load-scar class).
 */

import { getOrgPg } from '@papercusp/db-org';

/** Width of the migration-552 embedding column (= embed-backfill's EMBEDDER_DIM). */
const EMBED_DIM = 384;
/** Over-fetch factor: several sections of one page can crowd the top-k; fetch
 *  extra rows so page-level dedupe still fills `limit` distinct pages. */
const OVERFETCH = 3;

export interface DocSemanticHit {
  slug: string;
  url: string;
  title: string;
  /** Best-matching section's anchor ('' = page preamble). */
  anchor: string;
  /** Cosine similarity (1 − pgvector `<=>` distance) in the active space. */
  similarity: number;
  excerpt: string;
}

/** Injectable seams (tests + any future non-552 store). */
export interface DocSemanticDeps {
  resolveEmbedder: () => Promise<{ mode: string; dims: number; embed: (t: string) => Promise<number[]> } | null>;
  querySections: (vec: number[], mode: string, sourceKey: string, limit: number) => Promise<DocSemanticHit[]>;
}

async function querySectionsReal(vec: number[], mode: string, sourceKey: string, limit: number): Promise<DocSemanticHit[]> {
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  const rows = await sql<
    Array<{ slug: string; anchor: string; title: string; url: string; excerpt: string; similarity: number }>
  >`
    SELECT slug, anchor, title, url, left(content, 240) AS excerpt,
           1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.doc_sections
     WHERE source_key = ${sourceKey}
       AND embedding IS NOT NULL
       AND embedding_mode = ${mode}
     ORDER BY embedding <=> ${vecLit}::vector
     LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, similarity: Number(r.similarity) }));
}

const realDeps: DocSemanticDeps = {
  // QUERY-side resolver (gemma query prompt) — its vectors are trained to
  // match the document-prompt vectors the backfill sweep stores.
  resolveEmbedder: async () => (await import('../search/embedder')).buildQueryEmbedderResolved(),
  querySections: querySectionsReal,
};

/**
 * Top semantic page hits for a query against one docs surface (`sourceKey` =
 * the resolved adapter's name). Returns null for "no verdict" (disabled,
 * unavailable, errored) — the caller MUST treat null as "lexical-only".
 */
export async function semanticDocHits(
  query: string,
  sourceKey: string,
  limit: number,
  deps?: DocSemanticDeps,
): Promise<DocSemanticHit[] | null> {
  if (process.env.VITEST && !deps) return null;
  try {
    const d = deps ?? realDeps;
    const resolved = await d.resolveEmbedder();
    if (!resolved || resolved.dims !== EMBED_DIM) return null;
    const vec = await resolved.embed(query);
    if (vec.length !== EMBED_DIM) return null;
    const rows = await d.querySections(vec, resolved.mode, sourceKey, limit * OVERFETCH);
    // Rows arrive distance-ordered; keep each page's best section.
    const bySlug = new Map<string, DocSemanticHit>();
    for (const r of rows) if (!bySlug.has(r.slug)) bySlug.set(r.slug, r);
    return [...bySlug.values()].slice(0, limit);
  } catch {
    return null;
  }
}
