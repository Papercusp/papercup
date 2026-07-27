/**
 * compute.test — the aggregator's FAIL-SOFT contract (system-health-tab-2026-06-15
 * P-006 / Phase 4, D-003). A throwing collector greys ITS panel (`unknown` + the
 * error) and never blanks the snapshot. Pure: tests `panelSafe` (the per-panel
 * isolation) directly — no DB. The full DB-backed `computeSystemHealth` is
 * exercised live by the ~30s tick + the sync-resolver dispatch test.
 */
import { describe, it, expect, vi } from 'vitest';
import { panelSafe, computeEscalationsHealth, probeGatewayHealthz, observationRole, overwatchScorecardSkipped, scoutHealthVerdict, suIdeateVerdict, crossesProvenanceDivergenceThreshold, PROVENANCE_DIVERGENCE_WARN_THRESHOLD, splitAutoEligibleStuck, tallyPlans, toolEfficiencyStatus, countStuckFrontier, isLiveRigOnlyFrontierTitle, computeAccountsAvailable, computeStalePausedRoutines, deadRoutineOverdueMsForCiWindow, mergeHealthPanels, type EscalationAgingInput, type StalePausedRoutineInput } from './compute';
import { queenPlacementStalled, countLeadingZeroTokenWakes } from './thresholds';
import { PANEL_LABELS, PANEL_ORDER } from './types';
import type { ClaudeAccount } from '../deployment/account-pool';
import type { HealthPanel, PanelKey, PanelStatus, SystemHealth, SystemHealthPanels } from './types';

describe('splitAutoEligibleStuck — keyed dispatcher-stuck vs keyless human-review backlog (EI-14223)', () => {
  it('counts only KEYED, attempts:0 items as autoEligibleStuck', () => {
    const r = splitAutoEligibleStuck([
      { attempts: 0, watchdogKey: 'dispatcher-staleness:auto-implement-dispatcher' },
      { attempts: 0, watchdogKey: 'some-watchdog:key' },
      { attempts: 1, watchdogKey: 'in-flight:key' }, // already dispatched — excluded
    ]);
    expect(r.autoEligibleStuck).toBe(2);
    expect(r.keylessHumanReviewBacklog).toBe(0);
  });

  it('counts KEYLESS (no watchdogKey), attempts:0 items as keylessHumanReviewBacklog, never autoEligibleStuck', () => {
    const r = splitAutoEligibleStuck([
      { attempts: 0 }, // manually captured, no watchdogKey
      { attempts: 0, watchdogKey: undefined },
      { attempts: 1 }, // keyless but already attempted — excluded from both
    ]);
    expect(r.autoEligibleStuck).toBe(0);
    expect(r.keylessHumanReviewBacklog).toBe(2);
  });

  it('does not let a large keyless pile inflate autoEligibleStuck (the EI-14223 false-alarm repro)', () => {
    const keyless = Array.from({ length: 200 }, () => ({ attempts: 0 }));
    const keyed = [{ attempts: 0, watchdogKey: 'dispatcher-staleness:auto-implement-dispatcher' }];
    const r = splitAutoEligibleStuck([...keyless, ...keyed]);
    expect(r.autoEligibleStuck).toBe(1);
    expect(r.keylessHumanReviewBacklog).toBe(200);
  });

  it('returns zeros for an empty input', () => {
    expect(splitAutoEligibleStuck([])).toEqual({ autoEligibleStuck: 0, keylessHumanReviewBacklog: 0 });
  });
});

describe('observationRole — per-role attribution (close-observation-attribution-gap 2026-06-21)', () => {
  it('prefers the stamped payload.filedByRole', () => {
    expect(observationRole({ payload: { filedByRole: 'kettle' }, signalOrigin: 'organic' })).toBe('kettle');
  });
  it('falls back to sourceRole, then signalOrigin, then unknown', () => {
    expect(observationRole({ payload: {}, sourceRole: 'Scout' })).toBe('Scout');
    expect(observationRole({ payload: null, signalOrigin: 'organic' })).toBe('organic');
    expect(observationRole({})).toBe('unknown');
  });
  it('reads the REAL row fields, not the prior phantom `it.origin`/top-level `sourceRole`', () => {
    // EngineerIssue carries `payload` + `signalOrigin`, NEVER a top-level `origin`
    // nor (for tool captures) `sourceRole` — the old `it.sourceRole ?? it.origin`
    // read undefined on both → bucketed 100% as 'unknown'.
    expect(observationRole({ payload: { filedByRole: 'cup' } })).toBe('cup');
  });
});

