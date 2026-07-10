/**
 * semantic-dedup — the P-010 plan-store embedding legs
 * (shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * Two consumers of the migration-553 harness_plans embedding columns (vectors
 * filled by the embed-backfill sweep from title + left(content, 2000)):
 *
 *  - `semanticPlanHits` — plans:search's recall-additive leg: cosine top-k in
 *    the ACTIVE space, appended AFTER the lexical hits by the handler.
 *  - `confirmSimilarPlans` — plans:new's similar_exists CONFIRMATION: the
 *    token matcher scores slug+title token overlap only, so topically-adjacent
 *    but distinct efforts false-positive (it flagged this very plan's
 *    creation). A token-flagged candidate whose stored vector is semantically
 *    DISTANT from the proposed plan is dropped from the refusal; a candidate
 *    with NO stored vector (or no verdict at all) is KEPT — both failure
 *    directions preserve today's token-verdict behavior.
 *
 * FAIL-OPEN throughout: no embedder, migration 553 absent, dims mismatch
 * (harrier@1024), or any throw degrades to lexical-only / token-only.
 * VITEST-inert unless deps are injected (the real resolver lazy-loads an ONNX
 * model — the WI-3792 load-scar class).
 */

import { withWorkspace } from '@papercusp/db-org';
import { resolvePlanScope, type PlanSourceOpts } from './source';

/** Width of the migration-553 embedding columns (= embed-backfill's EMBEDDER_DIM). */
const EMBED_DIM = 384;
/** Below this cosine similarity a token-flagged candidate is considered a
 *  DIFFERENT effort and cleared from the similar_exists refusal. Calibrated
 *  against the live corpus (P-010 live verify); override via env. */
const DEFAULT_CONFIRM = 0.6;

export function planDupeConfirmThreshold(): number {
  const n = Number(process.env.PAPERCUSP_PLAN_DUPE_CONFIRM);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_CONFIRM;
}

export interface PlanSemanticHit {
  slug: string;
  harness: string;
  title: string | null;
  status: string | null;
  archived: boolean;
  /** Cosine similarity (1 − pgvector `<=>` distance) in the active space. */
  similarity: number;
}

/** Injectable seams (tests + any future non-553 store). */
export interface PlanSemanticDeps {
  resolveEmbedder: () => Promise<{ mode: string; dims: number; embed: (t: string) => Promise<number[]> } | null>;
  /** slug → similarity for the given slugs that HAVE a vector in `mode`'s space. */
  querySimilarities: (vec: number[], mode: string, slugs: string[], opts: PlanSourceOpts) => Promise<Map<string, number>>;
  queryTopPlans: (
    vec: number[],
    mode: string,
    opts: PlanSourceOpts & { includeArchived?: boolean; limit: number },
  ) => Promise<PlanSemanticHit[]>;
}

async function querySimilaritiesReal(
  vec: number[],
  mode: string,
  slugs: string[],
  opts: PlanSourceOpts,
): Promise<Map<string, number>> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const vecLit = `[${vec.join(',')}]`;
  const rows = await withWorkspace(workspaceId, async (tx) => {
    return tx<Array<{ plan_slug: string; similarity: number }>>`
      SELECT plan_slug, 1 - (embedding <=> ${vecLit}::vector) AS similarity
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND plan_slug = ANY(${slugs})
         AND embedding IS NOT NULL
         AND embedding_mode = ${mode}`;
  });
  return new Map(rows.map((r) => [r.plan_slug, Number(r.similarity)]));
}

