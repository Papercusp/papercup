// @vitest-environment jsdom
/**
 * DesktopPerfTrendPanel.test.tsx — the P-010 trend surface. Covers the exported
 * pure formatters (formatMeasureValue, formatDelta, isRegression) and the
 * component: loading → run strip + latest-measure table, the empty state, and a
 * fetch error. fetch is stubbed per test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../../harness/Button', () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: (e: unknown) => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

import DesktopPerfTrendPanel, { formatMeasureValue, formatDelta, isRegression } from './DesktopPerfTrendPanel';
import type { DesktopPerfMeasureDelta, DesktopPerfTrendPoint } from '@papercusp/operator-core/lib/admin-test-suites-shared';

function delta(over: Partial<DesktopPerfMeasureDelta> & { key: string }): DesktopPerfMeasureDelta {
  return { value: 100, unit: 'ms', budget: 1500, ok: true, prevValue: null, deltaValue: null, deltaPct: null, ...over };
}

function stubTrend(trend: DesktopPerfTrendPoint[]) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ trend }), text: async () => '' } as Response)));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('pure formatters', () => {
  it('formatMeasureValue formats by unit', () => {
    expect(formatMeasureValue(1234, 'ms')).toBe('1234ms');
    expect(formatMeasureValue(2_097_152, 'kb')).toBe('2048MB');
    expect(formatMeasureValue(7, 'count')).toBe('7');
  });

  it('formatDelta shows direction, magnitude, and percent', () => {
    expect(formatDelta(delta({ key: 'a', deltaValue: null }))).toBe('—');
    expect(formatDelta(delta({ key: 'a', deltaValue: 0, prevValue: 100 }))).toBe('±0');
    expect(formatDelta(delta({ key: 'a', value: 1200, prevValue: 1000, deltaValue: 200, deltaPct: 0.2 }))).toBe('▲ 200ms (+20%)');
    expect(formatDelta(delta({ key: 'a', value: 800, prevValue: 1000, deltaValue: -200, deltaPct: -0.2 }))).toBe('▼ 200ms (−20%)');
  });

  it('isRegression only flags a budgeted measure that got slower/larger', () => {
    expect(isRegression(delta({ key: 'a', deltaValue: 200, budget: 1500 }))).toBe(true);
    expect(isRegression(delta({ key: 'a', deltaValue: -200, budget: 1500 }))).toBe(false);
    expect(isRegression(delta({ key: 'a', deltaValue: 200, budget: null }))).toBe(false);
    expect(isRegression(delta({ key: 'a', deltaValue: null, budget: 1500 }))).toBe(false);
  });
});

describe('DesktopPerfTrendPanel component', () => {
  it('renders the run strip + latest-run measures with deltas', async () => {
    stubTrend([
      {
        id: 'r2', createdTs: 1_700_000_000_000, source: 'admin-suite', status: 'fail', gitSha: 'deadbeefcafe', runId: 'testrun-2',
        measures: [
          delta({ key: 'route:harness-warm', value: 1200, budget: 1500, ok: true, prevValue: 1000, deltaValue: 200, deltaPct: 0.2 }),
          delta({ key: 'interaction:plan-popup-open', value: 1800, budget: 1500, ok: false, prevValue: 1400, deltaValue: 400, deltaPct: 0.286 }),
        ],
      },
      { id: 'r1', createdTs: 1_699_999_000_000, source: 'admin-suite', status: 'pass', gitSha: null, runId: 'testrun-1', measures: [] },
    ]);
    render(<DesktopPerfTrendPanel />);
    await waitFor(() => expect(screen.getByTestId('perf-measure-route:harness-warm')).toBeTruthy());
    // both runs appear in the strip (2 status chips)
    expect(screen.getAllByText(/pass|fail/).length).toBeGreaterThanOrEqual(2);
    // latest run's measures render with their values + a regression row
    expect(screen.getByTestId('perf-measure-interaction:plan-popup-open').className).toContain('is-regression');
    expect(screen.getByText('▲ 400ms (+29%)')).toBeTruthy();
  });

  it('shows the empty state when no runs are recorded', async () => {
    stubTrend([]);
    render(<DesktopPerfTrendPanel />);
    await waitFor(() => expect(screen.getByText(/No desktop-performance runs recorded yet/)).toBeTruthy());
  });

  it('surfaces a fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'kaboom' } as Response)));
    render(<DesktopPerfTrendPanel />);
    await waitFor(() => expect(screen.getByText(/Error: kaboom/)).toBeTruthy());
  });
});
