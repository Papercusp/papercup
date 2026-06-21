/**
 * Tests for the dispatcher-staleness collector (EI-2150) — the detector for the
 * auto-implement DISPATCHER going silent (lastDispatchAt stale) while armed,
 * never-dispatched work waits. Distinct from orphaned-dispatch, which catches DEAD
 * WORKERS on open rows; this catches NO dispatches at all.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  buildDispatcherStalenessSignal,
  collectDispatcherStalenessSignals,
  DEFAULT_DISPATCHER_STALENESS_THRESHOLD_MS,
  type DispatcherStalenessDeps,
  type EligibleDispatchItem,
} from './dispatcher-staleness';
import type { ImprovementDispatchRow } from './dispatch-ledger';
import type { ImprovementCandidate } from './policy';

const NOW = Date.parse('2026-06-21T00:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const T = DEFAULT_DISPATCHER_STALENESS_THRESHOLD_MS; // 6h

function eligible(p: Partial<EligibleDispatchItem> & { id: string }): EligibleDispatchItem {
  return { ageMs: 20 * 3_600_000, triagedPlace: true, ...p };
}

// ── pure core ────────────────────────────────────────────────────────────────

describe('buildDispatcherStalenessSignal — the pure fire decision (EI-2150)', () => {
  it('FIRES when armed, eligible work has waited past the threshold, and lastDispatchAt is stale', () => {
    const signals = buildDispatcherStalenessSignal({
      armed: true,
      lastDispatchAt: hoursAgo(34),
      eligible: [eligible({ id: 'EI-1' }), eligible({ id: 'EI-2', triagedPlace: false })],
      nowMs: NOW,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].source).toBe('dispatcher-staleness');
    expect(signals[0].key).toBe('auto-implement-dispatcher');
    expect(signals[0].kind).toBe('change'); // routes to the human queue, not the dark lane
    expect(signals[0].severity).toBe('major');
    expect(signals[0].findingClass).toBe('dispatcher-staleness:auto-implement');
    // Live-state signal: no latestAt (a re-file after resolve is always a real regression).
    expect(signals[0].latestAt).toBeUndefined();
    expect(signals[0].body).toContain('2 auto-eligible'); // eligibleCount
    expect(signals[0].body).toContain("1 triaged 'place'"); // one of the two was triaged place
  });

  it('does NOT fire when the lane is disarmed', () => {
    expect(
      buildDispatcherStalenessSignal({ armed: false, lastDispatchAt: hoursAgo(34), eligible: [eligible({ id: 'EI-1' })], nowMs: NOW }),
    ).toEqual([]);
  });

  it('does NOT fire when the eligible queue is empty (nothing to dispatch)', () => {
    expect(
      buildDispatcherStalenessSignal({ armed: true, lastDispatchAt: hoursAgo(34), eligible: [], nowMs: NOW }),
    ).toEqual([]);
  });

  it('does NOT fire when the oldest eligible item has not yet waited past the threshold (fresh after a long idle)', () => {
    // lastDispatchAt is ancient, but the only eligible item just arrived (1h < 6h) — give
    // the dispatcher a cadence tick to pick it up rather than false-positive.
    expect(
      buildDispatcherStalenessSignal({
        armed: true,
        lastDispatchAt: hoursAgo(34),
        eligible: [eligible({ id: 'EI-1', ageMs: 1 * 3_600_000 })],
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it('does NOT fire when lastDispatchAt is fresh (a slow-but-working dispatcher draining a backlog)', () => {
    // The oldest eligible item is old (deep backlog), but the dispatcher fired 1h ago — it
    // IS working, just one-per-tick. Not a stall.
    expect(
      buildDispatcherStalenessSignal({
        armed: true,
        lastDispatchAt: hoursAgo(1),
        eligible: [eligible({ id: 'EI-1', ageMs: 30 * 3_600_000 })],
        nowMs: NOW,
      }),
    ).toEqual([]);
  });

  it('does NOT fire when the dispatcher has never dispatched (lastDispatchAt null — out of scope)', () => {
    expect(
      buildDispatcherStalenessSignal({ armed: true, lastDispatchAt: null, eligible: [eligible({ id: 'EI-1' })], nowMs: NOW }),
    ).toEqual([]);
  });

  it('does NOT fire on an unparseable lastDispatchAt (fail-closed — never alarm on a parse glitch)', () => {
    expect(
      buildDispatcherStalenessSignal({ armed: true, lastDispatchAt: 'not-a-date', eligible: [eligible({ id: 'EI-1' })], nowMs: NOW }),
    ).toEqual([]);
  });

  it('honors a custom threshold', () => {
    // 3h since last dispatch + 4h-old eligible work: stale under a 2h threshold, fine under the 6h default.
    const base = {
      armed: true as const,
      lastDispatchAt: hoursAgo(3),
      eligible: [eligible({ id: 'EI-1', ageMs: 4 * 3_600_000 })],
      nowMs: NOW,
    };
    expect(buildDispatcherStalenessSignal(base)).toEqual([]); // 6h default
    expect(buildDispatcherStalenessSignal({ ...base, thresholdMs: 2 * 3_600_000 })).toHaveLength(1);
  });

  it('omits the triaged-place clause when none of the eligible bugs are triaged place', () => {
    const signals = buildDispatcherStalenessSignal({
      armed: true,
      lastDispatchAt: hoursAgo(34),
      eligible: [eligible({ id: 'EI-1', triagedPlace: false })],
      nowMs: NOW,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0].body).not.toContain("triaged 'place'");
  });
});

// ── glue ─────────────────────────────────────────────────────────────────────

function dispatchRow(p: Partial<ImprovementDispatchRow> & { id: string; itemId: string }): ImprovementDispatchRow {
  return {
    workspaceId: 'ws',
    attempt: 1,
    runnerHarness: 'papercup',
    firedAt: hoursAgo(34),
    fireResult: 'ok',
    fireError: null,
    spawnedRunId: null,
    outcome: 'orphaned',
    resolvedAt: hoursAgo(33),
    resolvedBy: 'host-restart-recovery',
    ...p,
  };
}

/** A plain auto-tier (kind=bug, no protected surface), open, attempts:0, triaged-place candidate. */
function bug(p: Partial<ImprovementCandidate> & { id: string }): ImprovementCandidate {
  return {
    kind: 'bug',
    scope: 'operator',
    title: `plain bug ${p.id}`,
    state: 'open',
    createdAt: hoursAgo(20),
    ideaLifecycle: {
      state: 'triaged',
      stateUpdatedAt: hoursAgo(19),
      triageDecision: 'place',
    } as ImprovementCandidate['ideaLifecycle'],
    ...p,
  };
}

