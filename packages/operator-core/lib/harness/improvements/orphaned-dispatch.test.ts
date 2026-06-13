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
    vi.mocked(readRecentDispatches).mockResolvedValue([
      row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(1), attempt: 2 }), // fired before boot → restart victim
    ]);
    const releaseClaim = vi.fn(async () => null);
    const rollbackAttempt = vi.fn(async () => null);
    const result = await collectOrphanedDispatchSignals('ws-1', { bootMs, recover: { releaseClaim, rollbackAttempt } });
    expect(vi.mocked(markDispatchOrphaned)).toHaveBeenCalledWith(
      'd1',
      'host-restart-recovery',
      expect.stringMatching(/host restarted mid-dispatch/),
    );
    expect(releaseClaim).toHaveBeenCalledWith('EI-1');
    expect(rollbackAttempt).toHaveBeenCalledWith('EI-1', 1); // attempt 2 → rolled back to 1
    expect(result.note).toMatch(/recovered 1 host-restart victim/);
  });

  it('a host-restart victim a late resolve beat us to (mark false) is NOT recovered', async () => {
    const bootMs = NOW - 0.5 * 3_600_000;
    vi.mocked(readRecentDispatches).mockResolvedValue([row({ id: 'd1', itemId: 'EI-1', firedAt: hoursAgo(1), attempt: 1 })]);
    vi.mocked(markDispatchOrphaned).mockResolvedValue(false);
    const releaseClaim = vi.fn(async () => null);
    const rollbackAttempt = vi.fn(async () => null);
    await collectOrphanedDispatchSignals('ws-1', { bootMs, recover: { releaseClaim, rollbackAttempt } });
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(rollbackAttempt).not.toHaveBeenCalled();
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
});
