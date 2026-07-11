/**
 * semantic-novelty-leg — the P-017 hybrid embedding leg for corpusNovelty
 * (su-ideate-learning-substrate-2026-07-10, D-016).
 *
 * `corpusNovelty` (critique-core) is a PURE, deterministic, network-free matcher
 * (lexical token-set Jaccard). The 2026-07-10 dupe-storm class — a re-worded
 * re-encounter the lexical matcher misses because no tokens overlap — needs a
 * semantic-neighbour signal. This leg is the IMPURE half: it embeds the query text
 * (doc↔doc space, the SAME `resolveBackfillEmbedder` the ledger is stored under —
 * the sibling choice P-008's work-item dupe guard and plans/semantic-dedup made),
 * resolves each corpus prior's stored vector JOIN-WISE with NO new storage —
 * plan priors ('plan:<slug>') from the migration-553 harness_plans vectors,
 * idea/improvement priors ('wi:<id>' routedRefs) from the migration-551 work_items
 * vectors — and computes cosine IN PG. It returns a per-ref cosine map the pure
 * core blends as `max(lexical, cosine)`. Decision priors ('<slug>#<id>') and any
 * other ref shape have no stored vector and stay lexical-only.
 *
 * FAIL-OPEN is the prime directive (D-016): any embedder error/timeout, a disabled
 * embedder, a dims mismatch (harrier@1024 ≠ the vector(384) columns), a missing
 * migration, or the budget expiring all return null — the caller falls back to
 * pure lexical. Kill switch: PAPERCUSP_SU_SEMANTIC_NOVELTY=off. VITEST-inert unless
 * deps are injected (the real resolver lazy-loads an ONNX model — the WI-3792
 * load-scar class).
 */
import { getOrgPg } from '@papercusp/db-org';

import {
  corpusNovelty,
  type CorpusEntry,
  type CorpusNovelty,
  type CorpusNoveltyOptions,
} from './critique-core';

/** Width of the migration-551/553 embedding columns (= embed-backfill's EMBEDDER_DIM). */
const EMBED_DIM = 384;
/** Whole-leg budget (embed + both join queries). A warm sidecar answers in ~10ms;
 *  a cold in-process model load (~2.8s) simply forfeits THIS pass's semantic leg. */
const BUDGET_MS = 2500;

/** Per-corpus-ref cosine similarity [0,1] in the active embedding space. */
export type SemanticSimByRef = Map<string, number>;

