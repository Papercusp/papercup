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
import { surveyPot, resolvePotMembership, type ScopeFilter } from './survey';
import { getPotCarryJournal } from './wake';
import { summarizeOpenPlacements, resolveMugOwner } from './placement-watchdog';
import { listEscalations } from '../agent-tools/coordination/escalations';
import { readTriagedHandledItemIds } from '../attention/triage-store';
import { isOperationalEscalation } from '../attention/adapters';
import { gatherCompletions } from '../curation/change-feed';
import { buildChangeFeedReaders } from '../curation/change-feed-deps';
import { gatherLiveCups } from '../fleet/placement-gather';
import { readInbox } from '../agent-tools/coordination/messages';
import { drainSlotMessages } from '../agent-tools/coordination/slot-parked-store';
import { runWithWorkspace } from '../workspace-als';
import { getOrgPg } from '@papercusp/db-org';
import type { CoordEnvelope } from '@papercusp/coordination/core';
import { renderMugBrief, floorFromSurvey, type BriefEscalation, type BriefCup, type BriefInboxItem, type BriefCapacity } from './mug-brief';
import { overwatchAliveForQueen } from '../overwatch/cross-monitor';
import { potHomeSlugForHarness } from '../hive-federation';
import { getOwnerSteering, isPausedNow, hasActiveThrottle, steeringModelSpecDrift, type OwnerSteering } from '../owner-steering';
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
 *  gatherLiveCups already excludes non-cups + joins load/liveness; fail-soft.
 *
 *  `hiveHarnesses` (EI-6176): gatherLiveCups reads WORKSPACE-WIDE (it has no
 *  harness/hive concept of its own — every other caller, place_batch/
 *  system-health, legitimately wants that). When THIS pot is Hive-federation
 *  confined (see resolveMugScope's scopeHive), a sibling hive's cups (e.g. a
 *  bee doing a DIFFERENT hive's work-item) must not leak into her brief the
 *  way her direct tool calls to that hive are already rejected
 *  (harness_forbidden) — so filter to the caller's own hive subtree when set;
 *  `undefined` (not hive-confined) keeps today's unrestricted behaviour. */
async function gatherCups(workspaceId: string, hiveHarnesses?: ReadonlySet<string>): Promise<BriefCup[]> {
  try {
    const cups = await gatherLiveCups(workspaceId);
    const scoped = hiveHarnesses ? cups.filter((b) => !b.harness || hiveHarnesses.has(b.harness)) : cups;
    return scoped.map((b) => ({
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
        // The repeatCount overlay is untyped on EscalationRecord — read it via an
        // optional-unknown view (a direct `{ repeatCount: number }` cast is TS2352:
        // the types don't sufficiently overlap).
        const rawRepeat = (e as { repeatCount?: unknown }).repeatCount;
        const repeatCount = typeof rawRepeat === 'number' ? Math.max(1, Math.floor(rawRepeat)) : 1;
        // CoordEnvelope.summary is optional; escalations always carry one at
        // runtime (openEscalation requires it) — coalesce for the type.
        const summary = e.summary ?? '';
        return {
          id: `escalation:${e.msg_id}`,
          severity: e.severity,
          summary: repeatCount > 1 ? `${summary} (x${repeatCount})` : summary,
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
    // Bounded read (EI-19323045109346905). Two things make `limit` the exactly
    // sufficient stopping rule here, and both need stating because this call site
    // merges a SECOND source below:
    //  1. count POST-filter — the `!e.category` drop happens below, and ambient
    //     rows arrive in long runs, so a raw `entries.length >= limit` rule would
    //     be satisfied by noise and under-fill the tail;
    //  2. merging `slotRows` afterwards cannot need MORE inbox history, only less:
    //     the newest `limit` of the merged set can only contain inbox rows that are
    //     already among the newest `limit` inbox rows.
    const inboxRows = await runWithWorkspace(workspaceId, () =>
      readInbox(mugOwner, {}, { enough: (entries) => entries.filter((e) => !e.category).length >= limit }),
    ).catch(() => [] as CoordEnvelope[]);
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
      s.eligibleHives.length > 0 ||
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

/**
 * EI-6176: when `installSlug` is itself a Hive-federation home (see
 * hive-federation.ts `potHomeSlugForHarness`), the wake-brief's cross-pot
 * additions (the "owner model 2026-07-01" extraSurveySlugs expansion below,
 * and the live-cup gather) must stay confined to THAT SAME hive — a sibling
 * hive's frontier/plans/bee-load are already tool-call-rejected for this
 * session (`harness_forbidden`, P-014a, owner-ratified 2026-06-18), so
 * silently including them in the PRECOMPUTED brief just wastes her
 * round-trips discovering a boundary she can't act across anyway (the filed
 * incident: an oddsmith-hive Queen's brief listed 12 papercusp-tagged
 * frontier items + a papercusp bee, neither of which she could place/message
 * once she tried). Non-hive deployments — the overwhelming majority;
 * `potHomeSlugForHarness` returns `null` for a plain (non-federated) pot —
 * are completely unaffected: `scopeHive` is `null` and every caller keeps
 * today's full workspace-wide behaviour byte-for-byte.
 */
async function resolveHiveConfinement(
  workspaceId: string,
  installSlug: string,
  candidateSlugs: readonly string[],
): Promise<{ scopeHive: string | null; sameHiveSlugs: string[]; hiveHarnesses: Set<string> | undefined }> {
  const scopeHive = await potHomeSlugForHarness(workspaceId, installSlug).catch(() => null);
  if (!scopeHive) return { scopeHive: null, sameHiveSlugs: [...candidateSlugs], hiveHarnesses: undefined };
  const homes = await Promise.all(
    candidateSlugs.map((slug) => potHomeSlugForHarness(workspaceId, slug).catch(() => null)),
  );
  const sameHiveSlugs = candidateSlugs.filter((_, i) => homes[i] === scopeHive);
  // The concrete harness set her OWN hive covers (home + declared registry
  // members, per resolvePotMembership) UNIONED with the now-confined
  // cross-pot slugs above — defaults to just the home when membership isn't
  // wired (conservative: under-include rather than fall through to
  // workspace-wide, mirroring the P-014a enforcement's own fail-closed bias).
  const membership = await resolvePotMembership(workspaceId, scopeHive).catch(() => null);
  const hiveHarnesses = new Set<string>([
    scopeHive,
    ...(membership && membership.surveySlugs.length > 0 ? membership.surveySlugs : []),
    ...sameHiveSlugs,
  ]);
  return { scopeHive, sameHiveSlugs, hiveHarnesses };
}

/**
 * Resolve the Mug's steering + placement scope ONCE — the shared front half of
 * BOTH `computeMugWakeBrief` (the Mug's wake prompt) and
 * `computeMugBriefFloorView` (the sidebar's pot-status projection,
 * operator-chat-sidebar-revival-2026-07-13 P-018), so the UI shows the SAME
 * filtered world the Mug is actually briefed with — never a parallel view.
 */
async function resolveMugScope(
  workspaceId: string,
  installSlug: string,
): Promise<{
  ownerSteering: OwnerSteering | undefined;
  scopeFilter: ScopeFilter | undefined;
  placementSplit: { started: string[]; stopped: string[] };
  /** EI-6176: the caller's own hive's harness subtree, when hive-confined — undefined for a non-hive pot. */
  hiveHarnesses: Set<string> | undefined;
}> {
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
  const rawPlacementSplit = await computePotPlacementSplit(workspaceId).catch(
    () => ({ started: [] as string[], stopped: [] as string[] }),
  );
  // EI-6176: confine the cross-pot `started` expansion to the caller's own hive
  // (a no-op for a non-hive pot — see resolveHiveConfinement).
  const { sameHiveSlugs, hiveHarnesses } = await resolveHiveConfinement(
    workspaceId,
    installSlug,
    rawPlacementSplit.started,
  );
  const placementSplit = { started: sameHiveSlugs, stopped: rawPlacementSplit.stopped };
  const stoppedHarnesses = placementSplit.stopped;
  const steeringActive = !!ownerSteering && (
    ownerSteering.pauseNewWork ||
    ownerSteering.pausedUntil != null ||
    ownerSteering.eligiblePlans.length > 0 ||
    ownerSteering.eligibleHives.length > 0 ||
    ownerSteering.includeUnplannedWork === false
  );
  const scopeFilter: ScopeFilter | undefined =
    steeringActive || stoppedHarnesses.length > 0
      ? {
          ...(ownerSteering && ownerSteering.eligiblePlans.length > 0 ? { eligiblePlans: ownerSteering.eligiblePlans } : {}),
          // Eligible Pots → the survey's allowedHarnesses scope (C-2, su-266): the
          // Mug may place only into these hives/harnesses (B-04 round-2).
          ...(ownerSteering && ownerSteering.eligibleHives.length > 0 ? { allowedHarnesses: ownerSteering.eligibleHives } : {}),
          // "Non-plan work items" toggle OFF → drop loose frontier work (decouple 2026-06-30).
          ...(ownerSteering && ownerSteering.includeUnplannedWork === false ? { includeUnplannedWork: false } : {}),
          ...(ownerSteering && ownerSteering.pauseNewWork ? { pauseNewWork: true } : {}),
          ...(ownerSteering && ownerSteering.pausedUntil != null ? { pausedUntil: ownerSteering.pausedUntil } : {}),
          // Per-pot Stop: withhold explicitly-stopped hives' work (stop-list).
          ...(stoppedHarnesses.length > 0 ? { stoppedHarnesses } : {}),
        }
      : undefined;
  return { ownerSteering, scopeFilter, placementSplit, hiveHarnesses };
}

export async function computeMugWakeBrief(
  workspaceId: string,
  installSlug: string,
  opts: { wokeBy?: string } = {},
): Promise<string | null> {
  try {
    const { ownerSteering, scopeFilter, placementSplit, hiveHarnesses } = await resolveMugScope(
      workspaceId,
      installSlug,
    );

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
        // EI-6176: placementSplit.started is already confined to the caller's
        // own hive (resolveHiveConfinement, above) when hive-confined — a
        // no-op list expansion for a non-hive pot.
        surveyPot(workspaceId, installSlug, {
          ...(scopeFilter ? { scopeFilter } : {}),
          ...(placementSplit.started.length > 0 ? { extraSurveySlugs: placementSplit.started } : {}),
        }),
        getPotCarryJournal(workspaceId).catch(() => []),
        summarizeOpenPlacements(workspaceId, installSlug),
        gatherEscalations(),
        gatherRecentChanges(),
        // EI-6176: scope live-cup gather to the caller's own hive subtree when
        // confined — a sibling hive's bee-load must not leak into her floor.
        gatherCups(workspaceId, hiveHarnesses),
        gatherInbox(workspaceId, installSlug),
        gatherOverwatchLiveness(workspaceId, installSlug),
        gatherCapacity(),
      ]);
    // EI-12807: model-spec drift — specs this pot's steering pins that dropped out
    // of the committed tier menu (a global tier-menu fix the per-pot override can't
    // see). Fail-soft: an unreadable agent-config falls back to the committed default
    // menu inside steeringModelSpecDrift. Only when the pot is actually steered.
    let ownerSteeringModelSpecDrift: string[] = [];
    if (ownerSteering) {
      try {
        const { readAgentConfig } = await import('../agent-config');
        const cfg = await readAgentConfig();
        ownerSteeringModelSpecDrift = steeringModelSpecDrift(ownerSteering, cfg.tiers ?? []);
      } catch {
        ownerSteeringModelSpecDrift = steeringModelSpecDrift(ownerSteering, []);
      }
    }
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
      ...(ownerSteeringModelSpecDrift.length > 0 ? { ownerSteeringModelSpecDrift } : {}),
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
    // memory pool (the Mug is not a user), timeout-bounded, fail-soft.
    //
    // EI-10015: previously a bespoke `getMemoryBackend().search(..., { scope:
    // [`harness:${installSlug}`] })` — this queried the harness pool ONLY and
    // structurally EXCLUDED the hive:<slug> pool entirely, so knowledge-pack
    // seeded rows and pot-organic conventions (both land in hive scope, per
    // lib/memory/hive-scope.ts) never reached the Mug. It also bypassed the
    // shared injection pipeline (no floors / dedup / muted-pack / tombstones).
    //
    // memory-delivery-unification-2026-07-12 P-004 (D-005): the WHAT now comes
    // from the launch-profile resolver — one targeted query per top frontier
    // candidate this wake is about to place (the most-specific work statement
    // the Mug has), never the old blended "mug <pot> operations priorities"
    // mega-query. An empty frontier degrades to the harness rung (pot
    // identity/conventions). The WHERE stays the harness dims — hive pool
    // resolution happens inside injection.ts as before.
    const memoryFold = await (async () => {
      const { resolveLaunchProfile, buildLaunchMemoryBlock } = await import(
        '../memory/launch-profile'
      );
      const profile = resolveLaunchProfile({
        harnessSlug: installSlug,
        claimedItemTitles: floor.frontier.slice(0, 3).map((c) => c.title || c.id),
      });
      const block = await buildLaunchMemoryBlock({
        profile,
        workspaceId,
        limit: 3,
        // P-005: tag this recall as the 'brief' surface. No dedup session —
        // the Mug loop has no compaction epoch to reset, so a session would
        // permanently suppress a memory after the first wake.
        telemetrySurface: 'brief',
        heading: 'Background recall (fuzzy memory — may be stale; the standing facts above are authoritative)',
      });
      return block ?? '';
    })().catch(() => '');
    return renderMugBrief({ floor, carryJournal, factsFold, memoryFold });
  } catch (err) {
    // EI-9288: this catch previously logged only `err.message`, which for a
    // bare `TypeError: Cannot read properties of undefined (reading 'length')`
    // gives no file/line — every occurrence was undiagnosable after the fact.
    // Log the stack (falls back to the bare value for a non-Error throw) so
    // the NEXT occurrence points straight at the throwing call site instead
    // of re-starting this same code-reading investigation from scratch.
    console.warn(
      `[mug-brief] precompute failed for '${installSlug}' — Mug falls back to the survey tools:`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    return null;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The sidebar's pot-status projection (operator-chat-sidebar-revival P-018).
 *
 * A compact, CLIENT-SAFE view of the same floor the Mug is briefed with —
 * consumed by the `mugBrief.floorView` sync resolver → the operator chat
 * sidebar's pot-health view. Reuses the SAME scope resolution + gather
 * functions as `computeMugWakeBrief` (reuse-first, no parallel data path); a
 * lighter subset (no inbox / change-feed — those stay agent-internal per the
 * P-016 owner selection). WI-4778 widened the original cut with `capacity` +
 * `carryNote`: the full-height Pot Health view's mandate is "show what the Mug
 * decides FROM", and the capacity digest + her carry-note are decision inputs
 * the owner explicitly asked to see. Every read is fail-soft so a flaky source
 * degrades one section, never the whole panel.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One ranked ready-to-place frontier row, projected for the UI. */
export interface FloorViewFrontierItem {
  id: string;
  title: string;
  /** 'plan' | 'work-item' — what the id refers to. */
  view: string;
  harness: string;
}

export interface MugBriefFloorView {
  potSlug: string;
  /** Epoch ms this view was computed (client renders staleness honestly). */
  computedAt: number;
  /** Live cups: id · doing · load · alive (BriefCup, verbatim). */
  cups: BriefCup[];
  /** Top of the ready frontier in Mug rank order (capped). */
  frontier: FloorViewFrontierItem[];
  /** Total ready count (frontier may be capped below this). */
  frontierTotal: number;
  frontierBlocked: number;
  frontierQuarantined: number;
  /** RECONCILE frontier (EI-13695): attempted items a dead cup left un-converged —
   *  excluded from `frontier`; they need convergence, not placement. */
  frontierReconcile: number;
  /** Placement watchdog counts — the "why is nothing moving" footer. */
  openPlacements: { recovering: number; stranded: number; workingTracked: number };
  /** Open escalations needing the owner (BriefEscalation, verbatim). */
  escalations: BriefEscalation[];
  /** The steering the Mug honors — null when un-steered. */
  steering: {
    directive: string | null;
    pauseNewWork: boolean;
    pausedUntil: number | null;
    eligiblePlans: string[];
  } | null;
  /** Live inference-pool capacity digest she sizes batches to (WI-4778) —
   *  null when the gateway is off/unreachable (fail-soft, never misleading). */
  capacity: BriefCapacity | null;
  /** Her newest carry-note (the self-authored "where I left off" her next wake
   *  reads first) — null when she carried nothing (WI-4778). */
  carryNote: { at: number; note: string } | null;
}

/** Frontier rows surfaced to the sidebar before the "+N more" footer. */
const FLOOR_VIEW_FRONTIER_CAP = 8;

/** Carry-note chars surfaced to the UI before truncation (the full note is
 *  agent-internal; the view wants the head, not the journal). */
const FLOOR_VIEW_CARRY_NOTE_CAP = 280;

/**
 * Project the newest carry-journal entry into the floor view's `carryNote`
 * (WI-4778). Pure — unit-tested directly. Newest-first input (the
 * `getPotCarryJournal` contract); blank notes are skipped so a cleared note
 * doesn't render as an empty card.
 */
export function carryNoteHead(
  journal: ReadonlyArray<{ at: number; note: string }>,
  cap = FLOOR_VIEW_CARRY_NOTE_CAP,
): { at: number; note: string } | null {
  const head = journal.find((e) => e.note.trim().length > 0);
  if (!head) return null;
  const note = head.note.trim();
  return { at: head.at, note: note.length > cap ? `${note.slice(0, cap - 1)}…` : note };
}

export async function computeMugBriefFloorView(
  workspaceId: string,
  installSlug: string,
): Promise<MugBriefFloorView> {
  const { ownerSteering, scopeFilter, placementSplit, hiveHarnesses } = await resolveMugScope(
    workspaceId,
    installSlug,
  );
  const empty = { frontier: [], plans: [], frontierBlocked: 0, frontierQuarantined: 0, frontierReconcile: 0, reconcileRows: [] };
  const [survey, cups, escalations, openPlacements, capacity, carryJournal] = await Promise.all([
    surveyPot(workspaceId, installSlug, {
      ...(scopeFilter ? { scopeFilter } : {}),
      ...(placementSplit.started.length > 0 ? { extraSurveySlugs: placementSplit.started } : {}),
    }).catch(() => empty as unknown as Awaited<ReturnType<typeof surveyPot>>),
    // EI-6176: scope live-cup gather to the caller's own hive subtree when
    // confined — the sidebar shows the SAME filtered world the Mug is briefed
    // with (this file's own stated contract), never a cross-hive leak.
    gatherCups(workspaceId, hiveHarnesses),
    gatherEscalations(),
    summarizeOpenPlacements(workspaceId, installSlug),
    // WI-4778: the pot-health view renders her capacity + carry-note decision
    // inputs. Both fail-soft to null — a dark gateway / journal read degrades
    // one card, never the view.
    gatherCapacity().catch(() => undefined),
    getPotCarryJournal(workspaceId).catch(() => [] as Array<{ at: number; note: string }>),
  ]);
  return {
    potSlug: installSlug,
    computedAt: Date.now(),
    cups,
    frontier: survey.frontier.slice(0, FLOOR_VIEW_FRONTIER_CAP).map((r) => ({
      id: r.id,
      title: r.title,
      view: r.view,
      harness: r.harness,
    })),
    frontierTotal: survey.frontier.length,
    frontierBlocked: survey.frontierBlocked ?? 0,
    frontierQuarantined: survey.frontierQuarantined ?? 0,
    frontierReconcile: survey.frontierReconcile ?? 0,
    openPlacements: {
      recovering: openPlacements.recovering,
      stranded: openPlacements.stranded,
      workingTracked: openPlacements.workingTracked,
    },
    escalations,
    steering: ownerSteering
      ? {
          directive: ownerSteering.directive,
          pauseNewWork: ownerSteering.pauseNewWork,
          pausedUntil: ownerSteering.pausedUntil,
          eligiblePlans: ownerSteering.eligiblePlans,
        }
      : null,
    capacity: capacity ?? null,
    carryNote: carryNoteHead(carryJournal),
  };
}
