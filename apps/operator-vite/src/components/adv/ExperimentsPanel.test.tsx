// @vitest-environment jsdom
//
// ExperimentsPanel render coverage (experiment-registry-invocation-api P-051): the
// Benchmark view's experiment scoreboard. Mounts against a realistic
// `learning.experiments` row set (useSyncQuery mocked, the pinned sibling pattern —
// see DemandPanel.test.tsx) and pins the populated list (test/tier, arm scores, the
// winner highlight, decision), the nothing-run empty state, and the defensive
// fallback when a row has an unexpected shape.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let result: Record<string, unknown> = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => result,
}));

import { ExperimentsPanel } from './ExperimentsPanel';

const runs = [
  {
    batteryId: 'try-terser-worker',
    testId: 'replay',
    tier: 'offline',
    winner: 'terser',
    arms: [
      { id: 'baseline', label: 'historical baseline', meanScore: 6.1, cells: 1, scored: 1, costUsd: 0 },
      { id: 'terser', label: 'terser worker', meanScore: 7.4, cells: 1, scored: 1, costUsd: 0.01 },
    ],
    totalCostUsd: 0.012,
    budgetExhausted: false,
    decision: 'proposed',
    createdAt: '2026-06-14T06:00:00.000Z',
  },
];

afterEach(() => {
  cleanup();
  result = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
});

describe('ExperimentsPanel', () => {
  it('renders a run with its arms, the winner highlight, cost, and decision', () => {
    result = { data: runs, loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<ExperimentsPanel />);
    expect(screen.getByText('Experiments')).toBeTruthy();
    expect(screen.getByText('replay')).toBeTruthy();
    expect(screen.getByText('offline')).toBeTruthy();
    expect(screen.getByText('baseline 6.1')).toBeTruthy();
    expect(screen.getByText('terser 7.4')).toBeTruthy();
    expect(screen.getByText('▲ terser')).toBeTruthy();
    expect(screen.getByText('$0.012')).toBeTruthy();
    expect(screen.getByText('proposed')).toBeTruthy();
  });

  it('renders the nothing-run empty state on an empty ledger', () => {
    result = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<ExperimentsPanel />);
    expect(screen.getByText(/No experiments run yet/)).toBeTruthy();
  });

  it('degrades to the empty state on a malformed row set (defensive guard)', () => {
    result = { data: [{ totally: 'unexpected' }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<ExperimentsPanel />);
    expect(screen.getByText(/No experiments run yet/)).toBeTruthy();
  });

  it('renders the empty state while loading with no data', () => {
    result = { data: undefined, loading: true, fetching: true, error: null, invalidate: vi.fn() };
    render(<ExperimentsPanel />);
    expect(screen.getByText(/No experiments run yet/)).toBeTruthy();
  });
});
