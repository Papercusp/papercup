/**
 * tool-find — hybrid (lexical + semantic) search over the tool catalog. The
 * intent-aware upgrade to the lexical-only `searchTools` (tools-search.ts) and
 * to omp's keyword-only `search_tool_bm25`: it matches by MEANING, so
 * "feature flag" finds `flags:*` and "spawn a worker" finds `cup:spawn` even
 * when the query words don't lexically appear in the tool text. Unlike omp's
 * native search it is operator-side, so it works for Claude/Codex too.
 * (tool-discovery-for-weak-models-2026-06-30 WS3.)
 *
 * Fusion is **floored-union, NOT plain RRF**. tools-search.ts deliberately
 * avoids RRF because for tools an exact/prefix NAME match must ALWAYS outrank a
 * semantically-similar sibling (you don't want `coord:orient` buried under
 * `coord:glance`). So:
 *   - the LEXICAL leg is authoritative — its ranked hits are admitted in order, on top;
 *   - the SEMANTIC leg BROADENS recall — it contributes only entries the lexical
 *     leg missed (intent→tool when keywords don't overlap), appended below,
 *     ranked by cosine and gated by a minimum-similarity floor.
 *
 * The embedder + corpus embeddings are INJECTED (a one-time boot index over the
 * ~551-tool catalog). With neither, it degrades gracefully to lexical-only — the
 * exact behavior of `searchTools` — so the tool is always functional.
 *
 * Pure + unit-testable; the route/tool wiring does the IO (corpus assembly via
 * `collectToolMeta`/`resolveToolEntries`, embeddings via `buildQueryEmbedder`).
 */
import type { ToolDiscoveryEntry } from './tools-discovery';
import { searchTools } from './tools-search';

export type Embedder = (text: string) => Promise<number[]>;

/** Cosine similarity of two equal-length vectors. Returns 0 for degenerate input. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface ToolFindHit {
  /** Tool MCP name, e.g. `flags:set`. */
  tool: string;
  description: string | null;
  /** Compact arg-schema text (`key:type description; …`); null for a no-arg tool. */
  argSchema: string | null;
  category: string;
  /** Which leg(s) surfaced it. */
  via: 'lexical' | 'semantic' | 'both';
  /** Cosine for a semantic/both hit (for debugging / threshold tuning); null for lexical-only. */
  cosine: number | null;
}