/** Injectable seams (tests + any future non-backfill space). */
export interface SemanticNoveltyDeps {
  resolveEmbedder: () => Promise<
    | { mode: string; dims: number; embed: (t: string) => Promise<number[]> }
    | { mode: 'disabled'; reason?: string }
    | null
  >;
  /** plan_slug → cosine similarity for the slugs that HAVE a vector in `mode`'s space. */
  queryPlanSims: (vec: number[], mode: string, slugs: string[]) => Promise<Map<string, number>>;
  /** feature_id → cosine similarity for the ids that HAVE a vector in `mode`'s space. */
  queryWorkItemSims: (vec: number[], mode: string, ids: string[]) => Promise<Map<string, number>>;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Resolve-null on timeout, never reject — the budget IS the fail-open. */
function withBudget<T>(ms: number, p: Promise<T | null>): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    (t as unknown as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

async function queryPlanSimsReal(vec: number[], mode: string, slugs: string[]): Promise<Map<string, number>> {
  if (slugs.length === 0) return new Map();
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  // Workspace-global on purpose — the novelty corpus is workspace-global (D-003),
  // so the vector join mirrors readNoveltyCorpus's own unscoped plan read.
  const rows = await sql<Array<{ plan_slug: string; similarity: number }>>`
    SELECT plan_slug, 1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.harness_plans
     WHERE plan_slug = ANY(${slugs})
       AND embedding IS NOT NULL
       AND embedding_mode = ${mode}`;
  return new Map(rows.map((r) => [r.plan_slug, Number(r.similarity)]));
}

async function queryWorkItemSimsReal(vec: number[], mode: string, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const { sql } = getOrgPg();
  const vecLit = `[${vec.join(',')}]`;
  // migration 374 unified issues + features into harness_shared.work_items; migration
  // 551's embedding columns live on that base. feature_id is the stable id the routed
  // ledger's 'wi:<id>' refs point at.
  const rows = await sql<Array<{ id: string; similarity: number }>>`
    SELECT feature_id AS id, 1 - (embedding <=> ${vecLit}::vector) AS similarity
      FROM harness_shared.work_items
     WHERE feature_id = ANY(${ids})
       AND embedding IS NOT NULL
       AND embedding_mode = ${mode}`;
  return new Map(rows.map((r) => [r.id, Number(r.similarity)]));
}

const realDeps: SemanticNoveltyDeps = {
  // The DOCUMENT-side resolver the backfill sweep stores with — the one seam that
  // guarantees the query text and the stored ledger share space AND prompt.
  resolveEmbedder: async () => (await import('../search/embed-backfill')).resolveBackfillEmbedder(),
  queryPlanSims: queryPlanSimsReal,
  queryWorkItemSims: queryWorkItemSimsReal,
};

/**
 * Split corpus refs by their stored-vector source (readNoveltyCorpus ref conventions):
 * 'plan:<slug>' → migration-553 harness_plans; 'wi:<id>' → migration-551 work_items.
 * Decisions ('<slug>#<id>') and any other ref have no stored vector → lexical-only.
 * Returns each key's original ref list so the resolved sim is keyed back by ref.
 */
function partitionRefs(corpus: readonly CorpusEntry[]): {
  planSlugToRefs: Map<string, string[]>;
  wiIdToRefs: Map<string, string[]>;
} {
  const planSlugToRefs = new Map<string, string[]>();
  const wiIdToRefs = new Map<string, string[]>();
  const add = (m: Map<string, string[]>, key: string, ref: string): void => {
    const cur = m.get(key);
    if (cur) cur.push(ref);
    else m.set(key, [ref]);
  };
  for (const e of corpus) {
    if (e.ref.startsWith('plan:')) add(planSlugToRefs, e.ref.slice('plan:'.length), e.ref);
    else if (e.ref.startsWith('wi:')) add(wiIdToRefs, e.ref.slice('wi:'.length), e.ref);
  }
  return { planSlugToRefs, wiIdToRefs };
}

async function resolveSims(
  text: string,
  corpus: readonly CorpusEntry[],
  deps: SemanticNoveltyDeps,
): Promise<SemanticSimByRef | null> {
  const { planSlugToRefs, wiIdToRefs } = partitionRefs(corpus);
  if (planSlugToRefs.size === 0 && wiIdToRefs.size === 0) return null;
  const resolved = await deps.resolveEmbedder();
  if (!resolved || resolved.mode === 'disabled' || !('embed' in resolved)) return null;
  if (resolved.dims !== EMBED_DIM) return null; // harrier@1024 — no vector(384) verdict possible
  const vec = await resolved.embed(text.slice(0, 2000));
  if (vec.length !== EMBED_DIM) return null;
  const [planSims, wiSims] = await Promise.all([
    deps.queryPlanSims(vec, resolved.mode, [...planSlugToRefs.keys()]),
    deps.queryWorkItemSims(vec, resolved.mode, [...wiIdToRefs.keys()]),
  ]);
  const out: SemanticSimByRef = new Map();
  for (const [slug, refs] of planSlugToRefs) {
    const s = planSims.get(slug);
    if (typeof s === 'number') for (const ref of refs) out.set(ref, clamp01(round2(s)));
  }
  for (const [id, refs] of wiIdToRefs) {
    const s = wiSims.get(id);
    if (typeof s === 'number') for (const ref of refs) out.set(ref, clamp01(round2(s)));
  }
  return out.size > 0 ? out : null;
}

/**
 * Resolve per-corpus-ref cosine similarities for `text` in the active embedding
 * space, JOIN-WISE against stored plan/work-item vectors. Returns null for "no
 * verdict" (disabled / unavailable / dims-mismatch / timeout / errored / nothing
 * resolved) — the caller MUST treat null as "pure lexical".
 */
export async function resolveSemanticNoveltySims(
  text: string,
  corpus: readonly CorpusEntry[],
  deps?: SemanticNoveltyDeps,
): Promise<SemanticSimByRef | null> {
  if (process.env.PAPERCUSP_SU_SEMANTIC_NOVELTY === 'off') return null;
  // Inert under vitest unless a test injects deps: the real resolver lazy-loads an
  // ONNX model, which unrelated tool tests must never pay.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, resolveSims(text, corpus, deps ?? realDeps));
  } catch {
    return null;
  }
}

/**
 * `corpusNovelty` with the P-017 hybrid embedding leg resolved and blended in — the
 * thin async wrapper BOTH novelty callers share (the P-008 su pre-check and the
 * Scout novelty critic), so the impure vector resolution lives in exactly one place
 * and the core stays pure. Resolves the semantic sims FAIL-OPEN, then runs the pure
 * `corpusNovelty`; absent a verdict it is exactly the lexical-only core. An
 * `opts.semanticSimByRef` already present (a test, or a caller holding sims) is
 * used as-is and the leg is skipped.
 */
export async function corpusNoveltyHybrid(
  text: string,
  corpus: readonly CorpusEntry[],
  opts: CorpusNoveltyOptions = {},
  deps?: SemanticNoveltyDeps,
): Promise<CorpusNovelty> {
  const semanticSimByRef =
    opts.semanticSimByRef ?? (await resolveSemanticNoveltySims(text, corpus, deps)) ?? undefined;
  return corpusNovelty(text, corpus, { ...opts, semanticSimByRef });
}
