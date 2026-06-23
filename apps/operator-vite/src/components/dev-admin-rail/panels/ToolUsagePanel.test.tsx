// @vitest-environment jsdom
/**
 * ToolUsagePanel.test — the dev-admin-rail "Tool usage" glance (usage-insights-tab
 * P-003/P-004). The two sync queries (dev.telemetry, dev.toolFormatAdoption) are
 * mocked; nuqs runs via the real testing adapter so the URL-driven window + sub-view
 * selection is exercised end-to-end. Covers the three sub-views (hot sorted by token
 * cost, adoption compact-%, batching repeat-within-spawn filter + bulk hint), the
 * empty state, and clicking a view tab switching the rendered body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const H = vi.hoisted(() => ({
  results: {} as Record<
    string,
    { data: unknown[] | undefined; loading: boolean; fetching: boolean; error: Error | null; invalidate: ReturnType<typeof vi.fn> }
  >,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    H.results[queryName] ?? { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() },
}));

import ToolUsagePanel from './ToolUsagePanel';

function seed(queryName: string, over: Partial<(typeof H.results)[string]> = {}) {
  H.results[queryName] = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), ...over };
  return H.results[queryName];
}
const ENTRY = (over = {}) => ({
  tool_name: 't',
  call_count: 1,
  error_count: 0,
  p50_ms: 10,
  p95_ms: 20,
  total_bytes: 1000,
  avg_bytes: 1000,
  repeat_within_spawn: 0,
  ...over,
});

function renderPanel(search = '') {
  return render(<ToolUsagePanel active={true} />, {
    wrapper: ({ children }) => <NuqsTestingAdapter searchParams={search}>{children}</NuqsTestingAdapter>,
  });
}

beforeEach(() => {
  H.results = {};
});
afterEach(() => cleanup());

describe('<ToolUsagePanel>', () => {
  it('hot view (default): tools sorted by total_bytes desc, bytes formatted', () => {
    seed('dev.telemetry', {
      data: [ENTRY({ tool_name: 'small', total_bytes: 100 }), ENTRY({ tool_name: 'big', total_bytes: 5_000_000 })],
    });
    renderPanel();
    const rows = screen.getAllByTestId('tu-hot-row');
    expect(within(rows[0]).getByText('big')).toBeTruthy(); // biggest token cost first
    expect(within(rows[0]).getByText(/4\.8 MB/)).toBeTruthy();
  });

  it('empty state when the window has no invocations', () => {
    seed('dev.telemetry', { data: [] });
    renderPanel();
    expect(screen.getByText('No tool invocations in this window.')).toBeTruthy();
  });

  it('batching view: only repeat-within-spawn tools, with the bulk-conversion hint', () => {
    seed('dev.telemetry', {
      data: [ENTRY({ tool_name: 'noreps', repeat_within_spawn: 0 }), ENTRY({ tool_name: 'reps', repeat_within_spawn: 7 })],
    });
    renderPanel('?tuView=batching');
    const rows = screen.getAllByTestId('tu-batch-row');
    expect(rows.length).toBe(1);
    expect(within(rows[0]).getByText('reps')).toBeTruthy();
    expect(within(rows[0]).getByText(/convert to bulk items\[\]/)).toBeTruthy();
  });

  it('adoption view: computes the compact-% from the format mix (D-002)', () => {
    seed('dev.telemetry', { data: [ENTRY()] });
    seed('dev.toolFormatAdoption', {
      data: [
        { format: 'toon', n: 75 },
        { format: 'json', n: 25 },
      ],
    });
    renderPanel('?tuView=adoption');
    expect(screen.getByText(/75% — 75\/100 mcp calls served compact/)).toBeTruthy();
  });

  it('clicking a view tab switches the rendered body', () => {
    seed('dev.telemetry', { data: [ENTRY({ tool_name: 'reps', repeat_within_spawn: 3 })] });
    renderPanel(); // default = hot
    expect(screen.getAllByTestId('tu-hot-row').length).toBe(1);
    fireEvent.click(screen.getByTestId('tu-view-batching'));
    expect(screen.getAllByTestId('tu-batch-row').length).toBe(1);
    expect(screen.queryByTestId('tu-hot-row')).toBeNull();
  });
});
