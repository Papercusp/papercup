/**
 * Gym loop → QD-archive bridge (P-010). Builds the optimization loop's `recordArchive`
 * seam: for each evaluated variant (baseline + every candidate) it derives the behavior
 * descriptor and offers it to the MAP-Elites archive (`harness_shared.gym_qd_archive`).
 *
 * Mirrors `makeLoopProposalRecorder` (control-plane.ts): an injected `Sql` (the live
 * operator/control-plane pool) + a (workspace, harness) scope, so the gym loop runner wires
 * it next to the proposal recorder. The recorder is BEST-EFFORT — the loop wraps the call
 * so a failure here can never abort the optimizer; this factory just builds the effect.
 */
import type { Sql } from 'postgres';
import { describeBehavior, type ArchiveCandidateRecord } from './niche';
import { QdArchive } from './archive';
import { PgArchiveStore } from './archive-store-pg';

/**
 * Build a `deps.recordArchive` for `runOptimizationLoop` that upserts each evaluated variant
 * into the QD archive as a `source:'gym'` elite (insert-if-better per niche cell). The
 * candidateId is the variant id, so P-013 joins archive membership to gym_proposals.variant_id.
 */
export function makeLoopArchiveRecorder(
  sql: Sql,
  ctx: { workspaceId: string; harnessSlug: string; now?: () => number },
): (rec: ArchiveCandidateRecord) => Promise<void> {
  const archive = new QdArchive(new PgArchiveStore(sql, { workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug }));
  const now = ctx.now ?? (() => Date.now());
  return async (rec: ArchiveCandidateRecord) => {
    const descriptor = describeBehavior({ overlay: rec.overlay, parentOverlay: rec.parentOverlay });
    await archive.upsertElite(
      {
        candidateId: rec.variantId,
        descriptor,
        fitness: rec.fitness,
        source: 'gym',
        rationale: rec.rationale ?? null,
      },
      now(),
    );
  };
}

/**
 * Construct the QD archive bound to the live operator DB for read-side consumers (P-011's
 * `noveltyForVariant` dep, P-012's Scout bridge, a gym read-tool). The same `QdArchive` over
 * `PgArchiveStore` the recorder writes through, so reads see the recorder's writes.
 */
export function makeGymArchive(sql: Sql, scope: { workspaceId: string; harnessSlug: string }): QdArchive {
  return new QdArchive(new PgArchiveStore(sql, scope));
}