async function queryTopPlansReal(
  vec: number[],
  mode: string,
  opts: PlanSourceOpts & { includeArchived?: boolean; limit: number },
): Promise<PlanSemanticHit[]> {
  const { workspaceId, harnessSlug } = await resolvePlanScope(opts);
  const vecLit = `[${vec.join(',')}]`;
  const rows = await withWorkspace(workspaceId, async (tx) => {
    const archivedFilter = opts.includeArchived ? tx`` : tx`AND archived = false`;
    return tx<Array<{ plan_slug: string; harness_slug: string; title: string | null; status: string | null; archived: boolean; similarity: number }>>`
      SELECT plan_slug, harness_slug, title, status, archived,
             1 - (embedding <=> ${vecLit}::vector) AS similarity
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         AND embedding IS NOT NULL
         AND embedding_mode = ${mode}
         AND template_slug IS NULL
         ${archivedFilter}
       ORDER BY embedding <=> ${vecLit}::vector
       LIMIT ${opts.limit}`;
  });
  return rows.map((r) => ({
    slug: r.plan_slug,
    harness: r.harness_slug,
    title: r.title,
    status: r.status,
    archived: r.archived,
    similarity: Number(r.similarity),
  }));
}

const realDeps: PlanSemanticDeps = {
  // QUERY-side resolver (gemma query prompt) for search; the stored side is
  // the backfill sweep's document prompt.
  resolveEmbedder: async () => (await import('../search/embedder')).buildQueryEmbedderResolved(),
  querySimilarities: querySimilaritiesReal,
  queryTopPlans: queryTopPlansReal,
};

/**
 * Top semantic plan hits for a query. Returns null for "no verdict"
 * (disabled, unavailable, errored) — the caller MUST treat null as
 * "lexical-only".
 */
export async function semanticPlanHits(
  query: string,
  opts: PlanSourceOpts & { includeArchived?: boolean; limit: number },
  deps?: PlanSemanticDeps,
): Promise<PlanSemanticHit[] | null> {
  if (process.env.VITEST && !deps) return null;
  try {
    const d = deps ?? realDeps;
    const resolved = await d.resolveEmbedder();
    if (!resolved || resolved.dims !== EMBED_DIM) return null;
    const vec = await resolved.embed(query);
    if (vec.length !== EMBED_DIM) return null;
    return await d.queryTopPlans(vec, resolved.mode, opts);
  } catch {
    return null;
  }
}

export interface ConfirmResult<T> {
  /** false = no cosine verdict was possible — `kept` is `candidates` unchanged. */
  verdict: boolean;
  kept: Array<T & { similarity?: number }>;
  dropped: Array<T & { similarity: number }>;
}

/**
 * Cosine-confirm token-flagged similar_exists candidates against the proposed
 * plan. The proposed text mirrors the stored embed shape
 * (title + first 2k of body). Candidates WITHOUT a stored vector in the
 * active space are kept (no per-candidate verdict); any global failure keeps
 * ALL candidates (verdict:false) — the token refusal never weakens on
 * embedder health.
 */
export async function confirmSimilarPlans<T extends { slug: string }>(
  proposed: { title: string; body?: string | null },
  candidates: T[],
  opts: PlanSourceOpts = {},
  deps?: PlanSemanticDeps,
): Promise<ConfirmResult<T>> {
  const noVerdict: ConfirmResult<T> = { verdict: false, kept: candidates, dropped: [] };
  if (candidates.length === 0) return { verdict: false, kept: [], dropped: [] };
  if (process.env.VITEST && !deps) return noVerdict;
  try {
    const d = deps ?? realDeps;
    const resolved = await d.resolveEmbedder();
    if (!resolved || resolved.dims !== EMBED_DIM) return noVerdict;
    const vec = await resolved.embed(`${proposed.title}\n${(proposed.body ?? '').slice(0, 2000)}`);
    if (vec.length !== EMBED_DIM) return noVerdict;
    const sims = await d.querySimilarities(vec, resolved.mode, candidates.map((c) => c.slug), opts);
    const threshold = planDupeConfirmThreshold();
    const kept: Array<T & { similarity?: number }> = [];
    const dropped: Array<T & { similarity: number }> = [];
    for (const c of candidates) {
      const sim = sims.get(c.slug);
      if (sim === undefined) kept.push(c);
      else if (sim >= threshold) kept.push({ ...c, similarity: Math.round(sim * 1000) / 1000 });
      else dropped.push({ ...c, similarity: Math.round(sim * 1000) / 1000 });
    }
    return { verdict: true, kept, dropped };
  } catch {
    return noVerdict;
  }
}
