/**
 * digest-embed-cluster-leg — the P-018(b) flag-gated embedding-cluster EXPERIMENT
 * for the corpus-digest friction clustering (su-ideate-learning-substrate-2026-07-10).
 *
 * The incumbent friction clusterer is `findLikelyDuplicates` (../harness/improvements/
 * digest): PURE, deterministic, network-free — it groups friction captures by their
 * lexical `dedupSignature` (exact) then a token-set Jaccard ≥ 0.8 near-dup pass. Its
 * blind spot is the SAME class the P-017 novelty leg fixes: two captures describing
 * one friction in different words share few tokens, so the lexical pass never
 * collides them and the corpus digest under-counts a recurring meta-pattern.
 *
 * This leg is the FRONTIER EXPERIMENT (D-013 discipline): cluster the same friction
 * titles by EMBEDDING cosine instead of lexical Jaccard, and compare — cluster
 * coherence + the downstream idea grades/outcomes the clusters feed. It is a
 * drop-in for `findLikelyDuplicates` at the corpus-digest seam: same input
 * (`ImprovementCandidate[]`), same output shape (`DupCluster[]` = `{signature, ids}`),
 * so recurringFriction + rubricGaps consume it unchanged.
 *
 * CONTROL + DEFAULT stays LEXICAL. The experiment is OPT-IN
 * (PAPERCUSP_SU_DIGEST_EMBED_CLUSTER=on) and origin-tagged where it fires, so a
 * comparison is falsifiable and the incumbent wins ties until the evidence flips.
 *
 * FAIL-OPEN is the prime directive (mirrors the P-017 leg): the flag off (the
 * default), any embedder error/timeout, a disabled embedder, a dims mismatch
 * (harrier@1024 ≠ the vector(384) space the ledger is embedded under), a pathological
 * backlog, or nothing to cluster — ALL return null, and the caller falls back to the
 * lexical `findLikelyDuplicates`. VITEST-inert unless deps are injected (the real
 * resolver lazy-loads an ONNX model — the WI-3792 load-scar class). Embeddings are
 * deterministic per model+mode and the greedy clustering is order-deterministic, so
 * the digest stays regenerable.
 */
import { dedupSignature, type DupCluster } from '../harness/improvements/digest';
import type { ImprovementCandidate } from '../harness/improvements/policy';

/** Width of the migration-551/553 embedding columns (= embed-backfill's EMBEDDER_DIM). */
const EMBED_DIM = 384;
/** Whole-leg budget (embed every friction title + the O(n²) cosine pass). A warm
 *  sidecar answers each embed in ~10ms; a cold in-process model load (~2.8s) simply
 *  forfeits THIS digest's experiment and falls back to lexical. */
const BUDGET_MS = 4000;
/** Cosine ≥ this ⇒ two friction titles cluster. The embedding analog of the lexical
 *  NEAR_DUP_JACCARD (0.8); cosine neighbours run higher in absolute terms, so the
 *  default sits a touch above. Override per-experiment via
 *  PAPERCUSP_SU_DIGEST_EMBED_CLUSTER_THRESHOLD. */
const DEFAULT_COSINE_THRESHOLD = 0.85;
/** Above this friction count the experiment forfeits (fail-open to lexical) rather
 *  than embed a pathological backlog — mirrors findLikelyDuplicates' NEAR_DUP bound. */
const MAX_EMBED_CANDIDATES = 600;

/** Injectable seam (tests + any future non-backfill embedding space). */
export interface DigestEmbedClusterDeps {
  resolveEmbedder: () => Promise<
    | { mode: string; dims: number; embed: (t: string) => Promise<number[]> }
    | { mode: 'disabled'; reason?: string }
    | null
  >;
}

/** The experiment is OPT-IN — lexical clustering is the control AND the default. */
export function digestEmbedClusterEnabled(): boolean {
  return process.env.PAPERCUSP_SU_DIGEST_EMBED_CLUSTER === 'on';
}

