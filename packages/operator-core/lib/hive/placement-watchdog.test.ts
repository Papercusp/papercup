/**
 * placement-watchdog.test.ts — the COMPLETION GUARANTEE behavioral contract,
 * pure (no PG). Pins B-09: P-020 (track each placement to terminal + recover a
 * dead/stalled bee), P-021 (cursed-item breaker mirrors replanStrikes), and
 * P-023 (reconcile "steer, don't dispatch" WITH the completion mandate).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveBeeLiveness,
  evaluatePlacement,
  isUnitTerminal,
  isStuckBlockerState,
  placementConfig,
  type PlacementObservation,
  type PlacementConfig,
} from './placement-watchdog';
import { RECLAIM_STALE_MS, WEDGE_SILENT_MS } from '../fleet/spawn-reclaim';

const CFG: PlacementConfig = { breakerThreshold: 3, recoveryDebounceMs: 5 * 60_000 };
const NOW = 1_000_000_000_000;

function obs(over: Partial<PlacementObservation>): PlacementObservation {
  return {
    workItemId: 'F-001',
    unitExists: true,
    unitTerminal: false,
    hasLiveHolder: false,
    failCount: 0,
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

describe('deriveBeeLiveness (P-020 — reuses the fleet-reclaim thresholds)', () => {
  it('terminal spawn status → dead', () => {
    for (const status of ['done', 'failed', 'cancelled', 'reaped']) {
      expect(deriveBeeLiveness({ status, heartbeatAtMs: NOW, lastOutputAtMs: NOW, now: NOW })).toBe('dead');
    }
  });
  it('running + fresh heartbeat → live', () => {
    expect(deriveBeeLiveness({ status: 'running', heartbeatAtMs: NOW - 1000, lastOutputAtMs: NOW - 1000, now: NOW })).toBe('live');
  });
  it('running + heartbeat stale beyond RECLAIM_STALE_MS → dead (orphaned)', () => {
    expect(
      deriveBeeLiveness({ status: 'running', heartbeatAtMs: NOW - RECLAIM_STALE_MS - 1, lastOutputAtMs: NOW, now: NOW }),
    ).toBe('dead');
  });
  it('running + fresh heartbeat but output silent beyond WEDGE_SILENT_MS → wedged', () => {
    expect(
      deriveBeeLiveness({ status: 'running', heartbeatAtMs: NOW - 1000, lastOutputAtMs: NOW - WEDGE_SILENT_MS - 1, now: NOW }),
    ).toBe('wedged');
  });
  it('running + null heartbeat (freshly spawned) → live (reclaim owns true orphans)', () => {
    expect(deriveBeeLiveness({ status: 'running', heartbeatAtMs: null, lastOutputAtMs: null, now: NOW })).toBe('live');
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
  it('terminal beats a dead holder — a bee that completed then died still counts done', () => {
    // The unit reached terminal; the serving bee being dead is irrelevant.
    expect(evaluatePlacement(obs({ hasLiveHolder: false, unitTerminal: true }), CFG).kind).toBe('completed');
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
    const cfg: PlacementConfig = { breakerThreshold: 1, recoveryDebounceMs: 0 };
    // First failure already reaches threshold 1 → breaker, never re-placed.
    expect(evaluatePlacement(obs({ failCount: 0 }), cfg).kind).toBe('breaker');
  });
  it('placementConfig defaults mirror replanStrikes (3) and a 5-min debounce', () => {
    const cfg = placementConfig();
    expect(cfg.breakerThreshold).toBe(3);
    expect(cfg.recoveryDebounceMs).toBe(5 * 60_000);
  });
});

describe('P-023 — reconcile "steer, don\'t dispatch" WITH the completion mandate', () => {
  // The decider is the structural proof that the Queen PROPOSES placement + DRIVES
  // completion, while bees DISPOSE their own sequencing:
  it('a live bee on a non-terminal unit is HANDS-OFF (healthy) — steering, not micromanagement', () => {
    expect(evaluatePlacement(obs({ hasLiveHolder: true }), CFG).kind).toBe('healthy');
  });
  it('a non-terminal unit with no live bee is DRIVEN (recover), never abandoned', () => {
    expect(evaluatePlacement(obs({ hasLiveHolder: false }), CFG).kind).toBe('recover');
  });
  it('completion is VERIFIED on the unit (terminal), not assumed from a placement', () => {
    // Bee alive but unit not terminal ⇒ still working, NOT completed (no premature done).
    expect(evaluatePlacement(obs({ hasLiveHolder: true, unitTerminal: false }), CFG).kind).toBe('healthy');
    expect(evaluatePlacement(obs({ hasLiveHolder: true, unitTerminal: true }), CFG).kind).toBe('completed');
  });
});
