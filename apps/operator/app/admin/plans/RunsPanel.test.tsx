// @vitest-environment jsdom
/**
 * RunsPanel.test.tsx — render-tier coverage for the per-plan Runs tab
 * (whole-app-test-coverage-breadth-2026-06-14, P-016). Exercises every render
 * branch — empty state, rollup header stats, the regression banner, the
 * result_summary domain-metric series, and the run grid — by mocking the
 * `plans.runHistory` sync query. RichGrid + RunDetailPanel are stubbed (heavy
 * virtualized grid / ?run=-gated child) so this asserts RunsPanel's own logic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[]; loading: boolean };
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncResult, error: null, fetching: false, invalidate: vi.fn() }),
}));
// RichGrid is a heavy virtualized grid; stub it to a simple list so we can
// assert the rows RunsPanel feeds it without canvas/virtualization in jsdom.
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, getRowId }: { rows: { outcome: string | null; status: string }[]; getRowId: (r: unknown) => string }) => (
    <div data-testid="grid">
      {rows.map((r) => (
        <div key={getRowId(r)}>{r.outcome ?? r.status}</div>
      ))}
    </div>
  ),
}));
// Self-gates on ?run=; not under test here.
vi.mock('./RunDetailPanel', () => ({ default: () => null }));

import RunsPanel from './RunsPanel';

function renderPanel(ui: ReactElement, searchParams = ''): ReturnType<typeof render> {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

function mkRun(over: Record<string, unknown> = {}) {
  return {
    id: 1, runSeq: 1, status: 'done', runType: 'scheduled', trigger: 'cron',
    outcome: 'success', durationMs: 1500, launchedAt: 1_700_000_000_000, costUsd: 0.5,
    workItems: { total: 2, passed: 2, failed: 0, open: 0 }, resultSummary: null,
    ...over,
  };
}
function mkRollup(over: Record<string, unknown> = {}) {
  return {
    total: 3, success: 2, partial: 0, failed: 1, running: 0, successRate: 0.667,
    avgDurationMs: 1500, medianDurationMs: 1500, totalCostUsd: 1.25, lastOutcome: 'failed',
    regression: { lastFailed: true, slowRunIds: [2] },
    ...over,
  };
}

beforeEach(() => { syncResult = { data: [], loading: false }; });
afterEach(cleanup);

describe('RunsPanel (scheduled-recurring-plans Runs tab)', () => {
  it('shows the empty state (with the plan title) when there are no runs', () => {
    syncResult = { data: [{ runs: [], rollup: null }], loading: false };
    renderPanel(<RunsPanel slug="my-plan" planTitle="My Plan" />);
    expect(screen.getByText(/No runs yet/i)).toBeTruthy();
    expect(screen.getByText('My Plan')).toBeTruthy();
  });

  it('falls back to the slug in the empty state when no planTitle is given', () => {
    syncResult = { data: [{ runs: [], rollup: null }], loading: false };
    renderPanel(<RunsPanel slug="bare-slug" />);
    expect(screen.getByText('bare-slug')).toBeTruthy();
  });

  it('renders the rollup header stats (success rate, median, total cost)', () => {
    syncResult = { data: [{ runs: [mkRun()], rollup: mkRollup({ regression: { lastFailed: false, slowRunIds: [] } }) }], loading: false };
    renderPanel(<RunsPanel slug="p" />);
    expect(screen.getByText('Success rate')).toBeTruthy();
    expect(screen.getByText('67%')).toBeTruthy(); // Math.round(0.667 * 100)
    expect(screen.getByText('Median duration')).toBeTruthy();
    expect(screen.getByText('$1.25')).toBeTruthy();
  });

  it('shows the regression banner when the most recent run failed', () => {
    syncResult = { data: [{ runs: [mkRun()], rollup: mkRollup() }], loading: false };
    renderPanel(<RunsPanel slug="p" />);
    expect(screen.getByText(/most recent run failed/i)).toBeTruthy();
  });

  it('does NOT show the regression banner when lastFailed is false', () => {
    syncResult = { data: [{ runs: [mkRun()], rollup: mkRollup({ regression: { lastFailed: false, slowRunIds: [] } }) }], loading: false };
    renderPanel(<RunsPanel slug="p" />);
    expect(screen.queryByText(/most recent run failed/i)).toBeNull();
  });

  it('renders a domain-metric series from numeric result_summary keys', () => {
    syncResult = {
      data: [{ runs: [mkRun({ resultSummary: { passRate: 0.9 } })], rollup: mkRollup({ regression: { lastFailed: false, slowRunIds: [] } }) }],
      loading: false,
    };
    renderPanel(<RunsPanel slug="p" />);
    expect(screen.getByText('Domain metrics (result_summary)')).toBeTruthy();
    expect(screen.getByText('passRate')).toBeTruthy();
  });

  it('feeds the run rows into the grid', () => {
    syncResult = { data: [{ runs: [mkRun({ id: 7, outcome: 'success' })], rollup: null }], loading: false };
    renderPanel(<RunsPanel slug="p" />);
    expect(screen.getByTestId('grid')).toBeTruthy();
    expect(screen.getByText('success')).toBeTruthy();
  });
});
