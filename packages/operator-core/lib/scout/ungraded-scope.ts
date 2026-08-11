/**
 * ungraded-scope.ts — THE ONE definition of "ungraded" for the Blender/Scout rail
 * (blender-su-grade-integration-2026-08-11 P-010).
 *
 * WHY THIS MODULE EXISTS. Three surfaces counted "ungraded routed ideas" and
 * published three different numbers for the same workspace on the same day:
 *
 *   - `ungraded-filings-watchdog` / `watchdog:status` →   15   (agreeing with each other)
 *   - `system-health` scout.grading.ungraded          → 1,103
 *   - plan D-074, reported as "su filings past a day" → 1,082
 *
 * None of them was a bug in the counting. Every one was arithmetically right about a
 * DIFFERENT POPULATION, because "ungraded" leaves three axes implicit and each caller
 * silently chose its own. Measured on the live table 2026-08-11:
 * `origin='scout'` holds 1,146 rows (1,088 ungraded) while `origin='su-ideate'` holds
 * 184 rows EVER (15 ungraded) — so D-074's "1,082 su filings" was the SCOUT population
 * wearing the su label, off by ~70x. It made the su grading backlog look like an
 * emergency while the actionable backlog was fifteen.
 *
 * THE THREE AXES a count must fix before the word "ungraded" means anything:
 *
 *   1. ORIGIN      — who filed it. `su-ideate` (an su's own ideation pass) and `scout`
 *                    (the ideator rail's corpus) have different producers, different
 *                    graders and different deadlines. Summing them answers no question.
 *   2. TERMINALITY — is the routed artifact still open? A filing whose artifact already
 *                    landed or was dropped (`outcome` set and not 'pending') cannot be
 *                    usefully graded; counting it inflates a backlog nobody can drain.
 *   3. EPOCH FLOOR — D-013 grading is FORWARD-ONLY. Rows routed before the floor are
 *                    deliberately excluded, not forgotten. A count that omits the floor
 *                    silently re-imports the whole pre-epoch corpus.
 *
 * THE RULE: a single scalar named `ungraded` is banned on any surface a human reads.
 * Return `UngradedBreakdown` instead — it cannot be rendered without saying which
 * population it describes, which is the only thing that actually prevents the drift.
 * `ungraded-scope.guard.test.ts` fails the build if a new raw `human_grade IS NULL`
 * predicate appears outside this module.
 */

import type { Sql } from '@papercusp/db-org';

/** The producers that file into `harness_shared.scout_routed_ideas`. */
export type UngradedOrigin = 'su-ideate' | 'scout' | 'drill';

/** One routed-idea row, reduced to the fields the scope decision needs. */
export interface UngradedRowLike {
  origin: string;
  /** null ⇒ ungraded. */
  humanGrade: number | string | null;
  /** null or 'pending' ⇒ the routed artifact is still open. */
  outcome: string | null;
  routedAtMs: number;
}

/**
 * Which population a row belongs to. `actionable` is the only bucket a grading
 * backstop may act on; the other three name a REASON for exclusion rather than
 * disappearing, so a caller can always account for the difference between its
 * number and the raw table count.
 */
export type UngradedBucket = 'graded' | 'actionable' | 'terminal' | 'pre-epoch';

/**
 * PURE: bucket one row. This function IS the definition — `readUngradedBreakdown`'s
 * SQL mirrors it, and the guard test pins the two together.
 *
 * Order matters and is deliberate: a graded row is never counted anywhere else, and a
 * pre-epoch row is excluded even when its artifact is still open (the floor is a policy
 * boundary, not a staleness heuristic).
 */
export function classifyUngraded(
  row: UngradedRowLike,
  opts: { epochMs: number },
): UngradedBucket {
  if (row.humanGrade !== null && row.humanGrade !== undefined) return 'graded';
  if (!Number.isFinite(row.routedAtMs) || row.routedAtMs < opts.epochMs) return 'pre-epoch';
  if (row.outcome !== null && row.outcome !== 'pending') return 'terminal';
  return 'actionable';
}

