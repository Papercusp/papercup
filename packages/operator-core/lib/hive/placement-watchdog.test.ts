/**
 * placement-watchdog.test.ts — the COMPLETION GUARANTEE behavioral contract,
 * pure (no PG). Pins B-09: P-020 (track each placement to terminal + recover a
 * dead/stalled bee), P-021 (cursed-item breaker mirrors replanStrikes), and
 * P-023 (reconcile "steer, don't dispatch" WITH the completion mandate).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  deriveBeeLiveness,
  evaluatePlacement,
  isUnitTerminal,
  isStuckBlockerState,
  placementConfig,
  reconcileHivePlacements,
  resolveQueenOwners,
  type PlacementObservation,
  type PlacementConfig,
  type ReconcileSweepDeps,
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

describe('resolveQueenOwners — bee discovery spans EVERY Queen-wake (orphan-placement fix)', () => {
  // A fresh-per-wake / adaptive-re-woken Queen accrues several `hive · <slug>/queen`
  // adv_sessions; bees carry whichever owner was current at spawn time as
  // parent_spawn_id. The watchdog must match the WHOLE owner set (resolveQueenOwners),
  // not just the newest (resolveQueenOwner) — else bees from an earlier wake are
  // orphaned from the ledger (their placements never recorded → MAST 0/0).
  // A tagged-template SQL stub: capture the query, return canned rows.
  const sqlStub = (rows: { coord_owner_id: string; started_at?: number }[]) =>
    (async () => rows) as unknown as Parameters<typeof resolveQueenOwners>[0];

  it('returns ALL distinct owners (the discovery superset), not just the newest', async () => {
    const owners = await resolveQueenOwners(
      sqlStub([{ coord_owner_id: 'q-newest' }, { coord_owner_id: 'q-middle' }, { coord_owner_id: 'q-first' }]),
      'ws',
      'xbq-slug',
    );
    expect(owners).toEqual(['q-newest', 'q-middle', 'q-first']);
    // The newest (owners[0]) is what reconcile attributes/wakes; the rest are still
    // discovered so their bees reach the ledger.
    expect(owners[0]).toBe('q-newest');
    expect(owners).toContain('q-first');
  });

  it('no hive sessions → empty (reconcile early-returns, no false attribution)', async () => {
    expect(await resolveQueenOwners(sqlStub([]), 'ws', 'xbq-slug')).toEqual([]);
  });
});

describe('reconcileHivePlacements — the all-started-hives sweep (orchestration)', () => {
  // reconcileOneHive's real SQL is integration-tested (placement-watchdog.integration.test.ts);
  // here we pin the SWEEP's orchestration — the flag gate, the started-hive iteration,
  // per-hive isolation, and aggregation — via the deps seam (no PG).
  const flagOn = () => vi.fn(async () => true);
  const startedHives = (hives: { workspaceId: string; installSlug: string }[]) => vi.fn(async () => hives);
  const orgPg = () => vi.fn(() => ({ sql: {} }));

  it('is a no-op when the HIVE_PLACEMENT_WATCHDOG flag is off (never lists or reconciles)', async () => {
    const listStartedHives = vi.fn();
    const reconcileOneHive = vi.fn();
    const out = await reconcileHivePlacements({
      deps: { getFlag: vi.fn(async () => false), listStartedHives, reconcileOneHive } as unknown as Partial<ReconcileSweepDeps>,
    });
    expect(out).toEqual([]);
    expect(listStartedHives).not.toHaveBeenCalled();
    expect(reconcileOneHive).not.toHaveBeenCalled();
  });

  it('flag on but no started hives → empty, no reconcile', async () => {
    const reconcileOneHive = vi.fn();
    const out = await reconcileHivePlacements({
      deps: { getFlag: flagOn(), listStartedHives: startedHives([]), getOrgPg: orgPg(), reconcileOneHive } as unknown as Partial<ReconcileSweepDeps>,
    });
    expect(out).toEqual([]);
    expect(reconcileOneHive).not.toHaveBeenCalled();
  });

  it('reconciles EVERY started hive (with its own ws+slug + the injected now) and aggregates results', async () => {
    const reconcileOneHive = vi.fn(async (_sql: unknown, _ws: string, slug: string, _cfg: unknown, _now: number) => [
      { workItemId: `F-${slug}`, decision: 'recover' },
    ]);
    const out = await reconcileHivePlacements({
      now: 123,
      deps: {
        getFlag: flagOn(),
        listStartedHives: startedHives([
          { workspaceId: 'wsA', installSlug: 'hiveA' },
          { workspaceId: 'wsB', installSlug: 'hiveB' },
        ]),
        getOrgPg: orgPg(),
        reconcileOneHive,
      } as unknown as Partial<ReconcileSweepDeps>,
    });
    expect(reconcileOneHive).toHaveBeenCalledTimes(2);
    expect(reconcileOneHive.mock.calls[0]!.slice(1, 3)).toEqual(['wsA', 'hiveA']);
    expect(reconcileOneHive.mock.calls[1]!.slice(1, 3)).toEqual(['wsB', 'hiveB']);
    expect(reconcileOneHive.mock.calls[0]![4]).toBe(123); // injected `now` threaded through
    expect(out.map((r) => r.workItemId)).toEqual(['F-hiveA', 'F-hiveB']);
  });

  it('per-hive isolation: one hive throwing does not sink the others (fail-soft)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reconcileOneHive = vi
      .fn()
      .mockRejectedValueOnce(new Error('hiveA boom'))
      .mockResolvedValueOnce([{ workItemId: 'F-hiveB', decision: 'completed' }]);
    const out = await reconcileHivePlacements({
      deps: {
        getFlag: flagOn(),
        listStartedHives: startedHives([
          { workspaceId: 'wsA', installSlug: 'hiveA' },
          { workspaceId: 'wsB', installSlug: 'hiveB' },
        ]),
        getOrgPg: orgPg(),
        reconcileOneHive,
      } as unknown as Partial<ReconcileSweepDeps>,
    });
    expect(reconcileOneHive).toHaveBeenCalledTimes(2);
    expect(out).toEqual([{ workItemId: 'F-hiveB', decision: 'completed' }]); // hiveA's failure is swallowed
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
