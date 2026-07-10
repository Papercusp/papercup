/**
 * mug-brief-launch — compute the Mug's precomputed wake brief at launch time
 * (queen-brief-cache-assembly-2026-06-13 B-03 P-005/P-006, B-04 read-side).
 *
 * Every Mug wake converges on `fireLaunchBlueprint(POT_BLUEPRINT_ID, …)` →
 * the pot launch blueprint → `invoke(role='queen')`. This is the seam the
 * launcher calls (when it resolves role='queen') to precompute her brief so she
 * opens already-briefed and skips the ~5 deterministic survey round-trips
 * (`pot:survey` + her carry-note here; the watchdog enriches the floor with
 * cup-load / inbox / change-feed / escalations in B-05 / P-008, D-004).
 *
 * FAIL-SOFT: any error returns null so the launch still fires — the Mug then
 * falls back to calling the survey tools herself (graceful degradation, the
 * behaviour mug.md P-007 keeps as the fallback). The rendered block is passed
 * as `buildPrompt({ mugBrief })`, which places it in the volatile tail as a
 * `<system-reminder>` (never the cacheable preamble — D-001).
 */
import { surveyPot, type ScopeFilter } from './survey';
import { getPotCarryJournal } from './wake';
import { summarizeOpenPlacements, resolveMugOwner } from './placement-watchdog';
import { listEscalations } from '../agent-tools/coordination/escalations';
import { readTriagedHandledItemIds } from '../attention/triage-store';
import { isOperationalEscalation } from '../attention/adapters';
import { gatherCompletions } from '../curation/change-feed';
import { buildChangeFeedReaders } from '../curation/change-feed-deps';
import { gatherLiveBees } from '../fleet/placement-gather';
import { readInbox } from '../agent-tools/coordination/messages';
import { drainSlotMessages } from '../agent-tools/coordination/slot-parked-store';
import { runWithWorkspace } from '../workspace-als';
import { getOrgPg } from '@papercusp/db-org';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { renderMugBrief, floorFromSurvey, type BriefEscalation, type BriefCup, type BriefInboxItem, type BriefCapacity } from './mug-brief';
import { overwatchAliveForQueen } from '../overwatch/cross-monitor';
import { getOwnerSteering, isPausedNow, hasActiveThrottle, type OwnerSteering } from '../owner-steering';
import { fetchGatewayHeadroom } from '../inference-gateway/observability';
import { buildCapacityReport } from '../fleet/capacity-dispatch';
import { parsePriorityTierMap } from '@papercusp/papercusp-shared/agent';

/** Live inference-pool capacity → the floor's Capacity panel (mug-capacity-aware-dispatch P-002). The
 *  SOURCE-side read of the shared gateway oracle (D-007), so the Mug sizes the batch to what the pool can
 *  FEED. Fail-soft: when the gateway is off/unreachable (a connection-refused fails fast, well under the
 *  timeout) or the fetch errors, returns undefined and the panel is omitted — never blocks the brief, never
 *  renders a misleading reading. No flag gate needed: the unreachable fail-soft already covers gateway-off. */
async function gatherCapacity(): Promise<BriefCapacity | undefined> {
  try {
    const hr = await fetchGatewayHeadroom({ timeoutMs: 1200 });
    if (!hr.reachable) return undefined;
    const r = buildCapacityReport(hr, { clampArmed: false, tierMap: parsePriorityTierMap(process.env.GATEWAY_PRIORITY_MAP) });
    return {
      factor: r.factor,
      dispatchBudget: r.dispatchBudget,
      utilizationPct: r.utilizationPct,
      paused: r.paused,
      restartRecovering: r.restartRecovering,
      processUptimeMs: r.processUptimeMs,
      advice: r.advice,
    };
  } catch {
    return undefined;
  }
}

/** Live pot cups → the floor's cup load + liveness (warm-inject-vs-spawn signal).
 *  gatherLiveBees already excludes non-cups + joins load/liveness; fail-soft. */