export interface ToolFindOptions {
  /** Max results (default 10). */
  limit?: number;
  /** Query embedder. Absent/null → lexical-only (graceful degrade). */
  embedder?: Embedder | null;
  /** Precomputed corpus embeddings keyed by tool name (the boot index). Absent → lexical-only. */
  embeddings?: ReadonlyMap<string, readonly number[]> | null;
  /** Minimum cosine to admit a SEMANTIC-only hit (default 0.35). The floor in floored-union. */
  minCosine?: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_COSINE = 0.35;

/**
 * High-confidence symptom → decisive first-read routing. Semantic similarity is
 * excellent for recall but cannot promise the causal-chain tool outranks every
 * detail surface. These rules cover recurring incident language where the
 * platform already has one authoritative first read. An explicit `group:verb`
 * in the query always wins through the normal exact-name lexical ranking.
 */
export function decisiveToolForSymptom(query: string): string | null {
  const q = query.trim().toLowerCase();
  if (/[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*/i.test(q)) return null;
  if (/connection refused|service (?:is )?(?:down|unreachable)|process (?:is )?running but no window|app (?:will not|won't) open/.test(q)) {
    return 'dev:service_health';
  }
  if (
    /why (?:is|are).*(?:slow|stalled|stuck|queued|not shipping|not deploying)|(?:agents?|turns?|runs?).*(?:slow|queued|stalling)|capacity crunch|out of (?:quota|capacity)|rate limit|\b429\b/.test(q)
  ) {
    return 'dev:why';
  }
  // WI-6524: "is my change live yet" is the single most common liveness question
  // on this platform (CLAUDE.md names dev:pipeline_position as ITS answer) but the
  // phrasing itself semantically ranked the tool ~13th, behind unrelated detail
  // surfaces — because none of those detail tools are wrong exactly, just not the
  // one authoritative first read. Route it decisively, same as the other symptoms.
  if (
    /is (?:my|this|the) (?:change|edit|fix|code|commit|pr)\b[^?]*\b(?:live|deployed|shipped)\b|has (?:my|this|the) (?:change|edit|fix|code|commit) (?:shipped|deployed|landed|reached)|when will (?:my|this) change (?:be live|deploy)|not (?:yet )?(?:live|deployed) on (?:the )?(?:running )?server|which sha is (?:live|deployed|running)/.test(
      q,
    )
  ) {
    return 'dev:pipeline_position';
  }
  // WI-6524: the staleness-check side of the same gap — "is this value stale" is
  // exactly what a registered state cell exists to answer, but the phrasing (as
  // opposed to the surface's own vocabulary, "read a registered state cell")
  // matched nothing in the top 25.
  if (
    /(?:check|verify|confirm) (?:whether|if) .*\bis stale\b|\b(?:is|was) (?:this|that|the) value (?:i (?:was given|have|received)|stale)\b|stale (?:value|read|data) check/.test(
      q,
    )
  ) {
    return 'state:read';
  }
  return null;
}

function entryHit(e: ToolDiscoveryEntry, via: ToolFindHit['via'], cosine: number | null): ToolFindHit {
  return {
    tool: e.tool,
    description: e.description ?? null,
    argSchema: e.argSchema ?? null,
    category: e.category,
    via,
    cosine,
  };
}

/**
 * Hybrid search. Returns up to `limit` hits, lexical-authoritative with the
 * semantic leg broadening recall underneath (floored-union — see file head).
 */
export async function findTools(
  corpus: readonly ToolDiscoveryEntry[],
  query: string,
  opts: ToolFindOptions = {},
): Promise<ToolFindHit[]> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
  const minCosine = opts.minCosine ?? DEFAULT_MIN_COSINE;

  // 1. Lexical leg — authoritative. Over-fetch so its ranking survives the cap.
  const lexical = searchTools(corpus, query, { limit: limit * 3 });
  const lexicalNames = new Set(lexical.map((e) => e.tool));

  // 2. Semantic leg — only when an embedder + corpus index are present.
  const cosByName = new Map<string, number>();
  if (opts.embedder && opts.embeddings && opts.embeddings.size > 0 && query.trim()) {
    let qv: number[] | null = null;
    try {
      qv = await opts.embedder(query);
    } catch {
      qv = null; // embedder failure → lexical-only (graceful)
    }
    if (qv && qv.length > 0) {
      const byName = new Map(corpus.map((e) => [e.tool, e]));
      for (const [name, vec] of opts.embeddings) {
        if (!byName.has(name)) continue;
        const c = cosineSimilarity(qv, vec);
        if (c >= minCosine) cosByName.set(name, c);
      }
    }
  }

  // 3. Floored-union: lexical hits first (in their rank), annotated `both` when
  //    the semantic leg also liked them; then semantic-only hits by descending
  //    cosine. Dedup by tool name. Truncate to `limit`.
  const out: ToolFindHit[] = [];
  for (const e of lexical) {
    const c = cosByName.get(e.tool);
    out.push(entryHit(e, c != null ? 'both' : 'lexical', c ?? null));
    if (out.length >= limit) break;
  }
  const byName = new Map(corpus.map((e) => [e.tool, e]));
  if (out.length < limit) {
    const semanticOnly = [...cosByName.entries()]
      .filter(([name]) => !lexicalNames.has(name))
      .sort((a, b) => b[1] - a[1]);
    for (const [name, c] of semanticOnly) {
      const e = byName.get(name);
      if (!e) continue;
      out.push(entryHit(e, 'semantic', c));
      if (out.length >= limit) break;
    }
  }

  const decisive = decisiveToolForSymptom(query);
  const decisiveEntry = decisive ? byName.get(decisive) : undefined;
  if (decisiveEntry) {
    const existing = out.find((hit) => hit.tool === decisive);
    const routed = existing ?? entryHit(decisiveEntry, 'lexical', cosByName.get(decisive) ?? null);
    return [routed, ...out.filter((hit) => hit.tool !== decisive)].slice(0, limit);
  }
  return out.slice(0, limit);
}