describe('overwatchScorecardSkipped — monitor-the-monitor (hive-loop-supervision 2026-06-21)', () => {
  const base = { alive: true as boolean | null, lastWakeAt: 1_000_000, now: 1_000_000 + 6 * 60_000, freshnessStatus: 'stale' as const };
  it('skipped when alive + settled past grace + not fresh', () => {
    expect(overwatchScorecardSkipped(base)).toBe(true);
    expect(overwatchScorecardSkipped({ ...base, freshnessStatus: 'partial-only' })).toBe(true);
  });
  it('NOT skipped when fresh', () => {
    expect(overwatchScorecardSkipped({ ...base, freshnessStatus: 'fresh' })).toBe(false);
  });
  it('NOT skipped within the grace (turn may still be in flight — no mid-turn false positive)', () => {
    expect(overwatchScorecardSkipped({ ...base, now: base.lastWakeAt + 60_000 })).toBe(false);
  });
  it('NOT skipped when dark (alive:false) or never woke (lastWakeAt:null)', () => {
    expect(overwatchScorecardSkipped({ ...base, alive: false })).toBe(false);
    expect(overwatchScorecardSkipped({ ...base, lastWakeAt: null })).toBe(false);
  });
});

describe('scoutHealthVerdict — ideation observability (hive-loop-supervision 2026-06-21)', () => {
  const now = 1_000_000_000;
  const t = (agoMs: number, status: string, ideas?: number) => ({ status, ideasGenerated: ideas, tickAt: new Date(now - agoMs).toISOString() });
  it('transport-death: cycles RAN in-window but 0 ideas', () => {
    const v = scoutHealthVerdict([t(60_000, 'ran', 0), t(120_000, 'ran', 0)], now);
    expect(v.transportDeath).toBe(true);
    expect(v.ranInWindow).toBe(2);
    expect(v.ideasInWindow).toBe(0);
  });
  it('healthy: cycles ran with ideas (newest run + window sum)', () => {
    const v = scoutHealthVerdict([t(60_000, 'ran', 5), t(120_000, 'ran', 3)], now);
    expect(v.transportDeath).toBe(false);
    expect(v.ideasInWindow).toBe(8);
    expect(v.ideasLastRun).toBe(5);
  });
  it('only gated/idle ticks → NOT transport-death (no full cycle = unknown, not dead)', () => {
    const v = scoutHealthVerdict([t(60_000, 'gated'), t(120_000, 'gated')], now);
    expect(v.transportDeath).toBe(false);
    expect(v.ranInWindow).toBe(0);
    expect(v.lastRanAt).toBeNull();
  });
  it('window-bounds the ran tally but lastTickAt is the newest overall', () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const v = scoutHealthVerdict([t(dayMs + 60_000, 'ran', 9)], now); // older than 24h
    expect(v.ranInWindow).toBe(0);
    expect(v.transportDeath).toBe(false);
    expect(v.lastTickAt).not.toBeNull();
  });
});

describe('crossesProvenanceDivergenceThreshold — WI-6338 recurrence guard', () => {
  it('below the default threshold does not cross', () => {
    expect(crossesProvenanceDivergenceThreshold(0)).toBe(false);
    expect(crossesProvenanceDivergenceThreshold(PROVENANCE_DIVERGENCE_WARN_THRESHOLD)).toBe(false);
  });
  it('above the default threshold crosses', () => {
    expect(crossesProvenanceDivergenceThreshold(PROVENANCE_DIVERGENCE_WARN_THRESHOLD + 0.01)).toBe(true);
    // The live measurement that motivated WI-6338 (422/825 agreed everywhere).
    expect(crossesProvenanceDivergenceThreshold(1 - 422 / 825)).toBe(true);
  });
  it('a custom threshold overrides the default', () => {
    expect(crossesProvenanceDivergenceThreshold(0.5, 0.6)).toBe(false);
    expect(crossesProvenanceDivergenceThreshold(0.5, 0.4)).toBe(true);
  });
  it('non-finite input never crosses (fail closed, never a phantom warn)', () => {
    expect(crossesProvenanceDivergenceThreshold(NaN)).toBe(false);
    expect(crossesProvenanceDivergenceThreshold(Infinity)).toBe(false);
  });
});

describe('suIdeateVerdict — the su-ideate partition (WI-4465)', () => {
  const now = 1_000_000_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const p = (agoMs: number, filed?: number, status = 'ran') => ({ status, ideasRouted: filed, tickAt: new Date(now - agoMs).toISOString() });
  it('counts in-window passes and sums their filed ideas', () => {
    const v = suIdeateVerdict([p(60_000, 3), p(120_000, 2)], now);
    expect(v.passesInWindow).toBe(2);
    expect(v.ideasFiled).toBe(5);
    expect(v.lastPassAt).toBe(now - 60_000);
  });
  it('window-bounds the tally but lastPassAt is the newest pass overall', () => {
    const v = suIdeateVerdict([p(dayMs + 60_000, 9)], now);
    expect(v.passesInWindow).toBe(0);
    expect(v.ideasFiled).toBe(0);
    expect(v.lastPassAt).toBe(now - (dayMs + 60_000));
  });
  it('empty ledger → zeros with a null lastPassAt', () => {
    const v = suIdeateVerdict([], now);
    expect(v).toEqual({ passesInWindow: 0, ideasFiled: 0, lastPassAt: null });
  });
  it('a non-ran row never inflates the pass count', () => {
    const v = suIdeateVerdict([p(60_000, 4, 'gated'), p(120_000, 1)], now);
    expect(v.passesInWindow).toBe(1);
    expect(v.ideasFiled).toBe(1);
  });
});