/**
 * A labelled census. Every field names its own population, so no caller can emit a
 * bare "ungraded" number without choosing what it means.
 */
export interface UngradedBreakdown {
  /** Per-origin actionable counts — ungraded, artifact open, at/after the epoch floor.
   *  THIS is the drainable grading backlog, and the only number a backstop may act on. */
  actionableByOrigin: Record<string, number>;
  /** Total actionable across every origin. */
  actionable: number;
  /** EVERY ungraded row: any origin, any outcome, any age. The number that looked like
   *  a crisis. Kept so the difference from `actionable` is always visible — never render
   *  it without its label. */
  allUngraded: number;
  /** Why the two differ. `allUngraded === actionable + preEpoch + terminal` always. */
  excluded: { preEpoch: number; terminal: number };
  /** The floor this census was taken against, so a stored result stays interpretable. */
  epochMs: number;
}

interface BreakdownRow {
  origin: string;
  actionable: number | string | null;
  all_ungraded: number | string | null;
  pre_epoch: number | string | null;
  terminal: number | string | null;
}

const n = (v: number | string | null | undefined): number => Math.max(0, Number(v ?? 0));

/**
 * PURE: fold per-origin SQL rows into the breakdown. Split from the query so the
 * assembly is unit-testable with no PG.
 */
export function summarizeUngraded(
  rows: readonly BreakdownRow[],
  epochMs: number,
): UngradedBreakdown {
  const actionableByOrigin: Record<string, number> = {};
  let actionable = 0;
  let allUngraded = 0;
  let preEpoch = 0;
  let terminal = 0;
  for (const r of rows) {
    const a = n(r.actionable);
    if (a > 0 || r.origin) actionableByOrigin[r.origin] = a;
    actionable += a;
    allUngraded += n(r.all_ungraded);
    preEpoch += n(r.pre_epoch);
    terminal += n(r.terminal);
  }
  return { actionableByOrigin, actionable, allUngraded, excluded: { preEpoch, terminal }, epochMs };
}

/**
 * Read the labelled census for a workspace (optionally one harness slug).
 *
 * The FILTER clauses below MIRROR `classifyUngraded` bucket-for-bucket; keep them in
 * step. Fail-soft is the CALLER's choice here, not this function's: a health surface
 * that swallows the error must render "unavailable", never a zero — a zeroed backlog
 * is indistinguishable from a drained one, which is the failure this whole module is
 * about.
 */
export async function readUngradedBreakdown(
  sql: Sql,
  args: { workspaceId: string; harnessSlug?: string; epochMs: number },
): Promise<UngradedBreakdown> {
  const { workspaceId, harnessSlug, epochMs } = args;
  const rows = harnessSlug
    ? await sql<BreakdownRow[]>`
        SELECT origin,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= ${epochMs}
                                  AND (outcome IS NULL OR outcome = 'pending'))::int AS actionable,
               count(*) FILTER (WHERE human_grade IS NULL)::int AS all_ungraded,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at < ${epochMs})::int AS pre_epoch,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= ${epochMs}
                                  AND outcome IS NOT NULL AND outcome <> 'pending')::int AS terminal
          FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${workspaceId} AND harness_slug = ${harnessSlug}
         GROUP BY origin`
    : await sql<BreakdownRow[]>`
        SELECT origin,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= ${epochMs}
                                  AND (outcome IS NULL OR outcome = 'pending'))::int AS actionable,
               count(*) FILTER (WHERE human_grade IS NULL)::int AS all_ungraded,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at < ${epochMs})::int AS pre_epoch,
               count(*) FILTER (WHERE human_grade IS NULL AND routed_at >= ${epochMs}
                                  AND outcome IS NOT NULL AND outcome <> 'pending')::int AS terminal
          FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${workspaceId}
         GROUP BY origin`;
  return summarizeUngraded(rows, epochMs);
}
