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
import { gatherFleetSignals } from '../curation/fleet-signals';
import { buildFleetReaders } from '../curation/deps';
import { gatherCompletions } from '../curation/change-feed';
import { buildChangeFeedReaders } from '../curation/change-feed-deps';
import { renderQueenBrief, floorFromSurvey, type BriefEscalation } from './queen-brief';

/** Fleet signals (escalations/blockers/decisions) → the floor's escalation digest.
 *  Fail-soft: a flaky read degrades to no-escalations, never kills the brief. */
async function gatherEscalations(): Promise<BriefEscalation[]> {
  try {
    const signals = await gatherFleetSignals(buildFleetReaders());
    return signals.map((s) => ({ id: s.id, severity: s.severity, summary: s.title }));
  } catch {
    return [];
  }
}

/** Recent change-feed (what the fleet just shipped) → the floor's steering digest.
 *  Newest-first, capped to keep the tail small; fail-soft like the others. */
async function gatherRecentChanges(limit = 10): Promise<string[]> {
  try {
    const entries = await gatherCompletions(buildChangeFeedReaders());
    return entries.slice(0, limit).map((e) => `${e.kind}: ${e.title}`);
  } catch {
    return [];
  }
}

export async function computeQueenWakeBrief(
  workspaceId: string,
  installSlug: string,
  opts: { wokeBy?: string } = {},
): Promise<string | null> {
  try {
    // surveyHive is the CORE — if it throws, the whole brief is null and she falls
    // back to the survey tools. The other reads are individually fail-soft so one
    // flaky read degrades that section, never the whole brief (D-004 / D-014):
    //  - openPlacements (watchdog completion-state) — summarizeOpenPlacements is
    //    internally fail-soft (returns empty);
    //  - carryNote / escalations — wrapped here.
    const [survey, carryNote, openPlacements, escalations, changeFeed] = await Promise.all([
      surveyHive(workspaceId, installSlug),
      getHiveCarryNote(workspaceId).catch(() => null),
      summarizeOpenPlacements(workspaceId, installSlug),
      gatherEscalations(),
      gatherRecentChanges(),
    ]);
    const wokeBy = opts.wokeBy?.trim();
    const floor = floorFromSurvey(survey, {
      ...(wokeBy ? { wokeBy } : {}),
      openPlacements,
      ...(escalations.length > 0 ? { escalations } : {}),
      ...(changeFeed.length > 0 ? { changeFeed } : {}),
    });
    return renderQueenBrief({ floor, carryNote });
  } catch (err) {
    console.warn(
      `[queen-brief] precompute failed for '${installSlug}' — Queen falls back to the survey tools:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
