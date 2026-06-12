// @vitest-environment jsdom
//
// DemandPanel render coverage (self-learning-frontier-2026-06-12 P-010 / FB-04):
// the Knowledge view's missing-knowledge demand map. Mounts against a realistic
// `learning.demand` snapshot (useSyncQuery mocked, the pinned sibling pattern —
// see LearningTab.test.tsx) and pins the populated list (surface chips, counts,
// filed marker), the rollup line, the empty state, and the defensive fallback
// when the snapshot has an unexpected shape.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let demandResult: Record<string, unknown> = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => demandResult,
}));

import { DemandPanel } from './DemandPanel';

const snapshot = {
  entries: [
    {
      surface: 'docs',
      queryNorm: 'tauri bridge port',
      exampleQuery: 'Tauri bridge port',
      missCount: 6,
      distinctAgents: 3,
      lastMissedAt: '2026-06-11T10:00:00.000Z',
      candidateImprovementId: 'EI-100',
    },
    {
      surface: 'memory',
      queryNorm: 'hetzner teardown recipe',
      exampleQuery: 'hetzner teardown recipe',
      missCount: 3,
      distinctAgents: 2,
      lastMissedAt: '2026-06-10T09:00:00.000Z',
      candidateImprovementId: null,
    },
  ],
  totalEntries: 2,
  totalMisses: 9,
  filedCount: 1,
  minedAt: '2026-06-12T06:00:00.000Z',
};

afterEach(() => {
  cleanup();
  demandResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
});

describe('DemandPanel', () => {
  it('renders the demand entries hottest-first with surface chips and the filed marker', () => {
    demandResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<DemandPanel />);
    expect(screen.getByText('Missing knowledge')).toBeTruthy();
    expect(screen.getByText('tauri bridge port')).toBeTruthy();
    expect(screen.getByText('hetzner teardown recipe')).toBeTruthy();
    expect(screen.getByText('docs')).toBeTruthy();
    expect(screen.getByText('memory')).toBeTruthy();
    expect(screen.getByText('6×')).toBeTruthy();
    expect(screen.getByText('3 agents')).toBeTruthy();
    // Exactly one filed chip (the docs entry).
    expect(screen.getAllByText('filed')).toHaveLength(1);
    // Rollup line.
    expect(screen.getByText(/2 missing-knowledge queries/)).toBeTruthy();
    expect(screen.getByText(/9 zero-hit searches/)).toBeTruthy();
  });

  it('renders the nothing-mined empty state on an empty map', () => {
    demandResult = {
      data: [{ entries: [], totalEntries: 0, totalMisses: 0, filedCount: 0, minedAt: null }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<DemandPanel />);
    expect(screen.getByText(/Nothing mined yet/)).toBeTruthy();
  });

  it('degrades to the empty state on a malformed snapshot (defensive shape guard)', () => {
    demandResult = { data: [{ totally: 'unexpected' }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<DemandPanel />);
    expect(screen.getByText(/Nothing mined yet/)).toBeTruthy();
  });

  it('renders the empty state while loading with no data', () => {
    demandResult = { data: undefined, loading: true, fetching: true, error: null, invalidate: vi.fn() };
    render(<DemandPanel />);
    expect(screen.getByText(/Nothing mined yet/)).toBeTruthy();
  });
});
