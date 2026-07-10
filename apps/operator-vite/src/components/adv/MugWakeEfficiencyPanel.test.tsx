// @vitest-environment jsdom
//
// MugWakeEfficiencyPanel render coverage (queen-brief-cache-assembly-2026-06-13
// B-06 / P-010, D-016/D-018): the Benchmark view's live-Queen per-wake efficiency.
// Mounts against a realistic `learning.mugWakeEfficiency` aggregate (useSyncQuery
// mocked — the pinned sibling pattern, see EkgPanel.test.tsx) and pins the headline
// stats (cache-hit ratio, cached wakes, turns/wake, cost), the rollup, the recent
// per-wake strip, the no-wakes empty state, and the defensive fallback. Guards
// against render-time crashes the build/typecheck can't catch.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

let qeffResult: Record<string, unknown> = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => qeffResult,
}));
// Lexicon resolver mocked to ECHO its key (t('brain') → 'brain') — isolates the
// Queen→Brain routed copy from the THE_HIVE flag hook (restore-pot-lexicon P-006).
vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import { MugWakeEfficiencyPanel } from './MugWakeEfficiencyPanel';

const snapshot = {
  wakes: 3,
  cachedWakes: 2,
  cacheHitRatio: 0.8,
  avgTurns: 4.5,
  totalInputTokens: 3000,
  totalCacheReadTokens: 80_000,
  totalCacheCreationTokens: 10_000,
  totalOutputTokens: 800,
  totalCostUsd: 0.32,
  totalTurns: 9,
  turnsReportedWakes: 2,
  samples: [
    { runId: 'w1', tsMs: 200, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 8000, cacheCreationTokens: 1000, costUsd: 0.12, turns: 3 },
    { runId: 'w2', tsMs: 100, inputTokens: 2000, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 5000, costUsd: 0.2, turns: null },
  ],
};

afterEach(() => {
  cleanup();
  qeffResult = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
});

describe('MugWakeEfficiencyPanel', () => {
  it('renders the headline stats, rollup, and the recent per-wake strip', () => {
    qeffResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<MugWakeEfficiencyPanel />);
    expect(screen.getByText('brain efficiency')).toBeTruthy();
    // Headline stats (each value is unique enough to assert directly).
    expect(screen.getByText('2/3')).toBeTruthy(); // cached wakes (P-003 "cache is real" signal)
    expect(screen.getByText('4.5')).toBeTruthy(); // avg turns/wake (Win-2)
    expect(screen.getByText('$0.32')).toBeTruthy(); // cost
    expect(screen.getAllByText('80%').length).toBeGreaterThanOrEqual(1); // cache hit (Win-1)
    // Rollup line.
    expect(screen.getByText(/3 wakes/)).toBeTruthy();
    expect(screen.getByText(/2 reported turns/)).toBeTruthy();
    // Recent strip: w1 reported 3 turns; w2 reported none ("—").
    expect(screen.getByText('3t')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('renders the no-wakes empty state when there are zero Queen wakes', () => {
    qeffResult = {
      data: [{ wakes: 0, cachedWakes: 0, cacheHitRatio: 0, avgTurns: null, totalInputTokens: 0, totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, totalTurns: 0, turnsReportedWakes: 0, samples: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<MugWakeEfficiencyPanel />);
    expect(screen.getByText(/No brain wakes recorded yet/)).toBeTruthy();
  });

  it('degrades to the empty state on a malformed snapshot (defensive shape guard)', () => {
    qeffResult = { data: [{ totally: 'unexpected' }], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<MugWakeEfficiencyPanel />);
    expect(screen.getByText(/No brain wakes recorded yet/)).toBeTruthy();
  });

  it('renders the empty state while loading with no data', () => {
    qeffResult = { data: undefined, loading: true, fetching: true, error: null, invalidate: vi.fn() };
    render(<MugWakeEfficiencyPanel />);
    expect(screen.getByText(/No brain wakes recorded yet/)).toBeTruthy();
  });
});