describe('countLeadingZeroTokenWakes / queenPlacementStalled — Queen placement liveness (hive-loop-supervision 2026-06-21, D-009)', () => {
  const z = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const nz = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 0 };
  it('counts leading consecutive 0-token wakes (newest-first), stopping at the first non-zero', () => {
    expect(countLeadingZeroTokenWakes([z, z, z, nz, z])).toBe(3);
    expect(countLeadingZeroTokenWakes([nz, z, z])).toBe(0);
    expect(countLeadingZeroTokenWakes([])).toBe(0);
  });
  it('fires when ≥3 consecutive 0-token wakes + placeable frontier + not paused', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 3, frontier: 7, paused: false })).toBe(true);
  });
  it('does NOT fire when frontier=0 (nothing to place)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 9, frontier: 0, paused: false })).toBe(false);
  });
  it('does NOT fire when a recent wake spent tokens (leading-zero count < threshold)', () => {
    const n = countLeadingZeroTokenWakes([nz, z, z, z]); // 0 — newest wake ran the LLM
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: n, frontier: 7, paused: false })).toBe(false);
  });
  it('does NOT fire when paused', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 5, frontier: 7, paused: true })).toBe(false);
  });
  it('does NOT fire below the consecutive threshold (one-off blip)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 2, frontier: 7, paused: false })).toBe(false);
  });
  it('does NOT fire when the bee fleet is already full (no capacity)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 5, frontier: 7, paused: false, beesBusy: 24, beesCap: 24 })).toBe(false);
  });
  // WI-3597: frontierStuck subtracts long-unplaced/gated items so an all-gated
  // frontier reads as correct idle, not a placement stall.
  it('does NOT fire when the ENTIRE frontier is long-stuck/gated (fresh=0)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 9, frontier: 7, frontierStuck: 7, paused: false })).toBe(false);
  });
  it('STILL fires when some frontier is fresh (fresh>0) despite gated items present', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 3, frontier: 7, frontierStuck: 5, paused: false })).toBe(true);
  });
  it('treats an absent frontierStuck as 0 (fresh=frontier — prior behaviour preserved)', () => {
    expect(queenPlacementStalled({ consecutiveZeroTokenWakes: 3, frontier: 7, paused: false })).toBe(true);
  });
});

describe('isLiveRigOnlyFrontierTitle / countStuckFrontier — live-rig/federation false-escalation guard (EI-15329)', () => {
  it('recognizes the actual live-incident titles as live-rig/federation-only', () => {
    expect(isLiveRigOnlyFrontierTitle('Federation peer loses gh auth across VM restart → stays local-only')).toBe(true);
    expect(isLiveRigOnlyFrontierTitle('Federation: late-admitted owner core stalls — replication/fold catches up only on next append')).toBe(true);
    expect(isLiveRigOnlyFrontierTitle('Epoch-key wraps rejected during identity divergence are permanently stranded — silent REV fed_event outage class')).toBe(true);
  });
  it('does NOT flag an ordinary, non-federation title', () => {
    expect(isLiveRigOnlyFrontierTitle('Fix off-by-one in pagination for the plan-items list')).toBe(false);
    expect(isLiveRigOnlyFrontierTitle(undefined)).toBe(false);
  });
  it('countStuckFrontier counts a FRESH (ageDays=0) live-rig-titled row as stuck', () => {
    expect(countStuckFrontier([{ ageDays: 0, title: 'Federation peer loses gh auth across VM restart' }])).toBe(1);
  });
  it('countStuckFrontier still counts age-based stuck rows with no title (prior behaviour preserved)', () => {
    expect(countStuckFrontier([{ ageDays: 1 }, { ageDays: 0 }])).toBe(1);
  });
  // EI-15329 GUARD: the exact false-escalation shape — a "fresh" (recently-touched)
  // ready frontier that is ENTIRELY live-rig/federation-owned SU-lane work must read
  // as correct idle (fresh=0), never a Mug placement stall / owner escalation, no
  // matter how many consecutive 0-token wakes accompany it.
  it('GUARD: an all-live-rig, age-fresh frontier does NOT read as a placement stall', () => {
    const frontier = [
      { ageDays: 0, title: 'Federation peer loses gh auth across VM restart → stays local-only' },
      { ageDays: 0.01, title: 'Federation: late-admitted owner core stalls on quiescent hives' },
      { ageDays: 0, title: 'Epoch-key wraps rejected during identity divergence — silent REV fed_event outage' },
    ];
    const frontierStuck = countStuckFrontier(frontier);
    expect(frontierStuck).toBe(frontier.length); // every row excluded — none is genuinely fresh
    expect(
      queenPlacementStalled({ consecutiveZeroTokenWakes: 9, frontier: frontier.length, frontierStuck, paused: false }),
    ).toBe(false);
  });
});