async function gatherCups(workspaceId: string): Promise<BriefCup[]> {
  try {
    const cups = await gatherLiveBees(workspaceId);
    return cups.map((b) => ({
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
 *  Drain OLDEST-FIRST so each wake works down the backlog instead of re-reading
 *  the newest duplicates. Fail-soft: a flaky read degrades to no-escalations,
 *  never kills the brief. */
async function gatherEscalations(limit = 10): Promise<BriefEscalation[]> {
  try {
    const handled = await readTriagedHandledItemIds();
    return (await listEscalations({ status: 'open' }))
      .filter((e) => !handled.has(`escalation:${e.msg_id}`))
      .filter((e) => !isOperationalEscalation(e.from, (e.options?.length ?? 0) > 0))
      .sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id))
      .slice(0, limit)
      .map((e) => {
        const repeatCount = typeof (e as { repeatCount?: unknown }).repeatCount === 'number'
          ? Math.max(1, Math.floor((e as { repeatCount: number }).repeatCount))
          : 1;
        return {
          id: `escalation:${e.msg_id}`,
          severity: e.severity,
          summary: repeatCount > 1 ? `${e.summary} (x${repeatCount})` : e.summary,
        };
      });
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
 * The Mug's coord inbox → the floor's recent-messages digest (D-020, the last
 * every-wake read folded in). Resolve her latest owner id and read the items
 * addressed to it. We also drain `@role:mug` parked nudges into that same
 * digest: Mug sessions are fresh-per-wake, so targeting a concrete owner id is
 * race-prone; role-slot parking is the stable channel and this wake is the drain
 * trigger. `readInbox` already excludes her own outbox + the `notify` firehose;
 * we additionally drop ambient rows (service-health / governor) to mirror
 * `coord:inbox`'s default. Newest-first, capped to keep the tail small. Fail-soft
 * like the other gathers: any error (or no resolvable owner) degrades to no-inbox,
 * never kills the brief.
 *
 * Read inside the Mug's workspace ALS so `coordLog` resolves the right event
 * log (the inbox is workspace-keyed; resolveMugOwner is explicitly scoped).
 */
async function gatherInbox(workspaceId: string, installSlug: string, limit = 10): Promise<BriefInboxItem[]> {
  try {
    const { sql } = getOrgPg();
    const mugOwner = await resolveMugOwner(sql, workspaceId, installSlug);
    if (!mugOwner) return [];
    const inboxRows = await runWithWorkspace(workspaceId, () => readInbox(mugOwner, {})).catch(() => [] as CoordEnvelope[]);
    // anyHarnessSlug (WI-682): there is ONE workspace Mug covering all started
    // hives, but senders park `@role:mug` rows under whatever harness context
    // they had — often NULL (a coord:send with no harness scope). A slug-keyed
    // drain stranded those rows forever (18 undelivered nudges, 06-25→07-02).
    const slotRows = await drainSlotMessages(sql, {
      slot: { kind: 'role', ref: 'mug' },
      anyHarnessSlug: true,
      toOwner: mugOwner,
      nowMs: Date.now(),
      workspaceId,
    }).catch(() => [] as CoordEnvelope[]);
    const all = [...inboxRows, ...slotRows].sort((a, b) => a.ts.localeCompare(b.ts) || a.msg_id.localeCompare(b.msg_id));
    return all
      .filter((e) => !e.category) // drop ambient (service-health / governor) like coord:inbox default
      .slice(-limit)
      .reverse() // newest-first
      .map((e) => ({ kind: e.kind, from: e.from, summary: (e.summary ?? e.body ?? '').slice(0, 200) }));
  } catch {
    return [];
  }
}

/**
 * Overwatch's liveness for the Mug's cross-monitor (overwatch-role-2026-06-15
 * B-09 / D-004, the reverse leg): `true`/`false` when overwatch is in play,
 * `undefined` when it is not (flag off / pot paused) so the brief omits the
 * line. Fail-soft like every other gather — a flaky read degrades to `undefined`
 * (omit), never a false OVERWATCH-DARK alarm.
 */
async function gatherOverwatchLiveness(workspaceId: string, installSlug: string): Promise<boolean | undefined> {
  try {
    return await overwatchAliveForQueen(workspaceId, installSlug);
  } catch {
    return undefined;
  }
}

/**
 * Owner steering (queen-steering-panel-2026-06-15 B-02 / P-002): read C-1's
 * `getOwnerSteering` fail-soft and surface it ONLY when the Pot is actually
 * steered — a default (un-steered) Pot returns `undefined`, so the wake brief
 * omits the `### Owner steering directive` section (purely additive). Expired
 * `pausedUntil` pauses are normalized away here via `isPausedNow`, so what reaches
 * the render is the currently-ACTIVE steering (the render never consults the clock).
 */
async function gatherOwnerSteering(
  workspaceId: string,
  installSlug: string,
): Promise<OwnerSteering | undefined> {
  try {
    const s = await getOwnerSteering(workspaceId, installSlug);
    const pausedNow = isPausedNow(s, Date.now());
    const active =
      !!s.directive ||
      s.eligiblePlans.length > 0 ||
      s.eligiblePots.length > 0 ||
      s.includeUnplannedWork === false || // loose-work turned off is an active scope
      pausedNow ||
      hasActiveThrottle(s); // P-006/P-009: a throttle-only steering still surfaces in the brief
    if (!active) return undefined;
    return pausedNow ? s : { ...s, pauseNewWork: false, pausedUntil: null };
  } catch {
    return undefined;
  }
}

/**
 * The registered hives split by their per-pot placement bit (per-pot
 * start-stop 2026-06-30). `stopped` feeds the survey's stop-list so a Stopped
 * pot's frontier + plan work is withheld from the Mug; `started` is her
 * POSITIVE scope (owner model 2026-07-01: "the workspace Mug works ANY
 * started pot") — unioned into the survey scope so a members-wired home pot
 * cannot hide other started hives from her. Fail-open per pot (a read error ⇒
 * treat as started/not-stopped, so we never over-withhold on a DB hiccup). A
 * pot born with no started row reads stopped — consistent with "a pot is
 * born paused" + the orchestrator placement gate.
 */
export async function computePotPlacementSplit(
  workspaceId: string,
): Promise<{ started: string[]; stopped: string[] }> {
  const [{ listPots }, { getPotPlacementStarted }] = await Promise.all([
    import('../agent-tools/pot/_resolve'),
    import('./started'),
  ]);
  const hives = await listPots(workspaceId).catch(() => [] as Array<{ slug: string }>);
  const bits = await Promise.all(
    hives.map((h) => getPotPlacementStarted(workspaceId, h.slug).catch(() => true)),
  );
  return {
    started: hives.filter((_, i) => bits[i]).map((h) => h.slug),
    stopped: hives.filter((_, i) => !bits[i]).map((h) => h.slug),
  };
}

export async function computeMugWakeBrief(
  workspaceId: string,
  installSlug: string,
  opts: { wokeBy?: string } = {},
): Promise<string | null> {
  try {
    // mug-steering-panel C-2 (P-003): read owner-steering ONCE up front (via the
    // B-02 gatherOwnerSteering normalizer — returns the ACTIVE steering, or undefined
    // when un-steered / expired) so it serves BOTH the survey's scopeFilter (scope +
    // pause AT THE SOURCE) AND the brief's directive section. A pause empties the
    // frontier (no new work); eligiblePlans restricts the plan view. The scopeFilter is
    // built ONLY when steering actually constrains, so an un-steered Pot calls
    // surveyPot exactly as before (fully backward-compatible).
    const ownerSteering = await gatherOwnerSteering(workspaceId, installSlug);
    // Per-pot Stop (per-pot start-stop 2026-06-30): the STOPPED registered hives
    // whose frontier + plan work the Mug must withhold. A stop-list (not an
    // allow-list) so standalone / unhived / started work is never regressed.
    // Fail-open ([] on error). Independent of steering, so a Stop gates even when
    // no other steering is active.
    const placementSplit = await computePotPlacementSplit(workspaceId).catch(
      () => ({ started: [] as string[], stopped: [] as string[] }),
    );
    const stoppedHarnesses = placementSplit.stopped;
    const steeringActive = !!ownerSteering && (
      ownerSteering.pauseNewWork ||
      ownerSteering.pausedUntil != null ||
      ownerSteering.eligiblePlans.length > 0 ||
      ownerSteering.eligiblePots.length > 0 ||
      ownerSteering.includeUnplannedWork === false
    );
    const scopeFilter: ScopeFilter | undefined =
      steeringActive || stoppedHarnesses.length > 0
        ? {
            ...(ownerSteering && ownerSteering.eligiblePlans.length > 0 ? { eligiblePlans: ownerSteering.eligiblePlans } : {}),
            // Eligible Pots → the survey's allowedHarnesses scope (C-2, su-266): the
            // Mug may place only into these hives/harnesses (B-04 round-2).
            ...(ownerSteering && ownerSteering.eligiblePots.length > 0 ? { allowedHarnesses: ownerSteering.eligiblePots } : {}),
            // "Non-plan work items" toggle OFF → drop loose frontier work (decouple 2026-06-30).
            ...(ownerSteering && ownerSteering.includeUnplannedWork === false ? { includeUnplannedWork: false } : {}),
            ...(ownerSteering && ownerSteering.pauseNewWork ? { pauseNewWork: true } : {}),
            ...(ownerSteering && ownerSteering.pausedUntil != null ? { pausedUntil: ownerSteering.pausedUntil } : {}),
            // Per-pot Stop: withhold explicitly-stopped hives' work (stop-list).
            ...(stoppedHarnesses.length > 0 ? { stoppedHarnesses } : {}),
          }
        : undefined;

    // surveyPot is the CORE — if it throws, the whole brief is null and she falls
    // back to the survey tools. The other reads are individually fail-soft so one
    // flaky read degrades that section, never the whole brief (D-004 / D-014):
    //  - openPlacements (watchdog completion-state) — summarizeOpenPlacements is
    //    internally fail-soft (returns empty);
    //  - carryNote / escalations — wrapped here.
    const [survey, carryJournal, openPlacements, escalations, changeFeed, cups, inbox, overwatchAlive, capacity] =
      await Promise.all([
        // extraSurveySlugs = the STARTED hives (owner model 2026-07-01): the
        // workspace Mug's survey covers EVERY started pot, not just the home
        // pot's membership — the start/stop popup is the scope control.
        surveyPot(workspaceId, installSlug, {
          ...(scopeFilter ? { scopeFilter } : {}),
          ...(placementSplit.started.length > 0 ? { extraSurveySlugs: placementSplit.started } : {}),
        }),
        getPotCarryJournal(workspaceId).catch(() => []),
        summarizeOpenPlacements(workspaceId, installSlug),
        gatherEscalations(),
        gatherRecentChanges(),
        gatherCups(workspaceId),
        gatherInbox(workspaceId, installSlug),
        gatherOverwatchLiveness(workspaceId, installSlug),
        gatherCapacity(),
      ]);
    const wokeBy = opts.wokeBy?.trim();
    const floor = floorFromSurvey(survey, {
      // EI-3419: ground-truth pot anchor — her carry-note/journal is
      // workspace-scoped (shared across every started pot), so this is the
      // only per-wake signal that reliably says which pot THIS brief is for.
      potSlug: installSlug,
      ...(wokeBy ? { wokeBy } : {}),
      openPlacements,
      ...(escalations.length > 0 ? { escalations } : {}),
      ...(changeFeed.length > 0 ? { changeFeed } : {}),
      ...(cups.length > 0 ? { cups } : {}),
      ...(inbox.length > 0 ? { inbox } : {}),
      ...(overwatchAlive !== undefined ? { overwatchAlive } : {}),
      ...(capacity ? { capacity } : {}),
      ...(ownerSteering ? { ownerSteering } : {}),
    });
    // L1c: standing-facts fold — deterministic, fail-soft (a facts outage must
    // never block the brief). workspace + role:mug + this pot's harness scope.
    const factsFold = await import('../agent-facts/store')
      .then(async (m) =>
        m.renderFactsFold(
          await m.foldFacts(
            [
              { scope: 'workspace' },
              { scope: 'role', scopeRef: 'mug' },
              { scope: 'harness', scopeRef: installSlug },
            ],
            { workspaceId },
          ),
        ),
      )
      .catch(() => '');
    // L1d: mem0 background recall — fuzzy sibling of the facts fold. Harness
    // memory pool only (the Mug is not a user), timeout-bounded, fail-soft.
    const memoryFold = await (async () => {
      const { getMemoryBackend } = await import('../memory/backend');
      const { withMemoryToolTimeout } = await import('../memory/op-deadline');
      const hits = await withMemoryToolTimeout(
        getMemoryBackend().search(`mug ${installSlug} pot operations priorities`, {
          scope: [`harness:${installSlug}`],
          limit: 3,
        }),
        'mug-brief memory recall',
      );
      const lines = (hits ?? [])
        .slice(0, 3)
        .map((h) => (h.text?.trim() ? `- ${h.text.trim().slice(0, 200)}` : ''))
        .filter(Boolean);
      return lines.length
        ? `### Background recall (fuzzy memory — may be stale; the standing facts above are authoritative)\n${lines.join('\n')}`
        : '';
    })().catch(() => '');
    return renderMugBrief({ floor, carryJournal, factsFold, memoryFold });
  } catch (err) {
    console.warn(
      `[mug-brief] precompute failed for '${installSlug}' — Mug falls back to the survey tools:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
