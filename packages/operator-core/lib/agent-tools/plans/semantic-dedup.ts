/**
 * semantic-dedup — plans:new's `similar_exists` CONFIRMATION check
 * (P-010 shared-embedding-sidecar-and-enrichment-2026-07-10).
 *
 * The token matcher scores slug+title token overlap only, so topically-adjacent
 * but distinct efforts false-positive (it flagged this very plan's creation). A
 * token-flagged candidate whose stored vector is semantically DISTANT from the
 * proposed plan is dropped from the refusal; a candidate with NO stored vector
 * (or no verdict at all) is KEPT — both failure directions preserve today's
 * token-verdict behavior.
 *
 * ─── THIS IS A THRESHOLD CLASSIFIER, NOT A SEARCH (D-025) ──────────────────
 * It used to sit beside `semanticPlanHits`, plans:search's semantic leg. That
 * leg has MOVED to ./semantic-leg.ts and now runs inside `runHybridSearch`;
 * this one deliberately did NOT move, and P-016 does not cover it:
 *
 *   - a SEARCH ranks a whole corpus and hands a list to fusion, in the
 *     query→doc pairing, where the P-017 floor applies;
 *   - THIS scores a FIXED candidate list and partitions it at a threshold, in
 *     the doc↔doc pairing.
 *
 * `runHybridSearch` cannot express that shape, and gemma is a dual-encoder — so
 * the 0.6 below and the 0.45 search floor live in different pairings and
 * neither licenses the other. The split keeps that structural rather than a
 * comment someone has to notice.
 *
 * FAIL-OPEN: no embedder, migration 553 absent, dims mismatch (harrier@1024),
 * or any throw degrades to token-only. VITEST-inert unless deps are injected
 * (the real resolver lazy-loads an ONNX model — the WI-3792 load-scar class).
 */

import { withWorkspace } from '@papercusp/db-org';
import { resolvePlanScope, type PlanSourceOpts } from './source';

// The prose column width contract — ONE source, not a restated `384` (D-005 §5).
import { fitsProseColumns } from '../../search/prose-vector-dims';
// Embedding-coverage awareness (WI-9393). The SURFACE-level door, deliberately not
// `assessSourceCoverage`: this classifier is not a `SearchSource`, and
// SEARCH_SOURCE_SURFACES is asserted exhaustive in both directions against
// SEARCH_SOURCES (coverage-gate.test.ts), so adding a key there would fail the suite.
import {
  assessSurfaceCoverage,
  type CoverageSnapshot,
  type SourceCoverageAssessment,
} from '../../search/coverage-gate';

/** The label this consumer's coverage verdict is reported under. */
const PLAN_DEDUP_COVERAGE_SOURCE = 'plans:semantic-dedup';
/** The one vector surface `querySimilaritiesReal`'s SQL reads. */
const PLAN_DEDUP_SURFACES = ['harness_shared.harness_plans.embedding'] as const;
/** Below this cosine similarity a token-flagged candidate is considered a
 *  DIFFERENT effort and cleared from the similar_exists refusal.
 *
 *  Calibrated live (P-010, 2026-07-10, doc↔doc gemma over the 765-plan
 *  corpus): the reproduced false positive that forced this very plan's
 *  force:true — shared-hive-p2p-release-readiness, token-flagged on the
 *  generic words shared/local/only — measured 0.488, indistinguishable from
 *  unrelated controls (0.46–0.49); the genuinely-related predecessor plan
 *  (embeddinggemma-300m-default-embedder) measured 0.721 and SHOULD stay
 *  flagged (it's the "continue that instead?" signal). 0.6 sits in the gap:
 *  clears the false-positive class, keeps real topical overlap. Override via
 *  PAPERCUSP_PLAN_DUPE_CONFIRM. */
const DEFAULT_CONFIRM = 0.6;

export function planDupeConfirmThreshold(): number {
  const n = Number(process.env.PAPERCUSP_PLAN_DUPE_CONFIRM);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : DEFAULT_CONFIRM;
}