describe('computeStalePausedRoutines — stale/unexplained routine pause detector (WI-5839 / EI-18654017982759582 items 2+3)', () => {
  const now = 10_000_000;

  it('flags a paused routine with NO recorded reason, regardless of age (unattributed pause is the bug class)', () => {
    const r = computeStalePausedRoutines([{ name: 'git-sync', updatedAtMs: now - 1000 }], now);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'git-sync', reasonMissing: true, critical: false });
  });

  it('does NOT flag a reasoned pause that is still fresh (within the general threshold)', () => {
    const r = computeStalePausedRoutines(
      [{ name: 'git-sync', pausedAtMs: now - 1000, pauseReason: 'manual deploy-checkout surgery' }],
      now,
    );
    expect(r).toEqual([]);
  });

  it('flags a reasoned pause once it crosses the GENERAL threshold', () => {
    const generalMs = 24 * 60 * 60_000;
    const r = computeStalePausedRoutines(
      [{ name: 'scout-cycle', pausedAtMs: now - generalMs - 1, pauseReason: 'pausing scout during an incident' }],
      now,
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'scout-cycle', reasonMissing: false, critical: false });
  });

  it('flags a reasoned pause on a RELEASE-CRITICAL routine much sooner (the CRITICAL threshold)', () => {
    const criticalMs = 4 * 60 * 60_000;
    const generalMs = 24 * 60 * 60_000;
    const rows = [{ name: 'release-trigger', pausedAtMs: now - criticalMs - 1, pauseReason: 'incident mitigation' }];
    // Past the critical threshold but nowhere near the general one — still flagged, and marked critical.
    expect(criticalMs).toBeLessThan(generalMs);
    const r = computeStalePausedRoutines(rows, now);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'release-trigger', reasonMissing: false, critical: true });
  });

  it('does NOT flag a fresh reasoned pause on a release-critical routine (within its shorter threshold)', () => {
    const r = computeStalePausedRoutines(
      [{ name: 'green-checkpoint', pausedAtMs: now - 1000, pauseReason: 'holding for a manual migration' }],
      now,
    );
    expect(r).toEqual([]);
  });

  it('falls back to updatedAtMs as the age anchor when pausedAtMs is absent (a legacy pre-fix pause)', () => {
    const generalMs = 24 * 60 * 60_000;
    const r = computeStalePausedRoutines([{ name: 'old-routine', updatedAtMs: now - generalMs - 1 }], now);
    expect(r).toHaveLength(1);
    expect(r[0].ageMs).toBeGreaterThanOrEqual(generalMs);
  });

  it('reports Infinity age (still flagged) when neither pausedAtMs nor updatedAtMs is readable', () => {
    const r = computeStalePausedRoutines([{ name: 'mystery-routine' }], now);
    expect(r).toEqual([{ name: 'mystery-routine', ageMs: Infinity, reasonMissing: true, critical: false }]);
  });

  it('sorts critical routines first, then oldest-first within each group', () => {
    const r = computeStalePausedRoutines(
      [
        { name: 'scout-cycle', updatedAtMs: now - 5000 },
        { name: 'release-trigger', updatedAtMs: now - 1000 },
        { name: 'git-sync', updatedAtMs: now - 9000 },
      ],
      now,
    );
    expect(r.map((x) => x.name)).toEqual(['release-trigger', 'git-sync', 'scout-cycle']);
  });

  it('a healthy, unpaused fleet (no rows) → empty', () => {
    expect(computeStalePausedRoutines([], now)).toEqual([]);
  });

  describe('EI-18718973731535914 — a routine dead for WEEKS is decommissioned, not "paused"', () => {
    const decommissionedMs = 7 * 24 * 60 * 60_000;

    it('excludes a routine last touched well past the decommissioned cutoff, even with NO recorded reason', () => {
      // Without the fix, `reasonMissing` alone would ALWAYS flag this (per the rule
      // above) — the exact false-alarm repro: a decommissioned routine (e.g. hive-wake)
      // inactive for 15-48 days, reported forever as an "unattributed pause".
      const r = computeStalePausedRoutines([{ name: 'hive-wake', updatedAtMs: now - decommissionedMs - 1 }], now);
      expect(r).toEqual([]);
    });

    it('still flags a reasonMissing pause that is recent (within the decommissioned cutoff)', () => {
      const r = computeStalePausedRoutines([{ name: 'git-sync', updatedAtMs: now - decommissionedMs + 1 }], now);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: 'git-sync', reasonMissing: true });
    });

    it('a custom decommissionedMs is honored', () => {
      const oneDayMs = 24 * 60 * 60_000;
      const r = computeStalePausedRoutines(
        [{ name: 'old-routine', updatedAtMs: now - oneDayMs - 1 }],
        now,
        { decommissionedMs: oneDayMs },
      );
      expect(r).toEqual([]);
    });

    it('does NOT exempt a CRITICAL, install-matching pause from reporting, however old — the decommissioned cutoff must never weaken the WI-5839 true-positive path (release-trigger silently paused for days)', () => {
      const tenDaysMs = 10 * 24 * 60 * 60_000; // well past the 7d decommissioned cutoff
      const r = computeStalePausedRoutines(
        [{ name: 'release-trigger', updatedAtMs: now - tenDaysMs, installSlug: 'papercusp' }],
        now,
        { currentInstallSlug: 'papercusp' },
      );
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: 'release-trigger', critical: true });
    });

    it('DOES exclude a same-named critical routine on a DIFFERENT install once past the cutoff — only the CURRENT install critical pause is exempt from decommissioning', () => {
      const tenDaysMs = 10 * 24 * 60 * 60_000;
      const r = computeStalePausedRoutines(
        [{ name: 'release-trigger', updatedAtMs: now - tenDaysMs, installSlug: 'some-other-hive' }],
        now,
        { currentInstallSlug: 'papercusp' },
      );
      expect(r).toEqual([]);
    });
  });

  describe('EI-18694769501553335 — critical severity is scoped to the CURRENT install, not any row sharing the name', () => {
    it('does NOT escalate to critical a same-named release routine paused on a DIFFERENT install (the false-positive repro)', () => {
      const criticalMs = 4 * 60 * 60_000;
      const rows: StalePausedRoutineInput[] = [
        {
          name: 'green-checkpoint',
          pausedAtMs: now - criticalMs - 1,
          pauseReason: 'disposable verify harness, paused on purpose',
          installSlug: 'ei665-verify-x1',
        },
      ];
      const r = computeStalePausedRoutines(rows, now, { currentInstallSlug: 'papercusp' });
      expect(r).toHaveLength(1);
      // Still reported (a real, if unimportant, stale pause) but NOT upgraded to critical —
      // it belongs to a different install and cannot block THIS install's deploy pipeline.
      expect(r[0]).toMatchObject({ name: 'green-checkpoint', critical: false });
    });

    it('DOES escalate to critical when the paused release routine belongs to the CURRENT install', () => {
      const criticalMs = 4 * 60 * 60_000;
      const rows: StalePausedRoutineInput[] = [
        {
          name: 'green-checkpoint',
          pausedAtMs: now - criticalMs - 1,
          pauseReason: 'incident mitigation',
          installSlug: 'papercusp',
        },
      ];
      const r = computeStalePausedRoutines(rows, now, { currentInstallSlug: 'papercusp' });
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: 'green-checkpoint', critical: true });
    });

    it('falls back to name-only matching (pre-fix behavior) when installSlug/currentInstallSlug is unknown — no false negative for callers not yet passing it', () => {
      const criticalMs = 4 * 60 * 60_000;
      // No installSlug on the row, no currentInstallSlug in opts.
      const r1 = computeStalePausedRoutines(
        [{ name: 'release-trigger', pausedAtMs: now - criticalMs - 1, pauseReason: 'incident' }],
        now,
      );
      expect(r1[0]).toMatchObject({ critical: true });

      // installSlug known on the row but currentInstallSlug NOT passed by the caller.
      const r2 = computeStalePausedRoutines(
        [{ name: 'release-trigger', pausedAtMs: now - criticalMs - 1, pauseReason: 'incident', installSlug: 'some-hive' }],
        now,
      );
      expect(r2[0]).toMatchObject({ critical: true });
    });

    it('a NON-critical-named routine paused on a different install is unaffected (still just advisory-eligible by name)', () => {
      const generalMs = 24 * 60 * 60_000;
      const rows: StalePausedRoutineInput[] = [
        { name: 'scout-cycle', updatedAtMs: now - generalMs - 1, installSlug: 'ei665-verify-x1' },
      ];
      const r = computeStalePausedRoutines(rows, now, { currentInstallSlug: 'papercusp' });
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: 'scout-cycle', critical: false });
    });
  });
});

