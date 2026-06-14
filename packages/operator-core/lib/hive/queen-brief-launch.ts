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
import { summarizeOpenPlacements, resolveQueenOwner } from './placement-watchdog';
import { gatherFleetSignals } from '../curation/fleet-signals';
import { buildFleetReaders } from '../curation/deps';
import { gatherCompletions } from '../curation/change-feed';
import { buildChangeFeedReaders } from '../curation/change-feed-deps';
import { gatherLiveBees } from '../fleet/placement-gather';
import { readInbox } from '../agent-tools/coordination/messages';
import { runWithWorkspace } from '../workspace-als';
import { getOrgPg } from '@papercusp/db-org';
import { renderQueenBrief, floorFromSurvey, type BriefEscalation, type BriefBee, type BriefInboxItem } from './queen-brief';

/** Live hive bees → the floor's bee load + liveness (warm-inject-vs-spawn signal).
 *  gatherLiveBees already excludes non-bees + joins load/liveness; fail-soft. */
async function gatherBees(workspaceId: string): Promise<BriefBee[]> {
  try {
    const bees = await gatherLiveBees(workspaceId);
    return bees.map((b) => ({
      id: b.label || b.ownerId,
      doing: b.intent || b.currentPlanSlug || b.doingHarness || null,
      load: b.load,
      alive: b.alive,
    }));
  } catch {
    return [];
  }
}

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

/**
 * The Queen's coord inbox → the floor's recent-messages digest (D-020, the last
 * every-wake read folded in). Resolve her DURABLE owner id (stable across her
 * fresh-per-wake spawns — `resolveQueenOwner`) and read the items addressed to
 * it. Because she is fresh-per-wake + stateless, this read-only digest is
 * EQUIVALENT to the `coord:inbox` call she'd otherwise make (both are stateless
 * "recent addressed items", no per-wake unread tracking) — it just saves the
 * round-trip; there is no delta/watermark to consume. `readInbox` already
 * excludes her own outbox + the `notify` firehose; we additionally drop ambient
 * rows (service-health / governor) to mirror `coord:inbox`'s default. Newest-
 * first, capped to keep the tail small. Fail-soft like the other gathers: any
 * error (or no resolvable owner) degrades to no-inbox, never kills the brief.
 *
 * Read inside the Queen's workspace ALS so `coordLog` resolves the right event
 * log (the inbox is workspace-keyed; resolveQueenOwner is explicitly scoped).
 */
async function gatherInbox(workspaceId: string, installSlug: string, limit = 10): Promise<BriefInboxItem[]> {
  try {
    const { sql } = getOrgPg();
    const queenOwner = await resolveQueenOwner(sql, workspaceId, installSlug);
    if (!queenOwner) return [];
    const all = await runWithWorkspace(workspaceId, () => readInbox(queenOwner, {}));
    return all
      .filter((e) => !e.category) // drop ambient (service-health / governor) like coord:inbox default
      .slice(-limit)
      .reverse() // newest-first
      .map((e) => ({ kind: e.kind, from: e.from, summary: (e.summary ?? e.body ?? '').slice(0, 200) }));
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
    const [survey, carryNote, openPlacements, escalations, changeFeed, bees, inbox] = await Promise.all([
      surveyHive(workspaceId, installSlug),
      getHiveCarryNote(workspaceId).catch(() => null),
      summarizeOpenPlacements(workspaceId, installSlug),
      gatherEscalations(),
      gatherRecentChanges(),
      gatherBees(workspaceId),
      gatherInbox(workspaceId, installSlug),
    ]);
    const wokeBy = opts.wokeBy?.trim();
    const floor = floorFromSurvey(survey, {
      ...(wokeBy ? { wokeBy } : {}),
      openPlacements,
      ...(escalations.length > 0 ? { escalations } : {}),
      ...(changeFeed.length > 0 ? { changeFeed } : {}),
      ...(bees.length > 0 ? { bees } : {}),
      ...(inbox.length > 0 ? { inbox } : {}),
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
