/**
 * placement-watchdog.test.ts — the COMPLETION GUARANTEE behavioral contract,
 * pure (no PG). Pins B-09: P-020 (track each placement to terminal + recover a
 * dead/stalled cup), P-021 (cursed-item breaker mirrors replanStrikes), and
 * P-023 (reconcile "steer, don't dispatch" WITH the completion mandate).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  deriveCupLiveness,
  evaluatePlacement,
  evaluateStalePlacementEscalation,
  evaluateTerminalPlacementReconcile,
  buildOpenPlacementSummary,
  DEFAULT_STALE_RECOVERING_MS,
  isReaperReclaim,
  isUnitTerminal,
  isStuckBlockerState,
  isUnitParked,
  placementConfig,
  reconcilePotPlacements,
  resolveMugOwners,
  type PlacementObservation,
  type PlacementConfig,
  type ReconcileSweepDeps,
} from './placement-watchdog';
import { RECLAIM_STALE_MS, WEDGE_SILENT_MS } from '../fleet/spawn-reclaim';

const CFG: PlacementConfig = { breakerThreshold: 3, recoveryDebounceMs: 5 * 60_000, dormancyGraceMs: 10 * 60_000, infraBreakerThreshold: 12 };
const NOW = 1_000_000_000_000;

function obs(over: Partial<PlacementObservation>): PlacementObservation {
  return {
    workItemId: 'F-001',
    unitExists: true,
    unitTerminal: false,
    hasLiveHolder: false,
    failCount: 0,
    infraLossCount: 0,
    placementStatus: null,
    lastRecoveryAtMs: null,
    now: NOW,
    ...over,
  };
}

describe('isUnitTerminal / isStuckBlockerState', () => {
  it('treats both kind-family terminal dialects as terminal', () => {
    for (const s of ['passed', 'deprecated', 'resolved', 'closed']) expect(isUnitTerminal(s)).toBe(true);
    for (const s of ['todo', 'in_progress', 'wip', 'failing', 'blocked', null, undefined]) {
      expect(isUnitTerminal(s)).toBe(false);
    }
  });
  it('flags only the feature-family failure band as stuck', () => {
    expect(isStuckBlockerState('failing')).toBe(true);
    expect(isStuckBlockerState('failed')).toBe(true);
    for (const s of ['todo', 'passed', 'in_progress', null]) expect(isStuckBlockerState(s)).toBe(false);
  });
});

describe('buildOpenPlacementSummary', () => {
  it('counts all open placements separately from the bounded Mug attention sample', () => {
    const summary = buildOpenPlacementSummary(
      [
        { status: 'cursed', count: 20 },
        { status: 'recovering', count: 6 },
        { status: 'stranded', count: 2 },
        { status: 'working', count: 9 },
      ],
      Array.from({ length: 20 }, (_, i) => ({
        work_item_id: `WI-CURSED-${i}`,
        status: 'cursed',
        fail_count: 3,
        harness_slug: 'papercup',
      })),
    );

    expect(summary).toMatchObject({
      cursed: 20,
      recovering: 6,
      stranded: 2,
      workingTracked: 9,
    });
    expect(summary.items).toHaveLength(20);
  });

  it('EI-6005: sorts recovering items first so a bounded render sample never drops the one item needing action', () => {
    // 12 cursed rows arrive BEFORE the single recovering row (itemRows order is
    // whatever the SQL query happened to return) — a naive render that slices
    // the first N items would show all 12 cursed ids and silently drop the
    // recovering one if the cap were, say, 12.
    const itemRows = [
      ...Array.from({ length: 12 }, (_, i) => ({
        work_item_id: `WI-CURSED-${i}`,
        status: 'cursed',
        fail_count: 3,
        harness_slug: 'papercup',
      })),
      { work_item_id: 'WI-RECOVER-1', status: 'recovering', fail_count: 1, harness_slug: 'papercup' },
    ];
    const summary = buildOpenPlacementSummary(
      [
        { status: 'cursed', count: 12 },
        { status: 'recovering', count: 1 },
      ],
      itemRows,
    );

    expect(summary.items[0]).toMatchObject({ workItemId: 'WI-RECOVER-1', status: 'recovering' });
    // A cap of 12 (matching the cursed count) would previously have dropped the
    // recovering item entirely; now it's guaranteed to be in any prefix slice.
    const rendered = summary.items.slice(0, 12);
    expect(rendered.some((it) => it.status === 'recovering')).toBe(true);
  });

  // EI-8437 — a `recovering` placement that has sat untouched for days (observed
  // live on WI-329, 2026-07-03 through 2026-07-07) kept getting re-noted as
  // "stale, needs reconciliation" by successive triage passes without anyone
  // ever actually verifying whether the underlying work had already landed. The
  // brief now flags this directly instead of relying on a human/agent to
  // re-derive the staleness by hand each time.
  it('EI-8437: flags a `recovering` item whose placement row is older than the stale threshold', () => {
    const nowMs = NOW;
    const staleUpdatedAt = new Date(nowMs - (DEFAULT_STALE_RECOVERING_MS + 60 * 60_000)).toISOString();
    const summary = buildOpenPlacementSummary(
      [{ status: 'recovering', count: 1 }],
      [{ work_item_id: 'WI-329', status: 'recovering', fail_count: 0, harness_slug: 'papercusp', updated_at: staleUpdatedAt }],
      nowMs,
    );
    expect(summary.items[0]).toMatchObject({ workItemId: 'WI-329', stale: true });
    expect(summary.items[0].ageHours).toBeGreaterThanOrEqual(DEFAULT_STALE_RECOVERING_MS / 3_600_000);
  });

  it('EI-8437: does NOT flag a `recovering` item still inside the stale threshold', () => {
    const nowMs = NOW;
    const freshUpdatedAt = new Date(nowMs - 60 * 60_000).toISOString(); // 1h ago
    const summary = buildOpenPlacementSummary(
      [{ status: 'recovering', count: 1 }],
      [{ work_item_id: 'WI-FRESH', status: 'recovering', fail_count: 0, harness_slug: 'papercusp', updated_at: freshUpdatedAt }],
      nowMs,
    );
    expect(summary.items[0].stale).toBeUndefined();
    expect(summary.items[0].ageHours).toBeCloseTo(1, 1);
  });

  it('EI-8437: never flags `stale` for cursed/stranded/working — only `recovering` gets the VERIFY nudge', () => {
    const nowMs = NOW;
    const staleUpdatedAt = new Date(nowMs - (DEFAULT_STALE_RECOVERING_MS + 60 * 60_000)).toISOString();
    const summary = buildOpenPlacementSummary(
      [{ status: 'cursed', count: 1 }],
      [{ work_item_id: 'WI-CURSED-OLD', status: 'cursed', fail_count: 3, harness_slug: 'papercusp', updated_at: staleUpdatedAt }],
      nowMs,
    );
    expect(summary.items[0].stale).toBeUndefined();
  });

  it('EI-8437: joins the plan-item link (`<slug>#<itemId>`) so a triaging agent need not re-derive it', () => {
    const summary = buildOpenPlacementSummary(
      [{ status: 'recovering', count: 1 }],
      [
        {
          work_item_id: 'WI-329',
          status: 'recovering',
          fail_count: 0,
          harness_slug: 'papercusp',
          source_plan_slug: 'papercup-physical-rename-phase5-2026-06-20',
          source_plan_item_ids: ['P-009'],
        },
      ],
      NOW,
    );
    expect(summary.items[0].planItem).toBe('papercup-physical-rename-phase5-2026-06-20#P-009');
  });

  it('EI-8437: omits ageHours/stale/planItem entirely when the caller does not supply them (back-compat)', () => {
    const summary = buildOpenPlacementSummary(
      [{ status: 'recovering', count: 1 }],
      [{ work_item_id: 'WI-OLD-CALLER', status: 'recovering', fail_count: 0, harness_slug: 'papercusp' }],
      NOW,
    );
    expect(summary.items[0].ageHours).toBeUndefined();
    expect(summary.items[0].stale).toBeUndefined();
    expect(summary.items[0].planItem).toBeUndefined();
  });
});

describe('deriveCupLiveness (P-020 — reuses the fleet-reclaim thresholds)', () => {
  it('terminal spawn status → dead', () => {
    for (const status of ['done', 'failed', 'cancelled', 'reaped']) {
      expect(deriveCupLiveness({ status, heartbeatAtMs: NOW, lastOutputAtMs: NOW, now: NOW })).toBe('dead');
    }
  });
  it('running + fresh heartbeat → live', () => {
    expect(deriveCupLiveness({ status: 'running', heartbeatAtMs: NOW - 1000, lastOutputAtMs: NOW - 1000, now: NOW })).toBe('live');
  });
  it('running + heartbeat stale beyond RECLAIM_STALE_MS → dead (orphaned)', () => {
    expect(
      deriveCupLiveness({ status: 'running', heartbeatAtMs: NOW - RECLAIM_STALE_MS - 1, lastOutputAtMs: NOW, now: NOW }),
    ).toBe('dead');
  });
  it('running + fresh heartbeat but output silent beyond WEDGE_SILENT_MS → wedged', () => {
    expect(
      deriveCupLiveness({ status: 'running', heartbeatAtMs: NOW - 1000, lastOutputAtMs: NOW - WEDGE_SILENT_MS - 1, now: NOW }),
    ).toBe('wedged');
  });
  it('running + null heartbeat (freshly spawned) → live (reclaim owns true orphans)', () => {
    expect(deriveCupLiveness({ status: 'running', heartbeatAtMs: null, lastOutputAtMs: null, now: NOW })).toBe('live');
  });
});

describe('evaluatePlacement — P-020 completion tracking', () => {
  it('unit gone → abandon', () => {
    expect(evaluatePlacement(obs({ unitExists: false }), CFG).kind).toBe('abandon');
  });
  it('unit terminal → completed (the placement succeeded)', () => {
    expect(evaluatePlacement(obs({ unitTerminal: true }), CFG).kind).toBe('completed');
  });
  it('live holder + non-terminal → healthy', () => {
    expect(evaluatePlacement(obs({ hasLiveHolder: true }), CFG).kind).toBe('healthy');
  });
  it('dead holder + non-terminal, first failure → recover (attempt 1)', () => {
    const d = evaluatePlacement(obs({ hasLiveHolder: false }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextFailCount).toBe(1);
  });
  it('terminal beats a dead holder — a cup that completed then died still counts done', () => {
    // The unit reached terminal; the serving cup being dead is irrelevant.
    expect(evaluatePlacement(obs({ hasLiveHolder: false, unitTerminal: true }), CFG).kind).toBe('completed');
  });
});

describe('isUnitParked', () => {
  it('flags only the deliberate-park band (mirrors FEATURE_NON_REQUEUE_STATES\' blocked + needs-human)', () => {
    expect(isUnitParked('blocked')).toBe(true);
    // EI-6563: needs-human was added to the sibling FEATURE_NON_REQUEUE_STATES reaper
    // set (fleet-scheduler-hardening-2026-07-03 P-004) but not mirrored here — a unit
    // an owner parked needs-human kept getting Mug recovery-wake churn (observed on
    // WI-369), the same class WI-1439's `blocked` fix targets.
    expect(isUnitParked('needs-human')).toBe(true);
    for (const s of ['todo', 'passed', 'in_progress', 'failing', null, undefined]) {
      expect(isUnitParked(s)).toBe(false);
    }
  });
});

describe('evaluatePlacement — WI-1439 a deliberately PARKED unit is never recovered', () => {
  it('parked + no live holder → parked (NOT recover — no wake, no counter bump)', () => {
    const d = evaluatePlacement(obs({ unitParked: true, hasLiveHolder: false }), CFG);
    expect(d.kind).toBe('parked');
  });
  it('live holder still wins over parked (a cup CAN be actively working a blocked item)', () => {
    const d = evaluatePlacement(obs({ unitParked: true, hasLiveHolder: true }), CFG);
    expect(d.kind).toBe('healthy');
  });
  it('terminal still wins over parked (reached done despite a stale blocked stamp)', () => {
    const d = evaluatePlacement(obs({ unitParked: true, unitTerminal: true }), CFG);
    expect(d.kind).toBe('completed');
  });
  it('parked short-circuits BEFORE the cursed latch — no breaker/escalation even with a prior curse', () => {
    const d = evaluatePlacement(
      obs({ unitParked: true, hasLiveHolder: false, placementStatus: 'cursed', failCount: 5 }),
      CFG,
    );
    expect(d.kind).toBe('parked');
  });
  it('parked short-circuits BEFORE the recovery debounce — never re-fires a wake on a timer', () => {
    const d = evaluatePlacement(
      obs({ unitParked: true, hasLiveHolder: false, placementStatus: 'recovering', failCount: 1, lastRecoveryAtMs: NOW - (CFG.recoveryDebounceMs + 1) }),
      CFG,
    );
    expect(d.kind).toBe('parked');
  });
});

describe('evaluatePlacement — P-020 recovery debounce', () => {
  it('mid-recovery within the debounce window → debounced (no re-wake spam)', () => {
    const d = evaluatePlacement(
      obs({ placementStatus: 'recovering', failCount: 1, lastRecoveryAtMs: NOW - 60_000 }),
      CFG,
    );
    expect(d.kind).toBe('debounced');
  });
  it('mid-recovery past the debounce window → recover again (attempt 2)', () => {
    const d = evaluatePlacement(
      obs({ placementStatus: 'recovering', failCount: 1, lastRecoveryAtMs: NOW - (CFG.recoveryDebounceMs + 1) }),
      CFG,
    );
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextFailCount).toBe(2);
  });
  it('a NEW failure after the unit recovered (status working) is not debounced', () => {
    // failCount persists across re-placements but status is back to working.
    const d = evaluatePlacement(obs({ placementStatus: 'working', failCount: 1, lastRecoveryAtMs: NOW - 1000 }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextFailCount).toBe(2);
  });
});

describe('evaluatePlacement — P-021 cursed-item circuit breaker (mirrors replanStrikes)', () => {
  it('trips the breaker when the failure count reaches the threshold', () => {
    // failCount 2 → this failure makes 3 == threshold → breaker (not a 4th re-place).
    const d = evaluatePlacement(
      obs({ placementStatus: 'recovering', failCount: 2, lastRecoveryAtMs: NOW - (CFG.recoveryDebounceMs + 1) }),
      CFG,
    );
    expect(d.kind).toBe('breaker');
    if (d.kind === 'breaker') expect(d.nextFailCount).toBe(3);
  });
  it('two recovery wakes precede the breaker (threshold 3)', () => {
    // Attempt sequence: fail#1 → recover, fail#2 → recover, fail#3 → breaker.
    const fail1 = evaluatePlacement(obs({ failCount: 0 }), CFG);
    const fail2 = evaluatePlacement(obs({ placementStatus: 'working', failCount: 1 }), CFG);
    const fail3 = evaluatePlacement(obs({ placementStatus: 'working', failCount: 2 }), CFG);
    expect([fail1.kind, fail2.kind, fail3.kind]).toEqual(['recover', 'recover', 'breaker']);
  });
  it('honors a custom (lower) breaker threshold', () => {
    const cfg: PlacementConfig = { breakerThreshold: 1, recoveryDebounceMs: 0, dormancyGraceMs: 10 * 60_000, infraBreakerThreshold: 12 };
    // First failure already reaches threshold 1 → breaker, never re-placed.
    expect(evaluatePlacement(obs({ failCount: 0 }), cfg).kind).toBe('breaker');
  });
  it('placementConfig defaults mirror replanStrikes (3), a 5-min debounce, a 10-min dormancy grace, and a 12 infra breaker', () => {
    const cfg = placementConfig();
    expect(cfg.breakerThreshold).toBe(3);
    expect(cfg.recoveryDebounceMs).toBe(5 * 60_000);
    expect(cfg.dormancyGraceMs).toBe(10 * 60_000); // F-FIX-041
    expect(cfg.infraBreakerThreshold).toBe(12); // F-FIX-041 — bounded infra breaker
  });
});

describe('evaluatePlacement — EI-865 the breaker LATCHES (it does NOT re-fire)', () => {
  it('an already-cursed unit short-circuits to `latched` — no re-fire, no failCount bump', () => {
    // The bug: a cursed unit fell through to the failed-placement path every sweep
    // (the debounce only guards `recovering`), re-entering `breaker` → re-escalating
    // + climbing failCount unbounded (356→460). The latch HALTS it.
    const d = evaluatePlacement(obs({ placementStatus: 'cursed', failCount: 3 }), CFG);
    expect(d.kind).toBe('latched');
  });

  it('the latch holds across MANY sweeps — failCount never climbs past the breaker count', () => {
    // Simulate the nightly re-sweep loop: a cursed unit, no live holder, not terminal.
    // Before the fix this returned `breaker` with an ever-rising nextFailCount; now it
    // is `latched` every time, so the stored failCount stays put.
    let storedFailCount = 3; // the breaker count when it tripped
    for (let i = 0; i < 100; i++) {
      const d = evaluatePlacement(obs({ placementStatus: 'cursed', failCount: storedFailCount }), CFG);
      expect(d.kind).toBe('latched');
      // `latched` carries no nextFailCount — the reconcile re-writes the SAME count.
      // (storedFailCount is intentionally NOT bumped — that's the whole point.)
    }
    expect(storedFailCount).toBe(3);
  });

  it('the curse CLEARS when the unit reaches terminal (a re-placed item that finally completed)', () => {
    expect(evaluatePlacement(obs({ placementStatus: 'cursed', failCount: 3, unitTerminal: true }), CFG).kind).toBe('completed');
  });

  it('the curse CLEARS when a LIVE cup re-claims the unit (a fix + re-place that took)', () => {
    expect(evaluatePlacement(obs({ placementStatus: 'cursed', failCount: 3, hasLiveHolder: true }), CFG).kind).toBe('healthy');
  });

  it('the breaker still TRIPS once (recovering → breaker at the threshold), then latches thereafter', () => {
    // First the threshold-th failure trips the breaker (cursed not yet set):
    const trip = evaluatePlacement(
      obs({ placementStatus: 'recovering', failCount: 2, lastRecoveryAtMs: NOW - (CFG.recoveryDebounceMs + 1) }),
      CFG,
    );
    expect(trip.kind).toBe('breaker');
    // The reconcile writes status='cursed'; the NEXT sweep then latches (no second breaker).
    const after = evaluatePlacement(obs({ placementStatus: 'cursed', failCount: 3 }), CFG);
    expect(after.kind).toBe('latched');
  });
});

describe('isReaperReclaim — reaper reclaim vs genuine cup exit (WI-233)', () => {
  it('a wedge-reap (status reaped) is a reaper reclaim', () => {
    expect(isReaperReclaim('reaped', null)).toBe(true);
  });
  it('a P-011 reclaim (status failed + a `reclaimed:` error_message) is a reaper reclaim', () => {
    expect(isReaperReclaim('failed', 'reclaimed: spawn heartbeat stale > 300s (host presumed dead)')).toBe(true);
    expect(isReaperReclaim('failed', 'reclaimed: child process (pid 42) confirmed dead on host-7')).toBe(true);
  });
  it('a GENUINE non-zero exit (status failed carrying the cup\'s OWN error) is NOT a reaper reclaim', () => {
    // This is the case that MUST still count toward the curse — a real cup failure.
    expect(isReaperReclaim('failed', 'Error: tsc exited 2')).toBe(false);
    expect(isReaperReclaim('failed', null)).toBe(false);
  });
  it('a clean finish / a running cup is not a reaper reclaim', () => {
    expect(isReaperReclaim('done', null)).toBe(false);
    expect(isReaperReclaim('running', null)).toBe(false);
    expect(isReaperReclaim('cancelled', null)).toBe(false);
  });
});

describe('evaluatePlacement — WI-233 a reaper-reclaim of a STILL-ALIVE cup does NOT count toward the curse', () => {
  it('a slow-but-alive false reclaim → recover with the fail count held FLAT (no progress toward the curse)', () => {
    const d = evaluatePlacement(obs({ servingCupReclaimedWhileActive: true, failCount: 0 }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextFailCount).toBe(0); // FLAT — a normal failure would be 1
  });

  it('the fail count NEVER reaches the breaker for a string of false reclaims (the false-curse bug)', () => {
    // failCount 2 + a NORMAL failure trips the breaker (== threshold 3); a false reclaim
    // at the SAME count must instead recover flat — the whole point of the relaxation.
    const normal = evaluatePlacement(
      obs({ placementStatus: 'working', failCount: 2 }),
      CFG,
    );
    expect(normal.kind).toBe('breaker');
    const falseReclaim = evaluatePlacement(
      obs({ placementStatus: 'working', failCount: 2, servingCupReclaimedWhileActive: true }),
      CFG,
    );
    expect(falseReclaim.kind).toBe('recover');
    if (falseReclaim.kind === 'recover') expect(falseReclaim.nextFailCount).toBe(2); // held, never 3
  });

  it('the latch holds across MANY false-reclaim sweeps — fail count stays put, item never curses', () => {
    let storedFailCount = 0;
    for (let i = 0; i < 100; i++) {
      const d = evaluatePlacement(
        obs({ placementStatus: 'working', failCount: storedFailCount, servingCupReclaimedWhileActive: true }),
        CFG,
      );
      expect(d.kind).toBe('recover');
      if (d.kind === 'recover') storedFailCount = d.nextFailCount;
    }
    expect(storedFailCount).toBe(0); // never climbed → never cursed
  });

  it('a GENUINE failure (flag false) still climbs toward the curse — the breaker is intact', () => {
    const d = evaluatePlacement(obs({ placementStatus: 'working', failCount: 1, servingCupReclaimedWhileActive: false }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextFailCount).toBe(2);
  });

  it('a live holder still wins over the flag (healthy, hands-off — the flag only matters with no live holder)', () => {
    expect(evaluatePlacement(obs({ hasLiveHolder: true, servingCupReclaimedWhileActive: true }), CFG).kind).toBe('healthy');
  });

  it('an already-cursed item stays LATCHED even with the flag (the latch is checked first — no thrash)', () => {
    expect(evaluatePlacement(obs({ placementStatus: 'cursed', failCount: 3, servingCupReclaimedWhileActive: true }), CFG).kind).toBe('latched');
  });

  it('the recovery debounce still applies to a false reclaim (no re-wake spam mid-recovery)', () => {
    const d = evaluatePlacement(
      obs({ placementStatus: 'recovering', failCount: 0, lastRecoveryAtMs: NOW - 60_000, servingCupReclaimedWhileActive: true }),
      CFG,
    );
    expect(d.kind).toBe('debounced');
  });
});

describe('evaluatePlacement — F-FIX-041 / WI-677 infra-loss handling (two distinct classes)', () => {
  // WI-677 split the two infra signals that F-FIX-041 had bundled:
  //   • operator dormancy (postDormancySweep) — ITEM-INDEPENDENT (the whole operator was
  //     down). An operator-wide outage can NEVER be item-pathology, so it is FULLY EXEMPT:
  //     BOTH counters flat, never curses (same class as reclaimedWhileActive's proof-of-life).
  //     F-FIX-041 wrongly counted it toward the bounded breaker, so a host restart cursed
  //     the whole frontier in lockstep at infraBreakerThreshold (the WI-677 deadlock).
  //   • no-fair-attempt zombie (servingCupMadeNoToolCalls) — PER-ITEM and ambiguous (an
  //     item that crashes cups pre-tool-call also shows 0 tool calls), so it keeps the
  //     BOUNDED infra breaker: graced re-places, but still curses at the bound (no
  //     unbounded retry — the EI-865 safety property).

  it('WI-677 RECURRENCE GUARD (a): a dormancy/host-restart loss is FULLY EXEMPT — neither counter climbs, never curses', () => {
    const d = evaluatePlacement(obs({ postDormancySweep: true, failCount: 0, infraLossCount: 0 }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') {
      expect(d.nextFailCount).toBe(0); // pathology count untouched
      expect(d.nextInfraLossCount).toBe(0); // FLAT — item-independent, accrues toward NO breaker
    }
  });

  it('WI-677 RECURRENCE GUARD (a): a dormancy loss NEVER curses, even one short of the infra bound (the lockstep-curse the deadlock came from)', () => {
    // The exact pre-fix failure: a string of host restarts climbed every placement to
    // infraBreakerThreshold and cursed it at fail_count=0. Now dormancy never accrues, so it
    // can never reach the bound — even seeded one short, it recovers FLAT, never `breaker`.
    const d = evaluatePlacement(obs({ postDormancySweep: true, failCount: 0, infraLossCount: CFG.infraBreakerThreshold - 1 }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') {
      expect(d.nextFailCount).toBe(0);
      expect(d.nextInfraLossCount).toBe(CFG.infraBreakerThreshold - 1); // held — does NOT climb to the bound
    }
  });

  it('the dormancy latch holds across MANY post-restart sweeps — neither counter ever climbs, item never curses', () => {
    let storedFail = 0;
    let storedInfra = 0;
    for (let i = 0; i < 100; i++) {
      const d = evaluatePlacement(obs({ placementStatus: 'working', postDormancySweep: true, failCount: storedFail, infraLossCount: storedInfra }), CFG);
      expect(d.kind).toBe('recover');
      if (d.kind === 'recover') {
        storedFail = d.nextFailCount;
        storedInfra = d.nextInfraLossCount;
      }
    }
    expect(storedFail).toBe(0);
    expect(storedInfra).toBe(0); // never climbed → never cursed, no matter how long the operator flaps
  });

  it('zombie loss (0 tool calls) → recover: pathology fail_count held FLAT, bounded infra_loss_count++', () => {
    const d = evaluatePlacement(obs({ servingCupMadeNoToolCalls: true, failCount: 0, infraLossCount: 0 }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') {
      expect(d.nextFailCount).toBe(0);
      expect(d.nextInfraLossCount).toBe(1); // the per-item zombie signal still climbs the bounded breaker
    }
  });

  it('an infra loss does NOT trip the 3-strike pathology breaker (the false-curse the fix targets)', () => {
    // failCount 2 + a NORMAL loss trips the pathology breaker; the SAME count with an infra
    // signal recovers (dormancy: fully exempt; zombie: goes to the bounded infra counter).
    const normal = evaluatePlacement(obs({ placementStatus: 'working', failCount: 2 }), CFG);
    expect(normal.kind).toBe('breaker');
    for (const infraObs of [
      obs({ placementStatus: 'working', failCount: 2, postDormancySweep: true }),
      obs({ placementStatus: 'working', failCount: 2, servingCupMadeNoToolCalls: true }),
    ]) {
      const d = evaluatePlacement(infraObs, CFG);
      expect(d.kind).toBe('recover');
      if (d.kind === 'recover') expect(d.nextFailCount).toBe(2); // pathology count held, never 3
    }
  });

  it('BOUND: a ZOMBIE loss STILL curses at infraBreakerThreshold — never an unbounded exemption', () => {
    // One below the infra threshold + another ZOMBIE loss → the infra breaker trips (cursed),
    // so even an all-zombie-attributed (or mis-attributed) item eventually halts. dormancy
    // (item-independent) does NOT — see the dormancy guard above.
    const zomb = evaluatePlacement(obs({ servingCupMadeNoToolCalls: true, infraLossCount: CFG.infraBreakerThreshold - 1 }), CFG);
    expect(zomb.kind).toBe('breaker');
    if (zomb.kind === 'breaker') expect(zomb.nextInfraLossCount).toBe(CFG.infraBreakerThreshold);
  });

  it('dormancy takes precedence over a co-occurring zombie signal (a host-restart reap shows both — attribute to the item-independent cause)', () => {
    // A host restart reaps a cup mid-work: postDormancySweep AND (often) 0-tool-calls both
    // read true. The item-independent cause wins → fully exempt, NOT the bounded breaker.
    const d = evaluatePlacement(obs({ postDormancySweep: true, servingCupMadeNoToolCalls: true, infraLossCount: CFG.infraBreakerThreshold - 1 }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextInfraLossCount).toBe(CFG.infraBreakerThreshold - 1); // held — dormancy exemption wins
  });

  it('SAFETY: a genuine item-pathology loss (no infra signal) still curses at the 3-strike breaker', () => {
    const d = evaluatePlacement(
      obs({ placementStatus: 'working', failCount: 2, postDormancySweep: false, servingCupMadeNoToolCalls: false }),
      CFG,
    );
    expect(d.kind).toBe('breaker');
    if (d.kind === 'breaker') expect(d.nextFailCount).toBe(3);
  });

  it('reclaimedWhileActive (proof-of-life) is FULLY exempt — neither counter climbs, even with the infra flags also set', () => {
    const d = evaluatePlacement(
      obs({ servingCupReclaimedWhileActive: true, servingCupMadeNoToolCalls: true, postDormancySweep: true, failCount: 2, infraLossCount: 5 }),
      CFG,
    );
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') {
      expect(d.nextFailCount).toBe(2); // FLAT
      expect(d.nextInfraLossCount).toBe(5); // FLAT — a live (reasoning) cup beats the no-fair-attempt signals
    }
  });

  it('an already-cursed item stays LATCHED even with infra signals set (latch is checked first)', () => {
    expect(
      evaluatePlacement(obs({ placementStatus: 'cursed', failCount: 3, postDormancySweep: true, servingCupMadeNoToolCalls: true }), CFG).kind,
    ).toBe('latched');
  });

  it('a live holder still wins over the infra signals (healthy — they only matter with no live holder)', () => {
    expect(evaluatePlacement(obs({ hasLiveHolder: true, postDormancySweep: true, servingCupMadeNoToolCalls: true }), CFG).kind).toBe('healthy');
  });

  it('the recovery debounce still applies on an infra-loss sweep (no re-wake spam mid-recovery)', () => {
    const d = evaluatePlacement(
      obs({ placementStatus: 'recovering', failCount: 0, lastRecoveryAtMs: NOW - 60_000, postDormancySweep: true }),
      CFG,
    );
    expect(d.kind).toBe('debounced');
  });
});

describe('evaluatePlacement — EI-3216 infra-attribution gates the per-item wake + escalation', () => {
  // The degenerate loop this fixes: a fleet-wide no-cups window made EVERY placement a
  // no-fair-attempt zombie loss, so the whole frontier cursed at fail_count=0 /
  // infra_loss_count=infraBreakerThreshold — flooding the queue with "failed 0×" owner
  // advisories AND firing a Mug recovery wake per item every ~5min. `infraAttributed`
  // tags an ITEM-INDEPENDENT infra decision so the handler suppresses BOTH per-item the
  // recovery wake (recover) and the owner escalation (breaker), recording placement state
  // only (the placements.cursed health metric is the real surface). A genuine item-pathology
  // curse stays NOT-infra-attributed → it still wakes + escalates with its real count.

  it('an INFRA/zombie breaker (the "failed 0×" curse) is infraAttributed — the handler skips the owner escalation', () => {
    const d = evaluatePlacement(
      obs({ servingCupMadeNoToolCalls: true, failCount: 0, infraLossCount: CFG.infraBreakerThreshold - 1 }),
      CFG,
    );
    expect(d.kind).toBe('breaker');
    if (d.kind === 'breaker') {
      expect(d.nextFailCount).toBe(0); // the literal "failed 0×" — cursed via the infra breaker
      expect(d.nextInfraLossCount).toBe(CFG.infraBreakerThreshold);
      expect(d.infraAttributed).toBe(true);
    }
  });

  it('a genuine item-PATHOLOGY breaker is NOT infraAttributed — it still escalates, with a real (>=threshold) count', () => {
    const d = evaluatePlacement(obs({ placementStatus: 'working', failCount: CFG.breakerThreshold - 1 }), CFG);
    expect(d.kind).toBe('breaker');
    if (d.kind === 'breaker') {
      expect(d.nextFailCount).toBe(CFG.breakerThreshold); // never "failed 0×"
      expect(d.nextFailCount).toBeGreaterThanOrEqual(CFG.breakerThreshold);
      expect(d.infraAttributed).toBeFalsy();
    }
  });

  it('an infra recover (zombie / post-dormancy) is infraAttributed — the handler skips the per-item Mug wake', () => {
    for (const infraObs of [
      obs({ servingCupMadeNoToolCalls: true }),
      obs({ postDormancySweep: true }),
    ]) {
      const d = evaluatePlacement(infraObs, CFG);
      expect(d.kind).toBe('recover');
      if (d.kind === 'recover') expect(d.infraAttributed).toBe(true);
    }
  });

  it('a genuine item-pathology recover is NOT infraAttributed — the per-item recovery wake still fires', () => {
    const d = evaluatePlacement(obs({ hasLiveHolder: false, failCount: 0 }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.infraAttributed).toBeFalsy();
  });

  it('a reclaimed-while-active (proof-of-life) recover is NOT infraAttributed — a genuinely-worked item still wakes the Mug to re-anchor', () => {
    const d = evaluatePlacement(obs({ servingCupReclaimedWhileActive: true }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.infraAttributed).toBeFalsy();
  });
});

describe('P-023 — reconcile "steer, don\'t dispatch" WITH the completion mandate', () => {
  // The decider is the structural proof that the Mug PROPOSES placement + DRIVES
  // completion, while cups DISPOSE their own sequencing:
  it('a live cup on a non-terminal unit is HANDS-OFF (healthy) — steering, not micromanagement', () => {
    expect(evaluatePlacement(obs({ hasLiveHolder: true }), CFG).kind).toBe('healthy');
  });
  it('a non-terminal unit with no live cup is DRIVEN (recover), never abandoned', () => {
    expect(evaluatePlacement(obs({ hasLiveHolder: false }), CFG).kind).toBe('recover');
  });
  it('completion is VERIFIED on the unit (terminal), not assumed from a placement', () => {
    // Cup alive but unit not terminal ⇒ still working, NOT completed (no premature done).
    expect(evaluatePlacement(obs({ hasLiveHolder: true, unitTerminal: false }), CFG).kind).toBe('healthy');
    expect(evaluatePlacement(obs({ hasLiveHolder: true, unitTerminal: true }), CFG).kind).toBe('completed');
  });
});

describe('resolveMugOwners — cup discovery spans EVERY Mug-wake (orphan-placement fix)', () => {
  // A fresh-per-wake / adaptive-re-woken Mug accrues several `pot · <slug>/mug`
  // adv_sessions; cups carry whichever owner was current at spawn time as
  // parent_spawn_id. The watchdog must match the WHOLE owner set (resolveMugOwners),
  // not just the newest (resolveMugOwner) — else cups from an earlier wake are
  // orphaned from the ledger (their placements never recorded → MAST 0/0).
  // A tagged-template SQL stub: capture the query, return canned rows.
  const sqlStub = (rows: { coord_owner_id: string; started_at?: number }[]) =>
    (async () => rows) as unknown as Parameters<typeof resolveMugOwners>[0];

  it('returns ALL distinct owners (the discovery superset), not just the newest', async () => {
    const owners = await resolveMugOwners(
      sqlStub([{ coord_owner_id: 'q-newest' }, { coord_owner_id: 'q-middle' }, { coord_owner_id: 'q-first' }]),
      'ws',
      'xbq-slug',
    );
    expect(owners).toEqual(['q-newest', 'q-middle', 'q-first']);
    // The newest (owners[0]) is what reconcile attributes/wakes; the rest are still
    // discovered so their cups reach the ledger.
    expect(owners[0]).toBe('q-newest');
    expect(owners).toContain('q-first');
  });

  it('no pot sessions → empty (reconcile early-returns, no false attribution)', async () => {
    expect(await resolveMugOwners(sqlStub([]), 'ws', 'xbq-slug')).toEqual([]);
  });
});

describe('reconcilePotPlacements — the all-started-hives sweep (orchestration)', () => {
  // reconcileOnePot's real SQL is integration-tested (placement-watchdog.integration.test.ts);
  // here we pin the SWEEP's orchestration — the flag gate, the started-pot iteration,
  // per-pot isolation, and aggregation — via the deps seam (no PG).
  const flagOn = () => vi.fn(async () => true);
  const startedPots = (hives: { workspaceId: string; installSlug: string }[]) => vi.fn(async () => hives);
  const orgPg = () => vi.fn(() => ({ sql: {} }));

  it('is a no-op when the POT_PLACEMENT_WATCHDOG flag is off (never lists or reconciles)', async () => {
    const listStartedPots = vi.fn();
    const reconcileOnePot = vi.fn();
    const out = await reconcilePotPlacements({
      deps: { getFlag: vi.fn(async () => false), listStartedPots, reconcileOnePot } as unknown as Partial<ReconcileSweepDeps>,
    });
    expect(out).toEqual([]);
    expect(listStartedPots).not.toHaveBeenCalled();
    expect(reconcileOnePot).not.toHaveBeenCalled();
  });

  it('flag on but no started hives → empty, no reconcile', async () => {
    const reconcileOnePot = vi.fn();
    const out = await reconcilePotPlacements({
      deps: { getFlag: flagOn(), listStartedPots: startedPots([]), getOrgPg: orgPg(), reconcileOnePot } as unknown as Partial<ReconcileSweepDeps>,
    });
    expect(out).toEqual([]);
    expect(reconcileOnePot).not.toHaveBeenCalled();
  });

  it('reconciles EVERY started pot (with its own ws+slug + the injected now) and aggregates results', async () => {
    const reconcileOnePot = vi.fn(async (_sql: unknown, _ws: string, slug: string, _cfg: unknown, _now: number) => [
      { workItemId: `F-${slug}`, decision: 'recover' },
    ]);
    const out = await reconcilePotPlacements({
      now: 123,
      deps: {
        getFlag: flagOn(),
        listStartedPots: startedPots([
          { workspaceId: 'wsA', installSlug: 'potA' },
          { workspaceId: 'wsB', installSlug: 'potB' },
        ]),
        getOrgPg: orgPg(),
        reconcileOnePot,
      } as unknown as Partial<ReconcileSweepDeps>,
    });
    expect(reconcileOnePot).toHaveBeenCalledTimes(2);
    expect(reconcileOnePot.mock.calls[0]!.slice(1, 3)).toEqual(['wsA', 'potA']);
    expect(reconcileOnePot.mock.calls[1]!.slice(1, 3)).toEqual(['wsB', 'potB']);
    expect(reconcileOnePot.mock.calls[0]![4]).toBe(123); // injected `now` threaded through
    expect(out.map((r) => r.workItemId)).toEqual(['F-potA', 'F-potB']);
  });

  it('per-pot isolation: one pot throwing does not sink the others (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconcileOnePot = vi
      .fn()
      .mockRejectedValueOnce(new Error('potA boom'))
      .mockResolvedValueOnce([{ workItemId: 'F-potB', decision: 'completed' }]);
    const out = await reconcilePotPlacements({
      deps: {
        getFlag: flagOn(),
        listStartedPots: startedPots([
          { workspaceId: 'wsA', installSlug: 'potA' },
          { workspaceId: 'wsB', installSlug: 'potB' },
        ]),
        getOrgPg: orgPg(),
        reconcileOnePot,
      } as unknown as Partial<ReconcileSweepDeps>,
    });
    expect(reconcileOnePot).toHaveBeenCalledTimes(2);
    expect(out).toEqual([{ workItemId: 'F-potB', decision: 'completed' }]); // potA's failure is swallowed
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('evaluateStalePlacementEscalation — EI-1524/1518 backstop escalation GC', () => {
  it('resolves (completed) a cursed escalation whose unit reached terminal', () => {
    expect(
      evaluateStalePlacementEscalation({
        hasEscalation: true,
        placementStatus: 'cursed',
        unitExists: true,
        unitTerminal: true,
      }),
    ).toBe('resolve-completed');
  });

  it('resolves (completed) a STRANDED escalation whose blocker reached terminal', () => {
    expect(
      evaluateStalePlacementEscalation({
        hasEscalation: true,
        placementStatus: 'stranded',
        unitExists: true,
        unitTerminal: true,
      }),
    ).toBe('resolve-completed');
  });

  it('resolves (abandoned) a cursed escalation whose unit no longer exists', () => {
    expect(
      evaluateStalePlacementEscalation({
        hasEscalation: true,
        placementStatus: 'cursed',
        unitExists: false,
        unitTerminal: false,
      }),
    ).toBe('resolve-abandoned');
  });

  it('KEEPS a genuinely-open cursed escalation (unit non-terminal, still exists)', () => {
    expect(
      evaluateStalePlacementEscalation({
        hasEscalation: true,
        placementStatus: 'cursed',
        unitExists: true,
        unitTerminal: false,
      }),
    ).toBe('keep');
  });

  it('KEEPS when there is no escalation to resolve', () => {
    expect(
      evaluateStalePlacementEscalation({
        hasEscalation: false,
        placementStatus: 'cursed',
        unitExists: true,
        unitTerminal: true,
      }),
    ).toBe('keep');
  });

  it('KEEPS a non-cursed/stranded status (e.g. working/recovering) — not our concern', () => {
    for (const placementStatus of ['working', 'recovering', 'completed', 'abandoned']) {
      expect(
        evaluateStalePlacementEscalation({
          hasEscalation: true,
          placementStatus,
          unitExists: true,
          unitTerminal: true,
        }),
      ).toBe('keep');
    }
  });
});

describe('evaluateTerminalPlacementReconcile — EI-6109 completion-reconcile GC (all open statuses)', () => {
  it('completes ANY open placement whose unit reached terminal — incl. working/recovering', () => {
    for (const placementStatus of ['working', 'recovering', 'cursed', 'stranded']) {
      expect(
        evaluateTerminalPlacementReconcile({ placementStatus, unitExists: true, unitTerminal: true }),
      ).toBe('resolve-completed');
    }
  });

  it('completes a working placement whose unit is terminal — the exact drift bug (before the fix it stayed working)', () => {
    expect(
      evaluateTerminalPlacementReconcile({ placementStatus: 'working', unitExists: true, unitTerminal: true }),
    ).toBe('resolve-completed');
  });

  it('completes an infra-attributed cursed placement (no escalation needed) whose unit is terminal', () => {
    // The escalation-only GC required escalation_msg_id IS NOT NULL, so an infra curse
    // (fail_count=0, escalation=null) drifted; the completion decider ignores escalation.
    expect(
      evaluateTerminalPlacementReconcile({ placementStatus: 'cursed', unitExists: true, unitTerminal: true }),
    ).toBe('resolve-completed');
  });

  it('abandons any open placement whose unit no longer exists', () => {
    for (const placementStatus of ['working', 'recovering', 'cursed', 'stranded']) {
      expect(
        evaluateTerminalPlacementReconcile({ placementStatus, unitExists: false, unitTerminal: false }),
      ).toBe('resolve-abandoned');
    }
  });

  it('KEEPS an open placement whose unit is still non-terminal (never robs an in-flight lane)', () => {
    for (const placementStatus of ['working', 'recovering', 'cursed', 'stranded']) {
      expect(
        evaluateTerminalPlacementReconcile({ placementStatus, unitExists: true, unitTerminal: false }),
      ).toBe('keep');
    }
  });

  it('KEEPS an already-terminal placement status (completed/abandoned) — not an open row', () => {
    for (const placementStatus of ['completed', 'abandoned']) {
      expect(
        evaluateTerminalPlacementReconcile({ placementStatus, unitExists: true, unitTerminal: true }),
      ).toBe('keep');
    }
  });
});

describe('evaluatePlacement — attempt-once loss counting (WI-677 round 2, mig 440)', () => {
  // Observed live 2026-07-02 00:27: recovering items with ZERO new cups accrued
  // fail_count 3 across three debounce expiries and re-cursed in ~12 minutes —
  // the counter measured SWEEPS, not attempts. These pin the per-attempt contract.

  it('NO serving cup at all → re-place only, BOTH counters flat (nothing to count)', () => {
    const d = evaluatePlacement(
      obs({ hasServingCup: false, failCount: 2, infraLossCount: 5 }),
      CFG,
    );
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') {
      expect(d.nextFailCount).toBe(2);
      expect(d.nextInfraLossCount).toBe(5);
    }
  });

  it('the SAME dead attempt (spawn id == lastLossSpawnId) is never recounted', () => {
    const d = evaluatePlacement(
      obs({ hasServingCup: true, servingCupSpawnId: 's-corpse-1', lastLossSpawnId: 's-corpse-1', failCount: 1 }),
      CFG,
    );
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextFailCount).toBe(1); // flat — already charged
  });

  it('a NEW dead attempt (different spawn id) still counts toward the pathology breaker', () => {
    const d = evaluatePlacement(
      obs({ hasServingCup: true, servingCupSpawnId: 's-corpse-2', lastLossSpawnId: 's-corpse-1', failCount: 1 }),
      CFG,
    );
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextFailCount).toBe(2); // genuine fresh failure
  });

  it('three DISTINCT dead attempts still trip the breaker (the bound holds)', () => {
    const d = evaluatePlacement(
      obs({ hasServingCup: true, servingCupSpawnId: 's-corpse-3', lastLossSpawnId: 's-corpse-2', failCount: 2 }),
      CFG,
    );
    expect(d.kind).toBe('breaker');
  });

  it('legacy observation (hasServingCup undefined) keeps pre-mig-440 behavior', () => {
    const d = evaluatePlacement(obs({ failCount: 0 }), CFG);
    expect(d.kind).toBe('recover');
    if (d.kind === 'recover') expect(d.nextFailCount).toBe(1);
  });
});
