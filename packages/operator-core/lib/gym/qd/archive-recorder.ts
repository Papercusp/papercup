/**
 * Gym loop ↔ QD-archive seams (P-010 record + P-011 selection) — the wiring that binds the
 * autonomous optimization loop to the MAP-Elites archive (`harness_shared.gym_qd_archive`).
 *
 * `makeLoopQdSeams` builds BOTH loop seams over ONE archive instance + a shared
 * variantId→descriptor cache:
 *   • `recordArchive` (P-010): for each evaluated variant (baseline + every candidate) derive
 *     the behavior descriptor and offer it to the archive as a `source:'gym'` elite
 *     (insert-if-better per niche cell). candidateId = the gym variant_id, so P-013 joins
 *     archive membership to gym_proposals.variant_id.
 *   • `noveltyForVariant` (P-011): a frontier member's distance-from-archive (the archive's
 *     `noveltyScore` over the descriptor cached when that variant was recorded). The loop
 *     records a variant BEFORE it can ever be selected as a parent, so the cache is always
 *     warm at selection time — no DB re-read, and no need to recover the parent overlay.
 *
 * Mirrors `makeLoopProposalRecorder` (control-plane.ts): an injected `Sql` (the live
 * operator/control-plane pool) + a (workspace, harness) scope, wired next to the proposal
 * recorder in the loop runner. Both seams are BEST-EFFORT in the loop (it wraps the calls so
 * a failure here can never abort the optimizer); this factory just builds the effects.
 */
import type { Sql } from 'postgres';
import { describeBehavior, type ArchiveCandidateRecord, type BehaviorDescriptor } from './niche';
import { QdArchive, type ArchiveAPI } from './archive';
import { PgArchiveStore } from './archive-store-pg';

/** Scope + clock for the live archive seams. */
export interface LoopQdScope {
  workspaceId: string;
  harnessSlug: string;
  now?: () => number;
}

/** The two QD loop seams, sharing one archive + a variantId→descriptor cache. */
export interface LoopQdSeams {
  /** `deps.recordArchive` — feed each evaluated variant into the MAP-Elites archive (P-010). */
  recordArchive: (rec: ArchiveCandidateRecord) => Promise<void>;
  /** `deps.noveltyForVariant` — a recorded variant's distance-from-archive for QD selection (P-011). */
  noveltyForVariant: (variantId: string) => Promise<number>;
}

/**
 * Build the QD record + novelty seams for `runOptimizationLoop`, both over the SAME archive so
 * `noveltyForVariant`'s reads see `recordArchive`'s writes. `opts.archive` overrides the live
 * `PgArchiveStore`-backed archive (injected in unit tests); `opts.k` sets the novelty k-NN.
 */
export function makeLoopQdSeams(
  sql: Sql,
  scope: LoopQdScope,
  opts: { archive?: ArchiveAPI; k?: number } = {},
): LoopQdSeams {
  const archive = opts.archive ?? makeGymArchive(sql, scope);
  const now = scope.now ?? (() => Date.now());
  // variantId → its behavior descriptor, cached as each variant is recorded. The loop records
  // baseline + every candidate before that variant can be picked as a parent, so a frontier
  // member's descriptor is always present at selection time. v1 single-writer-per-loop (the
  // optimizer owns the run), so an in-process Map is sufficient.
  const descriptors = new Map<string, BehaviorDescriptor>();

  const recordArchive = async (rec: ArchiveCandidateRecord): Promise<void> => {
    const descriptor = describeBehavior({ overlay: rec.overlay, parentOverlay: rec.parentOverlay });
    descriptors.set(rec.variantId, descriptor);
    await archive.upsertElite(
      { candidateId: rec.variantId, descriptor, fitness: rec.fitness, source: 'gym', rationale: rec.rationale ?? null },
      now(),
    );
  };

  const noveltyForVariant = async (variantId: string): Promise<number> => {
    const descriptor = descriptors.get(variantId);
    // An unrecorded variant has no place in the archive yet → maximally novel (1), matching the
    // empty-archive convention. In the live loop this is unreachable (record precedes selection).
    if (!descriptor) return 1;
    return archive.noveltyScore(descriptor, opts.k);
  };

  return { recordArchive, noveltyForVariant };
}

/**
 * The record seam alone — a thin projection of `makeLoopQdSeams` for callers that only feed the
 * archive (e.g. the archive-store integration test). Selection consumers want `makeLoopQdSeams`.
 */
export function makeLoopArchiveRecorder(
  sql: Sql,
  scope: LoopQdScope,
): (rec: ArchiveCandidateRecord) => Promise<void> {
  return makeLoopQdSeams(sql, scope).recordArchive;
}

/**
 * Construct the QD archive bound to the live operator DB for read-side consumers (P-012's Scout
 * bridge, a gym read-tool). The same `QdArchive` over `PgArchiveStore` the recorder writes
 * through, so reads see the recorder's writes.
 */
export function makeGymArchive(sql: Sql, scope: { workspaceId: string; harnessSlug: string }): QdArchive {
  return new QdArchive(new PgArchiveStore(sql, scope));
}