describe('deadRoutineOverdueMsForCiWindow — dead-routine alarm vs green-checkpoint residual contention (WI-4310)', () => {
  it('widens when a checkpoint run is currently active', () => {
    const ms = deadRoutineOverdueMsForCiWindow({ checkpointActive: true, recentCheckpointEventAgeMs: null });
    expect(ms).toBe(20 * 60_000);
  });

  it('widens within the trailing grace after the most recent checkpoint event, even though the run is no longer active', () => {
    const ms = deadRoutineOverdueMsForCiWindow({ checkpointActive: false, recentCheckpointEventAgeMs: 2 * 60_000 });
    expect(ms).toBe(20 * 60_000);
  });

  it('stays at the tight base threshold once the grace window has elapsed', () => {
    const ms = deadRoutineOverdueMsForCiWindow({ checkpointActive: false, recentCheckpointEventAgeMs: 5 * 60_000 + 1 });
    expect(ms).toBe(10 * 60_000);
  });

  it('stays at the tight base threshold with no checkpoint signal at all (the common case)', () => {
    const ms = deadRoutineOverdueMsForCiWindow({ checkpointActive: false, recentCheckpointEventAgeMs: null });
    expect(ms).toBe(10 * 60_000);
  });

  it('respects injected opts over the module defaults', () => {
    const ms = deadRoutineOverdueMsForCiWindow(
      { checkpointActive: true, recentCheckpointEventAgeMs: null },
      { baseMs: 1000, widenedMs: 5000, graceMs: 500 },
    );
    expect(ms).toBe(5000);
  });

  it('the grace boundary is inclusive (age exactly equal to graceMs still widens)', () => {
    const ms = deadRoutineOverdueMsForCiWindow(
      { checkpointActive: false, recentCheckpointEventAgeMs: 500 },
      { graceMs: 500 },
    );
    expect(ms).toBe(20 * 60_000);
  });
});

