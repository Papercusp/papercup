/**
 * Tests for the orphaned-dispatch collector (consume-edges P-011) — the
 * silent-worker-death detector over B-04's dispatch ledger.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./dispatch-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch-ledger')>()),
  readRecentDispatches: vi.fn(async () => []),
  markDispatchOrphaned: vi.fn(async () => true),
}));

import {
  scanOrphanedDispatches,
  buildOrphanedDispatchSignals,
  collectOrphanedDispatchSignals,
  isHostRestartVictim,
  isLaneBreakageOrphan,
  isEnvFailureDeath,
  laneInEnvOutage,
  isCauseUnknownOrphan,
  ORPHAN_EVIDENCE_WINDOW_MS,
} from './orphaned-dispatch';
import { readRecentDispatches, markDispatchOrphaned, type ImprovementDispatchRow } from './dispatch-ledger';

const NOW = Date.parse('2026-06-12T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const T = 2 * 3_600_000; // the 2h default threshold, passed explicitly for determinism

function row(p: Partial<ImprovementDispatchRow> & { id: string; itemId: string }): ImprovementDispatchRow {
  return {
    workspaceId: 'ws-1',
    attempt: 1,
    runnerHarness: 'runner',
    firedAt: hoursAgo(4),
    fireResult: 'ok',
    fireError: null,
    spawnedRunId: null,
    outcome: null,
    resolvedAt: null,
    resolvedBy: null,
    ...p,
  };
}

afterEach(() => vi.clearAllMocks());

describe('scanOrphanedDispatches — which open rows mean a dead worker (P-011)', () => {
  it('an open row past the threshold is orphaned; a younger one is presumed still working', () => {
    const rows = [
      row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(3) }), // 3h > 2h → dead
      row({ id: 'd2', itemId: 'EI-2', firedAt: hoursAgo(1) }), // 1h < 2h → in progress
    ];
    expect(scanOrphanedDispatches(rows, { nowMs: NOW, orphanAfterMs: T }).map((r) => r.id)).toEqual(['d1']);
  });

  it('terminal rows are never orphaned — resolve, fire failure, and prior orphans are already accounted for', () => {
    const rows = [
      row({ id: 'd1', itemId: 'EI-1', outcome: 'fixed', resolvedAt: hoursAgo(3) }),
      row({ id: 'd2', itemId: 'EI-2', outcome: 'fire-failed', resolvedAt: hoursAgo(3) }),
      row({ id: 'd3', itemId: 'EI-3', outcome: 'orphaned', resolvedAt: hoursAgo(3) }),
    ];
    expect(scanOrphanedDispatches(rows, { nowMs: NOW, orphanAfterMs: T })).toEqual([]);
  });

  it('a row stuck at fire_result=pending (the dispatcher died mid-fire) orphans like any dead worker', () => {
    const rows = [row({ id: 'd1', itemId: 'EI-1', fireResult: 'pending', firedAt: hoursAgo(5) })];
    expect(scanOrphanedDispatches(rows, { nowMs: NOW, orphanAfterMs: T })).toHaveLength(1);
  });

  it('an unparseable firedAt is treated as infinitely old (conservative — the row cannot be vouched for)', () => {
    const rows = [row({ id: 'd1', itemId: 'EI-1', firedAt: 'not-a-date' })];
    expect(scanOrphanedDispatches(rows, { nowMs: NOW, orphanAfterMs: T })).toHaveLength(1);
  });

  it('a row fired before this process booted is a host-restart victim — orphaned regardless of age (EI-403 Option B)', () => {
    const bootMs = NOW - 0.5 * 3_600_000; // this process booted 30 min ago
    const rows = [
      row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(1) }), // 1h old (< 2h) but predates boot → restart victim
      row({ id: 'd2', itemId: 'EI-2', firedAt: new Date(NOW - 10 * 60_000).toISOString() }), // fired after boot → in progress
    ];
    expect(scanOrphanedDispatches(rows, { nowMs: NOW, orphanAfterMs: T, bootMs }).map((r) => r.id)).toEqual(['d1']);
  });

  it('bootMs<=0 disables the host-restart leg (pure threshold semantics preserved)', () => {
    const rows = [row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(1) })];
    expect(scanOrphanedDispatches(rows, { nowMs: NOW, orphanAfterMs: T, bootMs: 0 })).toEqual([]);
    expect(isHostRestartVictim(rows[0], 0)).toBe(false);
    expect(isHostRestartVictim(rows[0], NOW)).toBe(true);
  });
});

describe('buildOrphanedDispatchSignals — one signal per item, stable identity', () => {
  it('groups multiple orphaned dispatches of one item into ONE signal with the count in the body', () => {
    const evidence = [
      row({ id: 'd1', itemId: 'EI-9', outcome: 'orphaned', resolvedAt: hoursAgo(3), attempt: 1 }),
      row({ id: 'd2', itemId: 'EI-9', outcome: 'orphaned', resolvedAt: hoursAgo(1), attempt: 2, firedAt: hoursAgo(3), spawnedRunId: 'run-77' }),
    ];
    const signals = buildOrphanedDispatchSignals(evidence, { nowMs: NOW });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: 'orphaned-dispatch', key: 'EI-9', severity: 'major', kind: 'bug' });
    expect(signals[0].title).toBe('Auto-implement dispatch for EI-9 died without resolving — orphaned worker');
    expect(signals[0].body).toMatch(/2 dispatch\(es\)/);
    expect(signals[0].body).toMatch(/run-77/);
    expect(signals[0].latestAt).toBe(hoursAgo(1)); // newest evidence backs the stale-resolved re-file check
  });

  it('non-orphaned rows are not evidence', () => {
    const evidence = [
      row({ id: 'd1', itemId: 'EI-1', outcome: 'fixed', resolvedAt: hoursAgo(1) }),
      row({ id: 'd2', itemId: 'EI-2' }), // still open
    ];
    expect(buildOrphanedDispatchSignals(evidence, { nowMs: NOW })).toEqual([]);
  });

  it('evidence outside the re-fire window ages out (the capture either landed long ago or never will)', () => {
    const evidence = [
      row({ id: 'd1', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: new Date(NOW - ORPHAN_EVIDENCE_WINDOW_MS - 60_000).toISOString() }),
    ];
    expect(buildOrphanedDispatchSignals(evidence, { nowMs: NOW })).toEqual([]);
  });

  it('caps at maxSignals, newest evidence first', () => {
    const evidence = ['EI-1', 'EI-2', 'EI-3'].map((itemId, i) =>
      row({ id: `d${i}`, itemId, outcome: 'orphaned', resolvedAt: hoursAgo(i + 1) }),
    );
    const signals = buildOrphanedDispatchSignals(evidence, { nowMs: NOW, maxSignals: 2 });
    expect(signals.map((s) => s.key)).toEqual(['EI-1', 'EI-2']); // EI-1 newest (1h), EI-3 dropped
  });
});

describe('isLaneBreakageOrphan — env-failure + host-restart orphans do NOT false-alarm (EI-536 noise loop)', () => {
  it('a host-restart-recovered orphan is NOT lane breakage (infra, already recovered)', () => {
    const r = row({ id: 'd1', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'host-restart-recovery' });
    expect(isLaneBreakageOrphan(r)).toBe(false);
    expect(buildOrphanedDispatchSignals([r], { nowMs: NOW })).toEqual([]);
  });

  it('an env-failure orphan (rate-limit/auth, resolved_by …-env) is NOT lane breakage (transient, self-resolving)', () => {
    const r = row({ id: 'd2', itemId: 'EI-2', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'worker-exit-backedge-env' });
    expect(isLaneBreakageOrphan(r)).toBe(false);
    expect(buildOrphanedDispatchSignals([r], { nowMs: NOW })).toEqual([]);
  });

  it('a LEGACY env orphan (pre-distinct resolved_by, but detail carries [env-failure]) is still excluded', () => {
    const r = row({
      id: 'd3', itemId: 'EI-3', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'worker-exit-backedge',
      fireError: 'worker exit 1 after 0s [env-failure: env signature /rate.?limit/i; attempt 2 not charged]: rate-limit pause',
    });
    expect(isLaneBreakageOrphan(r)).toBe(false);
    expect(buildOrphanedDispatchSignals([r], { nowMs: NOW })).toEqual([]);
  });

  it('a GENUINE non-env worker death (attempt charged) DOES signal — the lane may be broken', () => {
    const r = row({
      id: 'd4', itemId: 'EI-4', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'worker-exit-backedge',
      fireError: 'worker exit 1 after 600s [no resolve recorded; attempt charged]: tests still red',
    });
    expect(isLaneBreakageOrphan(r)).toBe(true);
    expect(buildOrphanedDispatchSignals([r], { nowMs: NOW })).toHaveLength(1);
  });

  it('the 2h collector catch-all (resolved_by orphaned-dispatch-collector) still signals', () => {
    const r = row({ id: 'd5', itemId: 'EI-5', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'orphaned-dispatch-collector' });
    expect(isLaneBreakageOrphan(r)).toBe(true);
    expect(buildOrphanedDispatchSignals([r], { nowMs: NOW })).toHaveLength(1);
  });

  it('a MIX of env + host-restart + genuine surfaces ONLY the genuine item', () => {
    const evidence = [
      row({ id: 'a', itemId: 'EI-ENV', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'worker-exit-backedge-env' }),
      row({ id: 'b', itemId: 'EI-HR', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'host-restart-recovery' }),
      row({ id: 'c', itemId: 'EI-REAL', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'orphaned-dispatch-collector' }),
    ];
    expect(buildOrphanedDispatchSignals(evidence, { nowMs: NOW }).map((s) => s.key)).toEqual(['EI-REAL']);
  });
});

describe('env-outage suppression — cause-unknown orphans during a credential outage are not lane breakage (D-004)', () => {
  it('isEnvFailureDeath recognises both the distinct resolved_by and the legacy [env-failure] detail', () => {
    expect(isEnvFailureDeath(row({ id: 'a', itemId: 'EI-1', resolvedBy: 'worker-exit-backedge-env' }))).toBe(true);
    expect(
      isEnvFailureDeath(
        row({ id: 'b', itemId: 'EI-2', resolvedBy: 'worker-exit-backedge', fireError: 'worker exit 1 [env-failure: /rate.?limit/i]' }),
      ),
    ).toBe(true);
    expect(isEnvFailureDeath(row({ id: 'c', itemId: 'EI-3', resolvedBy: 'orphaned-dispatch-collector' }))).toBe(false);
  });

  it('laneInEnvOutage: ≥2 env-failure deaths inside the window ⇒ outage', () => {
    const rows = [
      row({ id: 'a', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'worker-exit-backedge-env' }),
      row({
        id: 'b', itemId: 'EI-2', outcome: 'orphaned', resolvedAt: hoursAgo(2), resolvedBy: 'worker-exit-backedge',
        fireError: 'worker exit 1 after 0s [env-failure: env signature /rate.?limit/i]',
      }),
    ];
    expect(laneInEnvOutage(rows, { nowMs: NOW })).toBe(true);
  });

  it('laneInEnvOutage: a single env death is not an outage; deaths older than the 6h window age out', () => {
    expect(
      laneInEnvOutage(
        [row({ id: 'a', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'worker-exit-backedge-env' })],
        { nowMs: NOW },
      ),
    ).toBe(false);
    const old = [
      row({ id: 'a', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(7), resolvedBy: 'worker-exit-backedge-env' }),
      row({ id: 'b', itemId: 'EI-2', outcome: 'orphaned', resolvedAt: hoursAgo(8), resolvedBy: 'worker-exit-backedge-env' }),
    ];
    expect(laneInEnvOutage(old, { nowMs: NOW })).toBe(false);
  });

  it('isCauseUnknownOrphan: a 2h-collector orphan with no death cause is cause-unknown; one with a real fireError is not', () => {
    expect(isCauseUnknownOrphan(row({ id: 'a', itemId: 'EI-1', outcome: 'orphaned', resolvedBy: 'orphaned-dispatch-collector' }))).toBe(true);
    expect(
      isCauseUnknownOrphan(
        row({
          id: 'b', itemId: 'EI-2', outcome: 'orphaned', resolvedBy: 'orphaned-dispatch-collector',
          fireError: 'worker exit 1 after 600s [no resolve recorded; attempt charged]: tests still red',
        }),
      ),
    ).toBe(false);
  });

  it('during an outage a cause-unknown orphan is suppressed, but a genuine (real-error) orphan still signals', () => {
    const evidence = [
      row({ id: 'unk', itemId: 'EI-UNK', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'orphaned-dispatch-collector' }),
      row({
        id: 'real', itemId: 'EI-REAL', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'orphaned-dispatch-collector',
        fireError: 'worker exit 1 after 600s [no resolve recorded; attempt charged]: tests still red',
      }),
    ];
    expect(buildOrphanedDispatchSignals(evidence, { nowMs: NOW, envOutage: true }).map((s) => s.key)).toEqual(['EI-REAL']);
    // healthy lane (envOutage false, the default): BOTH signal
    expect(buildOrphanedDispatchSignals(evidence, { nowMs: NOW, envOutage: false }).map((s) => s.key).sort()).toEqual(['EI-REAL', 'EI-UNK']);
  });
});

describe('collectOrphanedDispatchSignals — the PG glue', () => {
  // The glue reads the real clock — pin it to the fixtures' NOW.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('marks overdue open rows orphaned, then signals per affected item (with the marked note)', async () => {
    vi.mocked(readRecentDispatches).mockResolvedValue([
      row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(4) }),
      row({ id: 'd2', itemId: 'EI-2', firedAt: hoursAgo(1) }), // in progress — untouched
    ]);
    const result = await collectOrphanedDispatchSignals('ws-1', { bootMs: 0 });
    expect(vi.mocked(markDispatchOrphaned)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(markDispatchOrphaned)).toHaveBeenCalledWith('d1');
    expect(result.signals.map((s) => s.key)).toEqual(['EI-1']);
    expect(result.note).toMatch(/marked 1 open dispatch/);
  });

  it('a row a late resolve beat us to (mark returns false) is NOT evidence — nothing was silent', async () => {
    vi.mocked(readRecentDispatches).mockResolvedValue([row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(4) })]);
    vi.mocked(markDispatchOrphaned).mockResolvedValue(false);
    const result = await collectOrphanedDispatchSignals('ws-1', { bootMs: 0 });
    expect(result.signals).toEqual([]);
  });

  it('already-orphaned rows keep signaling inside the window without re-marking (deferral survival)', async () => {
    vi.mocked(readRecentDispatches).mockResolvedValue([
      row({ id: 'd1', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(2) }),
    ]);
    const result = await collectOrphanedDispatchSignals('ws-1', { bootMs: 0 });
    expect(vi.mocked(markDispatchOrphaned)).not.toHaveBeenCalled();
    expect(result.signals.map((s) => s.key)).toEqual(['EI-1']);
  });

  it('recovers a host-restart victim: orphans with host-restart-recovery, releases the claim, rolls the attempt back (EI-403 Option B)', async () => {
    const bootMs = NOW - 0.5 * 3_600_000; // booted 30 min ago
    vi.mocked(markDispatchOrphaned).mockResolvedValue(true); // explicit — clearAllMocks doesn't reset a prior mockResolvedValue
    vi.mocked(readRecentDispatches).mockResolvedValue([
      row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(1), attempt: 2 }), // fired before boot → restart victim
    ]);
    const releaseClaim = vi.fn(async () => null);
    const rollbackAttempt = vi.fn(async () => null);
    const escalateThrash = vi.fn(async () => null);
    const result = await collectOrphanedDispatchSignals('ws-1', {
      bootMs,
      recover: { releaseClaim, rollbackAttempt, escalateThrash },
    });
    expect(vi.mocked(markDispatchOrphaned)).toHaveBeenCalledWith(
      'd1',
      'host-restart-recovery',
      expect.stringMatching(/host restarted mid-dispatch/),
    );
    expect(releaseClaim).toHaveBeenCalledWith('EI-1');
    expect(rollbackAttempt).toHaveBeenCalledWith('EI-1', 1); // attempt 2 → rolled back to 1
    expect(escalateThrash).not.toHaveBeenCalled(); // only 1 victim — well under the cap
    expect(result.note).toMatch(/recovered 1 host-restart victim/);
  });

  it('EI-1689: trips the re-dispatch breaker after the cap — routes to human, does NOT re-dispatch', async () => {
    const bootMs = NOW - 0.5 * 3_600_000; // booted 30 min ago
    vi.mocked(markDispatchOrphaned).mockResolvedValue(true);
    vi.mocked(readRecentDispatches).mockResolvedValue([
      // the current OPEN victim (fired before boot) — its 4th host-restart cycle
      row({ id: 'd4', itemId: 'EI-1', firedAt: hoursAgo(1), attempt: 4 }),
      // 3 PRIOR host-restart recoveries for the SAME item, inside the 6h window → at the cap
      row({ id: 'd3', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'host-restart-recovery' }),
      row({ id: 'd2', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(2), resolvedBy: 'host-restart-recovery' }),
      row({ id: 'd1', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(3), resolvedBy: 'host-restart-recovery' }),
    ]);
    const releaseClaim = vi.fn(async () => null);
    const rollbackAttempt = vi.fn(async () => null);
    const escalateThrash = vi.fn(async () => null);
    const result = await collectOrphanedDispatchSignals('ws-1', {
      bootMs,
      recover: { releaseClaim, rollbackAttempt, escalateThrash },
    });
    expect(releaseClaim).toHaveBeenCalledWith('EI-1'); // dead worker's claim still cleaned up
    expect(escalateThrash).toHaveBeenCalledWith('EI-1'); // routed to human
    expect(rollbackAttempt).not.toHaveBeenCalled(); // NOT re-dispatched
    expect(result.note).toMatch(/routed 1 thrashing item/);
    expect(vi.mocked(markDispatchOrphaned)).toHaveBeenCalledWith(
      'd4',
      'host-restart-recovery',
      expect.stringMatching(/re-dispatch cap .* exceeded/),
    );
  });

  it('EI-1689: does NOT trip the breaker below the cap — re-dispatches normally', async () => {
    const bootMs = NOW - 0.5 * 3_600_000;
    vi.mocked(markDispatchOrphaned).mockResolvedValue(true);
    vi.mocked(readRecentDispatches).mockResolvedValue([
      row({ id: 'd3', itemId: 'EI-1', firedAt: hoursAgo(1), attempt: 3 }), // current open victim (3rd cycle)
      row({ id: 'd2', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'host-restart-recovery' }),
      row({ id: 'd1', itemId: 'EI-1', outcome: 'orphaned', resolvedAt: hoursAgo(2), resolvedBy: 'host-restart-recovery' }),
    ]);
    const releaseClaim = vi.fn(async () => null);
    const rollbackAttempt = vi.fn(async () => null);
    const escalateThrash = vi.fn(async () => null);
    await collectOrphanedDispatchSignals('ws-1', {
      bootMs,
      recover: { releaseClaim, rollbackAttempt, escalateThrash },
    });
    expect(rollbackAttempt).toHaveBeenCalledWith('EI-1', 2); // attempt 3 → rolled back to 2 (re-dispatched)
    expect(escalateThrash).not.toHaveBeenCalled(); // 2 prior recoveries < cap of 3
  });

  it('a host-restart victim a late resolve beat us to (mark false) is NOT recovered', async () => {
    const bootMs = NOW - 0.5 * 3_600_000;
    vi.mocked(readRecentDispatches).mockResolvedValue([row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(1), attempt: 1 })]);
    vi.mocked(markDispatchOrphaned).mockResolvedValue(false);
    const releaseClaim = vi.fn(async () => null);
    const rollbackAttempt = vi.fn(async () => null);
    const escalateThrash = vi.fn(async () => null);
    await collectOrphanedDispatchSignals('ws-1', { bootMs, recover: { releaseClaim, rollbackAttempt, escalateThrash } });
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(rollbackAttempt).not.toHaveBeenCalled();
    expect(escalateThrash).not.toHaveBeenCalled();
  });

  it('skips with a NOTE (not an error) while migration 238 is not applied — deploy ordering must not self-escalate', async () => {
    vi.mocked(readRecentDispatches).mockRejectedValue(
      Object.assign(new Error('relation "harness_shared.improvement_dispatches" does not exist'), { code: '42P01' }),
    );
    const result = await collectOrphanedDispatchSignals('ws-1', { bootMs: 0 });
    expect(result.signals).toEqual([]);
    expect(result.note).toMatch(/migration 238 not applied/);
  });

  it('any other PG failure propagates — the collector status must record it', async () => {
    vi.mocked(readRecentDispatches).mockRejectedValue(new Error('connection refused'));
    await expect(collectOrphanedDispatchSignals('ws-1', { bootMs: 0 })).rejects.toThrow(/connection refused/);
  });

  it('suppresses cause-unknown orphans + notes it when the lane is in an env outage (EI-536 loop guard)', async () => {
    vi.mocked(readRecentDispatches).mockResolvedValue([
      // two env-failure deaths in-window ⇒ outage
      row({ id: 'e1', itemId: 'EI-ENV1', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'worker-exit-backedge-env' }),
      row({
        id: 'e2', itemId: 'EI-ENV2', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'worker-exit-backedge',
        fireError: 'worker exit 1 after 0s [env-failure: env signature /rate.?limit/i]',
      }),
      // a cause-unknown 2h-collector orphan — an outage casualty, must be suppressed
      row({ id: 'u1', itemId: 'EI-UNK', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'orphaned-dispatch-collector' }),
    ]);
    const result = await collectOrphanedDispatchSignals('ws-1', { bootMs: 0 });
    expect(result.signals).toEqual([]); // env deaths filtered + cause-unknown suppressed
    expect(result.note).toMatch(/env-outage detected/);
  });

  it('a HEALTHY lane (no env deaths) still signals a cause-unknown orphan', async () => {
    vi.mocked(readRecentDispatches).mockResolvedValue([
      row({ id: 'u1', itemId: 'EI-UNK', outcome: 'orphaned', resolvedAt: hoursAgo(1), resolvedBy: 'orphaned-dispatch-collector' }),
    ]);
    const result = await collectOrphanedDispatchSignals('ws-1', { bootMs: 0 });
    expect(result.signals.map((s) => s.key)).toEqual(['EI-UNK']);
    expect(result.note ?? '').not.toMatch(/env-outage/);
  });
});