/** Armed deps with no env outage and the EI-2150 stall shape — overridable per test. */
function armedDeps(over: Partial<DispatcherStalenessDeps> = {}): Partial<DispatcherStalenessDeps> {
  return {
    flagEnabled: async () => true,
    runnerHarness: () => 'papercup',
    maxPerRun: () => 1,
    readDispatches: async () => [dispatchRow({ id: 'd1', itemId: 'EI-1405' })],
    readItems: async () => [bug({ id: 'EI-1' }), bug({ id: 'EI-2' })],
    ownerFullAutonomy: async () => false,
    ...over,
  };
}

describe('collectDispatcherStalenessSignals — the glue (EI-2150)', () => {
  it('FIRES the EI-2150 incident: armed lane, eligible attempts:0 bugs, lastDispatchAt 34h stale', async () => {
    const res = await collectDispatcherStalenessSignals('ws', { nowMs: NOW, deps: armedDeps() });
    expect(res.signals).toHaveLength(1);
    expect(res.signals[0].source).toBe('dispatcher-staleness');
    expect(res.signals[0].body).toContain('2 auto-eligible');
    expect(res.note).toBeUndefined();
  });

  it('skips (note) when the flag is OFF — without touching the ledger or items', async () => {
    const readDispatches = vi.fn(async () => [] as ImprovementDispatchRow[]);
    const readItems = vi.fn(async () => [] as ImprovementCandidate[]);
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      deps: armedDeps({ flagEnabled: async () => false, readDispatches, readItems }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/disarmed.*flag off/);
    expect(readDispatches).not.toHaveBeenCalled();
    expect(readItems).not.toHaveBeenCalled();
  });

  it('skips (note) when no runner harness is configured', async () => {
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      deps: armedDeps({ runnerHarness: () => null }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/runner unset/);
  });

  it('skips (note) when the per-run cap is 0 (deliberately paused)', async () => {
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      deps: armedDeps({ maxPerRun: () => 0 }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/cap 0/);
  });

  it('skips (note) when the dispatch ledger table is absent (migration 238 not applied)', async () => {
    const missing = Object.assign(new Error('relation "harness_shared.improvement_dispatches" does not exist'), {
      code: '42P01',
    });
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      deps: armedDeps({
        readDispatches: async () => {
          throw missing;
        },
      }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/ledger absent/);
  });

  it('suppresses (note) during a credential/env outage — the lane is legitimately paused', async () => {
    const envDeaths: ImprovementDispatchRow[] = [
      dispatchRow({ id: 'e1', itemId: 'EI-7', resolvedBy: 'worker-exit-backedge-env', resolvedAt: hoursAgo(1) }),
      dispatchRow({ id: 'e2', itemId: 'EI-8', resolvedBy: 'worker-exit-backedge-env', resolvedAt: hoursAgo(1) }),
    ];
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      deps: armedDeps({ readDispatches: async () => envDeaths }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/env outage/);
  });

  it('does NOT fire when the dispatcher fired recently (within the threshold)', async () => {
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      deps: armedDeps({ readDispatches: async () => [dispatchRow({ id: 'd1', itemId: 'EI-1405', firedAt: hoursAgo(1) })] }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/within the 6h staleness threshold/);
  });

  it('does NOT fire when every eligible bug already has a dispatch attempt (in-flight / exhausted)', async () => {
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      deps: armedDeps({ readItems: async () => [bug({ id: 'EI-1', attempts: 1 }), bug({ id: 'EI-2', attempts: 2 })] }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/0 eligible/);
  });

  it('does NOT fire when the only queued work is human-tier (kind=change), not auto-eligible', async () => {
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      deps: armedDeps({ readItems: async () => [{ ...bug({ id: 'EI-1' }), kind: 'change' }] }),
    });
    expect(res.signals).toEqual([]);
    expect(res.note).toMatch(/0 eligible/);
  });

  it('honors a custom dispatcherStalenessThresholdHours from the routine payload', async () => {
    // lastDispatchAt 3h ago, eligible work 4h old: silent under a 2h threshold, fine under 6h.
    const deps = armedDeps({
      readDispatches: async () => [dispatchRow({ id: 'd1', itemId: 'EI-1405', firedAt: hoursAgo(3) })],
      readItems: async () => [bug({ id: 'EI-1', createdAt: hoursAgo(4) })],
    });
    expect((await collectDispatcherStalenessSignals('ws', { nowMs: NOW, deps })).signals).toEqual([]);
    const res = await collectDispatcherStalenessSignals('ws', {
      nowMs: NOW,
      dispatcherStalenessThresholdHours: 2,
      deps,
    });
    expect(res.signals).toHaveLength(1);
  });
});