describe('tallyPlans — queen-plan-selection signal (hive-loop-supervision 2026-06-21)', () => {
  const now = 2_000_000_000;
  it('startedDraft = plans force-started while still draft (the anti-pattern)', () => {
    const v = tallyPlans([
      { status: 'draft', opStatus: 'started' },  // force-started draft — flagged
      { status: 'active', opStatus: 'started' }, // started a ready/active plan — fine
      { status: 'draft', opStatus: null },       // a draft NOT started — fine
    ], now);
    expect(v.startedDraft).toBe(1);
    expect(v.started).toBe(2);
    expect(v.draft).toBe(2);
    expect(v.active).toBe(1);
  });
  it('counts stalled started plans past the aging window', () => {
    const v = tallyPlans([{ status: 'active', opStatus: 'started', opUpdatedAt: new Date(now - 48 * 60 * 60_000).toISOString() }], now);
    expect(v.stalledPlans).toBe(1);
  });
  it('skips archived rows', () => {
    const v = tallyPlans([{ status: 'draft', opStatus: 'started', archived: true }], now);
    expect(v.startedDraft).toBe(0);
    expect(v.started).toBe(0);
  });
  it('tallies item done/total (dropped excluded)', () => {
    const v = tallyPlans([{ status: 'active', items: [{ status: 'done' }, { status: 'todo' }, { status: 'dropped' }] }], now);
    expect(v.itemsDone).toBe(1);
    expect(v.itemsTotal).toBe(2);
  });
});

describe('panelSafe — per-panel fail-soft', () => {
  it('passes a healthy collector through, injecting key + label', async () => {
    const panel = await panelSafe('queen', async () => ({
      status: 'ok' as const,
      summary: 'looping',
      metrics: [{ label: 'last wake', value: '2m ago' }],
      data: { hi: true },
    }));
    // 'queen' stays the stable PanelKey (PANEL_ORDER/UI consumers key on it);
    // the pot-rename shows through the LABEL ('Mug'), not the key.
    expect(panel.key).toBe('queen');
    expect(panel.label).toBe(PANEL_LABELS.queen);
    expect(panel.status).toBe('ok');
    expect(panel.error).toBeUndefined();
    expect(panel.data).toEqual({ hi: true });
  });

  it('greys a throwing collector to unknown + captures the error (never throws)', async () => {
    const panel = await panelSafe('tokens', async () => {
      throw new Error('PG exploded');
    });
    expect(panel.key).toBe('tokens');
    expect(panel.label).toBe(PANEL_LABELS.tokens);
    expect(panel.status).toBe('unknown');
    expect(panel.data).toBeNull();
    expect(panel.error).toContain('PG exploded');
    expect(panel.metrics).toEqual([]);
  });

  it('a non-Error throw still degrades cleanly to unknown', async () => {
    const panel = await panelSafe('deploy', async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string failure';
    });
    expect(panel.status).toBe('unknown');
    expect(panel.error).toBe('string failure');
  });
});

describe('computeEscalationsHealth — operational flood excluded (EI-1490)', () => {
  const NOW = Date.parse('2026-06-18T12:00:00Z');
  const OLD = '2026-06-15T00:00:00Z'; // ~3.5d old → past the 6h aging threshold
  const FRESH = '2026-06-18T11:30:00Z'; // 30m old → under the threshold

  // The live bug: ~13k system:hive-placement-watchdog escalations (system sender,
  // no options) inflate `aging` to an impossible "13,246 aging past threshold".
  function flood(n: number): EscalationAgingInput[] {
    return Array.from({ length: n }, () => ({
      from: 'system:hive-placement-watchdog',
      severity: 'advisory',
      ts: OLD,
    }));
  }

  it('excludes operational escalations from open/aging/bySeverity', () => {
    const h = computeEscalationsHealth(flood(13_246), NOW);
    expect(h.open).toBe(0);
    expect(h.aging).toBe(0);
    expect(h.oldestAgeMs).toBeNull();
    expect(h.bySeverity).toEqual({});
  });

  it('counts only genuine human-decision escalations (agent sender / options)', () => {
    const open: EscalationAgingInput[] = [
      ...flood(500),
      { from: 's-agent-1', severity: 'blocker', ts: OLD }, // aged human decision
      { from: 's-agent-2', severity: 'question', ts: FRESH }, // fresh human decision
      // a system sender WITH options is a real choice → human-attention
      { from: 'system:queen', options: [{ id: 'a', label: 'A' }], severity: 'advisory', ts: OLD },
    ];
    const h = computeEscalationsHealth(open, NOW);
    expect(h.open).toBe(3);
    expect(h.aging).toBe(2); // the two OLD ones; the FRESH one is under threshold
    expect(h.agingNew).toBe(0); // both crossed the threshold DAYS ago — standing, not new
    expect(h.bySeverity).toEqual({ blocker: 1, question: 1, advisory: 1 });
  });

  it('agingNew counts only escalations that crossed the threshold in the last 24h (health-tab-v2 P-003)', () => {
    const open: EscalationAgingInput[] = [
      // aged 7h → crossed the 6h threshold ~1h ago → NEW aging
      { from: 's-agent-1', severity: 'question', ts: new Date(NOW - 7 * 60 * 60_000).toISOString() },
      // aged ~3.5d → crossed days ago → standing aging only
      { from: 's-agent-2', severity: 'warning', ts: OLD },
      { from: 's-agent-3', severity: 'info', ts: FRESH }, // not aged at all
    ];
    const h = computeEscalationsHealth(open, NOW);
    expect(h.aging).toBe(2);
    expect(h.agingNew).toBe(1);
  });

  it('no escalations → clean zeroed panel', () => {
    const h = computeEscalationsHealth([], NOW);
    expect(h).toEqual({ open: 0, oldestAgeMs: null, bySeverity: {}, aging: 0, agingNew: 0 });
  });
});

