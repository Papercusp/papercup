/**
 * recipe-hygiene.ts — the single-run body of the WEEKLY code-recipes hygiene routine
 * (recipes-reuse-activation-2026-06-22 P-003). Kept separate from the DBOS scheduled
 * wrapper in lib/dbos/periodic-workflows.ts so it integration-tests without the
 * scheduler (mirrors runEmbedBackfillOnce / runStorageGrowthAlarmOnce).
 *
 * What it does on its cadence:
 *  - SWEEP the stale long-tail: retire ACTIVE recipes run <= maxRunCount times whose
 *    last run is older than staleDays (sweepRecipes — a reversible status flip that
 *    NEVER touches hot / promoted / merged / NULL-last-run recipes), so the corpus stays
 *    signal-dense instead of accumulating never-reused one-offs (the audit's pollution).
 *  - SURFACE the graduation worklist: compute recipeCandidates (promote candidates +
 *    near-duplicate merge clusters) so a passive heartbeat of "what's graduating" exists
 *    even in a Queen-less window. This does NOT replace the Queen — she still pulls
 *    recipes:candidates live on her cadence (code-recipes-2026-06-21 D-017); the routine
 *    just guarantees hygiene + visibility run on a schedule rather than only when she's idle.
 *
 * Read-mostly + reversible: the only mutation is the sweep's status flip. Returns a
 * summary for logging + tests; the scheduled caller wraps it so it never throws out.
 *
 * Server-only.
 */
import type postgres from 'postgres';
import { sweepRecipes, type SweepRecipesInput } from './code-recipes-store';
import { recipeCandidates, type RecipeCandidatesDeps } from './code-recipes-candidates';

export interface RecipeHygieneResult {
  /** ids of the recipes retired by the sweep this run. */
  sweptIds: string[];
  /** count of current promote candidates (the Queen's graduation worklist). */
  promoteCandidates: number;
  /** count of current near-duplicate merge clusters. */
  mergeClusters: number;
}

export interface RecipeHygieneOpts {
  /** Sweep tuning (default: conservative 30d / run_count<=1, a real — non-dry — run). */
  sweep?: SweepRecipesInput;
  /** Candidate-scorer deps (embedder / co-occurrence) — optional; lexical+structural carry. */
  candidatesDeps?: RecipeCandidatesDeps;
}

/**
 * One hygiene pass: sweep the stale never-reused one-offs, then compute the current
 * graduation worklist. Returns the swept ids + worklist counts.
 */
export async function runRecipeHygieneOnce(
  sql: postgres.Sql,
  opts: RecipeHygieneOpts = {},
): Promise<RecipeHygieneResult> {
  const swept = await sweepRecipes(sql, opts.sweep ?? {});
  const { promoteCandidates, mergeClusters } = await recipeCandidates(sql, {}, opts.candidatesDeps ?? {});
  return {
    sweptIds: swept.swept.map((r) => r.id),
    promoteCandidates: promoteCandidates.length,
    mergeClusters: mergeClusters.length,
  };
}