/** Injectable seams (tests + any future non-553 store). */
export interface PlanConfirmDeps {
  resolveEmbedder: () => Promise<{ mode: string; dims: number; embed: (t: string) => Promise<number[]> } | null>;
  /** slug → similarity for the given slugs that HAVE a vector in `mode`'s space. */
  querySimilarities: (vec: number[], mode: string, slugs: string[], opts: PlanSourceOpts) => Promise<Map<string, number>>;
  /** Test seam for the WI-9393 coverage assessment; injecting it also opts in
   *  under vitest, where the assessment is otherwise inert. */
  loadCoverage?: () => Promise<CoverageSnapshot>;
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

// CONFIRM pairing: the proposed plan will itself be STORED, so doc↔doc cosine
// (the backfill sweep's document-side resolver) — same choice P-008's
// work-item dupe guard made, and the pairing the threshold is calibrated in.
// (plans:search's QUERY-side pairing lives in ./semantic-leg.ts — D-025.)
const confirmDeps: PlanConfirmDeps = {
  resolveEmbedder: async () => {
    const r = await (await import('../../search/embed-backfill')).resolveBackfillEmbedder();
    return r.mode === 'disabled' || !('embed' in r) ? null : r;
  },
  querySimilarities: querySimilaritiesReal,
};

export interface ConfirmResult<T> {
  /** false = no cosine verdict was possible — `kept` is `candidates` unchanged. */
  verdict: boolean;
  kept: Array<T & { similarity?: number }>;
  dropped: Array<T & { similarity: number }>;
  /**
   * WI-9393 / D-018: whether `harness_shared.harness_plans.embedding` — the column
   * this classifier's SQL reads — is actually populated.
   *
   * NOTE THE DEGRADATION DIRECTION, which is the OPPOSITE of the dupe-guard's and
   * work-item search's. A candidate with no stored vector is KEPT (see the header),
   * so low coverage here never lets a duplicate plan through; it makes the refusal
   * STICK when cosine could have cleared it. The failure is over-blocking — an agent
   * told "a similar plan exists" for a plan that is genuinely distinct — so the
   * verdict's value is explaining WHY a refusal could not be lifted.
   *
   * Absent when no assessment was attempted; an `unknown` verdict is the distinct
   * statement "we looked and the sampler knows nothing".
   */
  coverage?: SourceCoverageAssessment;
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
  deps?: PlanConfirmDeps,
): Promise<ConfirmResult<T>> {
  const result = await confirmSimilarPlansCore(proposed, candidates, opts, deps);
  // An empty candidate list asked no question, so there is nothing to explain.
  if (candidates.length === 0) return result;
  // DELIBERATELY outside the classifier and in its own try/catch: coverage is a
  // diagnostic ABOUT the verdict and must never be able to cost us one. Note it is
  // attached to the fail-open `verdict:false` results TOO — those are exactly the
  // cases where the caller most needs to know whether the corpus was the problem.
  try {
    const snapshot = await loadPlanDedupCoverage(deps?.loadCoverage);
    // `null` = do not assess at all (no key); an EMPTY map is the different statement
    // "we looked and know nothing", which the shared logic renders as `unknown`.
    if (snapshot === null) return result;
    return {
      ...result,
      coverage: assessSurfaceCoverage(PLAN_DEDUP_COVERAGE_SOURCE, PLAN_DEDUP_SURFACES, snapshot),
    };
  } catch {
    return result;
  }
}

/** The snapshot for {@link PLAN_DEDUP_SURFACES}. A failed READ yields an EMPTY map,
 *  which `assessSurfaceCoverage` already renders as `unknown` — never as healthy, and
 *  never as a hand-written verdict object that could drift from the shared logic. */
async function loadPlanDedupCoverage(
  seam?: () => Promise<CoverageSnapshot>,
): Promise<CoverageSnapshot | null> {
  if (seam) {
    try {
      return await seam();
    } catch {
      return new Map();
    }
  }
  // Inert under vitest unless a test injects the seam — same reasoning as the ONNX
  // guard below: unrelated tool tests must not pay for a live org-PG read.
  if (process.env.VITEST) return null;
  try {
    const [{ loadCoverageSnapshotCached }, { getOrgPg }, { activeWorkspaceId }] = await Promise.all([
      import('../../search/coverage-gate'),
      import('@papercusp/db-org'),
      import('../../workspace-registry'),
    ]);
    return await loadCoverageSnapshotCached(getOrgPg().sql, activeWorkspaceId());
  } catch {
    return new Map();
  }
}

async function confirmSimilarPlansCore<T extends { slug: string }>(
  proposed: { title: string; body?: string | null },
  candidates: T[],
  opts: PlanSourceOpts = {},
  deps?: PlanConfirmDeps,
): Promise<ConfirmResult<T>> {
  const noVerdict: ConfirmResult<T> = { verdict: false, kept: candidates, dropped: [] };
  if (candidates.length === 0) return { verdict: false, kept: [], dropped: [] };
  if (process.env.VITEST && !deps) return noVerdict;
  try {
    const d = deps ?? confirmDeps;
    const resolved = await d.resolveEmbedder();
    if (!resolved || !fitsProseColumns(resolved.dims)) return noVerdict;
    const vec = await resolved.embed(`${proposed.title}\n${(proposed.body ?? '').slice(0, 2000)}`);
    if (!fitsProseColumns(vec.length)) return noVerdict;
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