describe('probeGatewayHealthz retry (EI-1693 sibling — one transient timeout is not "down")', () => {
  const timeoutErr = () => Object.assign(new Error('timed out'), { name: 'TimeoutError' });

  it('a transient timeout THEN a success → reachable (true)', async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (n++ === 0) throw timeoutErr();
        return { status: 200 } as Response;
      }));
      const p = probeGatewayHealthz([5, 50]);
      await vi.runAllTimersAsync(); // advance the inter-attempt backoff
      expect(await p).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('all escalating attempts fail → unreachable (false)', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => { throw timeoutErr(); }));
      const p = probeGatewayHealthz([5, 5]);
      await vi.runAllTimersAsync();
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('toolEfficiencyStatus — WI-839 tool-efficiency panel status fold', () => {
  it('any leg broken → crit, regardless of the others', () => {
    expect(toolEfficiencyStatus(['broken', 'healthy', 'unknown'])).toBe('crit');
    expect(toolEfficiencyStatus(['healthy', 'healthy', 'broken'])).toBe('crit');
  });
  it('no broken but any degraded → warn', () => {
    expect(toolEfficiencyStatus(['degraded', 'healthy', 'unknown'])).toBe('warn');
  });
  it('every leg unknown (all windows too small to grade) → unknown, not ok', () => {
    expect(toolEfficiencyStatus(['unknown', 'unknown', 'unknown'])).toBe('unknown');
  });
  it('all healthy (some possibly unknown) → ok', () => {
    expect(toolEfficiencyStatus(['healthy', 'healthy', 'healthy'])).toBe('ok');
    expect(toolEfficiencyStatus(['healthy', 'unknown', 'healthy'])).toBe('ok');
  });
  it('broken beats degraded beats unknown-only (precedence order)', () => {
    expect(toolEfficiencyStatus(['broken', 'degraded'])).toBe('crit');
    expect(toolEfficiencyStatus(['degraded', 'unknown'])).toBe('warn');
  });
});

