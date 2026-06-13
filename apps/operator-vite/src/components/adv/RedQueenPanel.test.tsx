// @vitest-environment jsdom
//
// RedQueenPanel render coverage (self-learning-frontier-2026-06-12 P-031 / FB-20):
// the Benchmark view's MTTSH vital sign. Mounts against a realistic
// `learning.redQueen` snapshot (useSyncQuery mocked, the pinned sibling pattern
// — see EkgPanel.test.tsx / DemandPanel.test.tsx) and pins the populated class
// list (per-segment medians, triage accuracy, the per-class LEAK chip), the
// rollup line, the loud leak-failure alarm, the dark/no-drills empty state, and
// the defensive fallback on a malformed snapshot.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let rqResult: Record<string, unknown> = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => rqResult,
}));

import { RedQueenPanel } from './RedQueenPanel';

// Mirrors MttshVitals (red-queen/mttsh.ts) — a healed smoke-fail class plus a
// routine-engine-death class carrying a leak-check failure (the standing alarm).
const snapshot = {
  classes: [
    {
      drillClass: 'smoke-fail',
      collectorFamily: 'smoke',
      runs: 4,
      resolved: 3,
      detectMs: 49,
      triageMs: 16,
      fixMs: 43,
      totalMs: 108,
      triageMatches: 3,
      triageJudged: 3,
      leakFailures: 0,
      lastRunAt: '2026-06-12T15:00:00.000Z',
      lastStatus: 'resolved',
    },
    {
      drillClass: 'routine-engine-death',
      collectorFamily: 'out-of-band',
      runs: 2,
      resolved: 1,
      detectMs: 26,
      triageMs: 9,
      fixMs: 34,
      totalMs: 69,
      triageMatches: 0,
      triageJudged: 0,
      leakFailures: 1,
      lastRunAt: '2026-06-12T15:05:00.000Z',
      lastStatus: 'failed',
    },
  ],
  totalRuns: 6,
  totalResolved: 4,
  medianTotalMs: 108,
  leakFailures: 1,
  lastRunAt: '2026-06-12T15:05:00.000Z',
};

afterEach(() => {
  cleanup();
  rqResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
});

describe('RedQueenPanel', () => {
  it('renders drill classes with segments, triage accuracy, the leak chip and the rollup', () => {
    rqResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<RedQueenPanel />);
    expect(screen.getByText('MTTSH')).toBeTruthy();
    expect(screen.getByText('smoke-fail')).toBeTruthy();
    expect(screen.getByText('routine-engine-death')).toBeTruthy();
    // The healed class pins triage accuracy against the planted expectation.
    expect(screen.getByText('triage 3/3')).toBeTruthy();
    // The class with a failed leak check carries the standing per-class alarm.
    expect(screen.getByText('LEAK ×1')).toBeTruthy();
    // Rollup line (text is split across spans — match the rollup <p> directly).
    expect(
      screen.getByText(
        (_content, el) => el?.className === 'pc-rq__rollup' && /4\/6 drills healed/.test(el?.textContent ?? ''),
      ),
    ).toBeTruthy();
    // A non-zero leak count surfaces the loud rollup alarm, not "zero leaks".
    expect(screen.getByText(/1 LEAK CHECK FAILURE/)).toBeTruthy();
  });

  it('shows "zero leaks" in the rollup when no leak check failed', () => {
    rqResult = {
      data: [{ ...snapshot, classes: [snapshot.classes[0]], totalRuns: 4, totalResolved: 3, leakFailures: 0 }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<RedQueenPanel />);
    expect(
      screen.getByText((_content, el) => el?.className === 'pc-rq__rollup' && /zero leaks/.test(el?.textContent ?? '')),
    ).toBeTruthy();
  });

  it('renders the dark / no-drills empty state on an empty store', () => {
    rqResult = {
      data: [{ classes: [], totalRuns: 0, totalResolved: 0, medianTotalMs: null, leakFailures: 0, lastRunAt: null }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<RedQueenPanel />);
    expect(screen.getByText(/No drills run yet/)).toBeTruthy();
  });

  it('degrades to the empty state on a malformed snapshot (defensive shape guard)', () => {
    rqResult = { data: [{ totally: 'unexpected' }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<RedQueenPanel />);
    expect(screen.getByText(/No drills run yet/)).toBeTruthy();
  });

  it('renders the empty state while loading with no data', () => {
    rqResult = { data: undefined, loading: true, fetching: true, error: null, invalidate: vi.fn() };
    render(<RedQueenPanel />);
    expect(screen.getByText(/No drills run yet/)).toBeTruthy();
  });
});