/** Experiment threshold, env-overridable for tuning; clamped to (0,1], default 0.85. */
export function digestEmbedClusterThreshold(): number {
  const raw = Number(process.env.PAPERCUSP_SU_DIGEST_EMBED_CLUSTER_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0 || raw > 1) return DEFAULT_COSINE_THRESHOLD;
  return raw;
}

/** Resolve-null on timeout, never reject — the budget IS the fail-open (P-017 leg). */
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

/** Cosine similarity of two equal-width vectors. Returns 0 for a zero-norm vector. */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * PURE greedy cosine clustering — the drop-in analog of `findLikelyDuplicates`' near-dup
 * pass, cosine ≥ threshold instead of Jaccard ≥ 0.8. Deterministic given the input order
 * and vectors (parallel arrays, same length). Each emitted cluster has >1 member and
 * carries the exemplar's lexical `dedupSignature` — so downstream consumers
 * (buildRecurringFriction / buildRubricGaps, which key off `cluster.signature` and its
 * `friction:<signature>` ref) are unchanged whichever clusterer produced it.
 */
export function clusterByCosine(
  candidates: ReadonlyArray<{ id: string; title: string }>,
  vectors: ReadonlyArray<number[]>,
  threshold: number,
): DupCluster[] {
  const clusters: DupCluster[] = [];
  const claimed = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    if (claimed.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < candidates.length; j++) {
      if (claimed.has(j)) continue;
      if (cosine(vectors[i], vectors[j]) >= threshold) {
        group.push(j);
        claimed.add(j);
      }
    }
    if (group.length > 1) {
      claimed.add(i);
      clusters.push({
        signature: dedupSignature(candidates[i].title),
        ids: group.map((k) => candidates[k].id),
      });
    }
  }
  return clusters;
}

/** The DOCUMENT-side resolver the backfill sweep stores the ledger under — the one
 *  seam that guarantees the friction titles and any stored vectors share space+prompt. */
const realDeps: DigestEmbedClusterDeps = {
  resolveEmbedder: async () => (await import('../search/embed-backfill')).resolveBackfillEmbedder(),
};

async function embedAndCluster(
  candidates: readonly ImprovementCandidate[],
  deps: DigestEmbedClusterDeps,
): Promise<DupCluster[] | null> {
  if (candidates.length < 2 || candidates.length > MAX_EMBED_CANDIDATES) return null;
  const resolved = await deps.resolveEmbedder();
  if (!resolved || resolved.mode === 'disabled' || !('embed' in resolved)) return null;
  if (resolved.dims !== EMBED_DIM) return null; // harrier@1024 — no vector(384) verdict possible
  const vectors: number[][] = [];
  for (const c of candidates) {
    const v = await resolved.embed((c.title ?? '').slice(0, 2000));
    if (v.length !== EMBED_DIM) return null; // wrong-width ⇒ fail-open, don't cluster garbage
    vectors.push(v);
  }
  return clusterByCosine(
    candidates.map((c) => ({ id: c.id, title: c.title })),
    vectors,
    digestEmbedClusterThreshold(),
  );
}

/**
 * Cluster friction candidates by EMBEDDING cosine — the flag-gated experiment. Returns
 * null for "no verdict, use the lexical control" (flag off / disabled / unavailable /
 * dims-mismatch / timeout / errored / too few / pathological backlog); the caller MUST
 * treat null as "fall back to findLikelyDuplicates". Never throws.
 */
export async function clusterFrictionByEmbedding(
  candidates: readonly ImprovementCandidate[],
  deps?: DigestEmbedClusterDeps,
): Promise<DupCluster[] | null> {
  if (!digestEmbedClusterEnabled()) return null; // control/default = lexical
  // Inert under vitest unless a test injects deps: the real resolver lazy-loads an
  // ONNX model, which unrelated tool tests must never pay.
  if (process.env.VITEST && !deps) return null;
  try {
    return await withBudget(BUDGET_MS, embedAndCluster(candidates, deps ?? realDeps));
  } catch {
    return null;
  }
}