describe('computeAccountsAvailable — starvation-watchdog false-positive fix (EI-15875)', () => {
  const NOW = 1_784_000_000_000;

  function account(id: string, overrides: Partial<ClaudeAccount['rate']> = {}): ClaudeAccount {
    return {
      id,
      credentialRef: `token:${id}`,
      addedAt: NOW - 1000,
      boundTo: [],
      rate: { pausedUntil: 0, lastPenaltyAt: 0, penaltyCount: 0, windowStartedAt: 0, ...overrides },
    };
  }

  it('a plain healthy account (no pause, no usage-wall, no edge-throttle) is available', () => {
    const r = computeAccountsAvailable([account('a1')], null, NOW);
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 1, accountsPaused: 0 });
  });

  it('a rate-paused account is excluded (unchanged pre-existing behavior)', () => {
    const r = computeAccountsAvailable(
      [account('a1', { pausedUntil: NOW + 60_000 })],
      null,
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 0, accountsPaused: 1 });
  });

  it('EI-15875 core bug: a weekly-usage-walled account with NO active pause is excluded, not counted as idle-healthy', () => {
    // pausedUntil: 0 (never set / already lapsed), but util7d is at cap and the window has not
    // reset yet — exactly the 2026-07-18 false-positive shape (5 accounts read this way as spare
    // capacity by the OLD pause-only check).
    const r = computeAccountsAvailable(
      [account('a1', {
        pausedUntil: 0,
        utilization7d: 0.98,
        utilizationAt: NOW - 1000,
        windowResetAt7d: NOW + 3 * 24 * 60 * 60_000,
      })],
      null,
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 0, accountsPaused: 1 });
  });

  it('a usage-walled account becomes available again once its window has reset', () => {
    const r = computeAccountsAvailable(
      [account('a1', {
        pausedUntil: 0,
        utilization7d: 0.98,
        utilizationAt: NOW - 1000,
        windowResetAt7d: NOW - 1000, // already past — window reset
      })],
      null,
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 1, accountsPaused: 0 });
  });

  it('a live edge-throttled account (no pause, no usage-wall) is excluded too', () => {
    const r = computeAccountsAvailable(
      [account('a1')],
      { edgeThrottleByAccount: { a1: { edgeThrottled: true } } },
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 1, accountsAvailable: 0, accountsPaused: 1 });
  });

  it('mixed pool: only the genuinely-servable accounts count as available (mirrors the 2026-07-18 incident: 2/8 usable)', () => {
    const accounts = [
      account('usable-1'),
      account('usable-2'),
      account('paused', { pausedUntil: NOW + 60_000 }),
      account('walled-1', { utilization7d: 0.97, utilizationAt: NOW - 1000, windowResetAt7d: NOW + 100_000 }),
      account('walled-2', { utilization7d: 0.99, utilizationAt: NOW - 1000, windowResetAt7d: NOW + 100_000 }),
      account('edge-throttled'),
    ];
    const r = computeAccountsAvailable(
      accounts,
      { edgeThrottleByAccount: { 'edge-throttled': { edgeThrottled: true } } },
      NOW,
    );
    expect(r).toEqual({ accountsTotal: 6, accountsAvailable: 2, accountsPaused: 4 });
  });

  it('a null gateway snapshot (gateway unreachable) never throws — edge-throttle just reads as unknown/false', () => {
    expect(() => computeAccountsAvailable([account('a1')], null, NOW)).not.toThrow();
  });
});

describe('mergeHealthPanels — push-on-write merge for the health-tab cache (stop-discarded-dedup-and-audit-server-polling-2026-07-26 P-013)', () => {
  function fixturePanel(key: PanelKey, status: PanelStatus): HealthPanel<unknown> {
    return { key, label: PANEL_LABELS[key], status, summary: `${key}:${status}`, metrics: [], data: null };
  }

  /** A full 20-panel snapshot, every panel 'ok' unless overridden. */
  function fixtureSnapshot(overrides: Partial<Record<PanelKey, PanelStatus>> = {}): SystemHealth {
    const panels = {} as SystemHealthPanels;
    for (const key of PANEL_ORDER) {
      (panels as Record<PanelKey, HealthPanel<unknown>>)[key] = fixturePanel(key, overrides[key] ?? 'ok');
    }
    return {
      workspaceId: 'ws-test',
      evaluatedAt: 0,
      overall: 'ok',
      crossMonitor: { queenAlive: false, overwatchAlive: null },
      panels,
    };
  }

  it('replaces only the named panel(s), leaving every other panel byte-identical', () => {
    const snap = fixtureSnapshot();
    const freshObservations = fixturePanel('observations', 'warn');
    mergeHealthPanels(snap, { observations: freshObservations }, 123);
    expect(snap.panels.observations).toBe(freshObservations);
    expect(snap.panels.autonomy.status).toBe('ok');
    expect(snap.panels.improvements.status).toBe('ok');
  });

  it('re-derives `overall` as the worst status across ALL panels, not just the merged one', () => {
    // infra is pre-existing crit; merging a mere 'warn' into observations must
    // not downgrade overall away from that crit (the P-013 bug this guards:
    // partial-panel merges must never blind the aggregator to an untouched
    // panel's worse status).
    const snap = fixtureSnapshot({ infra: 'crit' });
    mergeHealthPanels(snap, { observations: fixturePanel('observations', 'warn') }, 999);
    expect(snap.overall).toBe('crit');
  });

  it('a merged panel recovering to ok brings `overall` back down when nothing else is worse', () => {
    const snap = fixtureSnapshot({ improvements: 'crit' });
    mergeHealthPanels(snap, { improvements: fixturePanel('improvements', 'ok') }, 111);
    expect(snap.overall).toBe('ok');
  });

  it('a merged panel escalating to crit raises `overall` even though it started ok', () => {
    const snap = fixtureSnapshot();
    mergeHealthPanels(snap, { autonomy: fixturePanel('autonomy', 'crit') }, 222);
    expect(snap.overall).toBe('crit');
  });

  it('stamps `evaluatedAt` to the merge time so the tab treats the snapshot as fresh', () => {
    const snap = fixtureSnapshot();
    mergeHealthPanels(snap, { autonomy: fixturePanel('autonomy', 'ok') }, 42424);
    expect(snap.evaluatedAt).toBe(42424);
  });

  it('mutates the snapshot in place AND returns it (same reference)', () => {
    const snap = fixtureSnapshot();
    const returned = mergeHealthPanels(snap, { autonomy: fixturePanel('autonomy', 'warn') }, 1);
    expect(returned).toBe(snap);
  });
});
