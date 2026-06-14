/**
 * queen-brief-launch — compute the Queen's precomputed wake brief at launch time
 * (queen-brief-cache-assembly-2026-06-13 B-03 P-005/P-006, B-04 read-side).
 *
 * Every Queen wake converges on `fireLaunchBlueprint(HIVE_BLUEPRINT_ID, …)` →
 * the hive launch blueprint → `invoke(role='queen')`. This is the seam the
 * launcher calls (when it resolves role='queen') to precompute her brief so she
 * opens already-briefed and skips the ~5 deterministic survey round-trips
 * (`hive:survey` + her carry-note here; the watchdog enriches the floor with
 * bee-load / inbox / change-feed / escalations in B-05 / P-008, D-004).
 *
 * FAIL-SOFT: any error returns null so the launch still fires — the Queen then
 * falls back to calling the survey tools herself (graceful degradation, the
 * behaviour queen.md P-007 keeps as the fallback). The rendered block is passed
 * as `buildPrompt({ queenBrief })`, which places it in the volatile tail as a
 * `<system-reminder>` (never the cacheable preamble — D-001).
 */
import { surveyHive } from './survey';
import { getHiveCarryNote } from './wake';
import { summarizeOpenPlacements } from './placement-watchdog';
import { renderQueenBrief, floorFromSurvey } from './queen-brief';

export async function computeQueenWakeBrief(
  workspaceId: string,
  installSlug: string,
  opts: { wokeBy?: string } = {},
): Promise<string | null> {
  try {
    // The watchdog's placement state (recovering/cursed/stranded — the completion
    // mandate) is read alongside the survey; summarizeOpenPlacements is fail-soft
    // (returns empty on error) so it never blocks the brief (D-004 / D-014).
    const [survey, carryNote, openPlacements] = await Promise.all([
      surveyHive(workspaceId, installSlug),
      getHiveCarryNote(workspaceId),
      summarizeOpenPlacements(workspaceId, installSlug),
    ]);
    const wokeBy = opts.wokeBy?.trim();
    const floor = floorFromSurvey(survey, { ...(wokeBy ? { wokeBy } : {}), openPlacements });
    return renderQueenBrief({ floor, carryNote });
  } catch (err) {
    console.warn(
      `[queen-brief] precompute failed for '${installSlug}' — Queen falls back to the survey tools:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
