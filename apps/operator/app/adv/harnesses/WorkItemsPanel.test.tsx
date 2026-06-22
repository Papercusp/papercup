// @vitest-environment jsdom
/**
 * WorkItemsPanel.test.tsx — the unified /adv work-items table panel. Covers the
 * no-slug guard, the loading / error / empty / populated render branches, the
 * panel-title effect, the global quick-search (`wq`) substring filter (incl. the
 * "matches nothing" message), the refresh invalidate, and row-click → `?sel`.
 *
 * Seams (the app/operator RTL recipe — see agent-insights/component-rtl-testing):
 * @papercusp/sync useSyncQuery (per-queryName), @papercusp/grid-core RichGrid +
 * usePersistedColumnWidths, the column-filter hook/bar, Tooltip, the pills + the
 * trust badge — all stubbed. nuqs via NuqsTestingAdapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';

interface SyncState { loading?: boolean; fetching?: boolean; data?: unknown; error?: { message: string } | null }
let wiState: SyncState;
const invalidateMock = vi.fn();
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) => {
    if (queryName === 'trust.list') return { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    return { ...wiState, invalidate: invalidateMock };
  },
}));
vi.mock('@papercusp/grid-core', () => ({
  // The panel renders virtualized (`virtualMode`, no `rows`); the mock resolves
  // rows from whichever prop is present so the assertions are unchanged.
  RichGrid: ({ rows, virtualMode, onRowClick }: {
    rows?: { id: string }[];
    virtualMode?: { totalRows: number; rowAt: (i: number) => { id: string } };
    onRowClick?: (r: { id: string }) => void;
  }) => {
    const data = rows ?? (virtualMode ? Array.from({ length: virtualMode.totalRows }, (_, i) => virtualMode.rowAt(i)) : []);
    return (
      <div data-testid="grid">
        {data.map((r) => (
          <button key={r.id} data-testid={`row-${r.id}`} onClick={() => onRowClick?.(r)}>{r.id}</button>
        ))}
      </div>
    );
  },
  usePersistedColumnWidths: () => [{}, vi.fn()],
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({ measure: vi.fn(), getVirtualItems: () => [], getTotalSize: () => 0 }),
}));
vi.mock('../../harness/filters', () => ({
  useColumnFilters: (_cols: unknown, rows: unknown[]) => ({
    rows, controller: {}, activeChips: [], hasActive: false, clearAll: vi.fn(),
  }),
  ColumnFilterBar: () => <div data-testid="filter-bar" />,
}));
vi.mock('../../harness/Tooltip', () => ({ Tooltip: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../../harness/primitives', () => ({
  IssueStatusPill: () => <span />, KindPill: () => <span />, SeverityPill: () => <span />, StatusPill: () => <span />,
}));
vi.mock('../../harness/TrustBadge', () => ({ TrustBadge: () => <span />, trustBadgeState: () => null }));

import WorkItemsPanel from './WorkItemsPanel';
import type { WorkItemRow } from './WorkItemsPanel';

function row(over: Partial<WorkItemRow> & { id: string }): WorkItemRow {
  return {
    kind: 'bug', family: 'issue', title: 'x', summary: null, state: 'open', assignee: null,
    assignedBy: null, severity: null, priority: null, rank: null, planSlug: null, spineRole: null,
    spineStatus: null, updatedAt: '', origin: null, auditVerdict: null, verifiedAuthorGithubUserId: null,
    ...over,
  };
}
const ROWS: WorkItemRow[] = [
  row({ id: 'WI-1', title: 'Login crash', state: 'open', assignee: 'ada' }),
  row({ id: 'F-2', kind: 'feature', family: 'feature', title: 'Dark mode', state: 'in_progress', planSlug: 'plan-x' }),
];

const setTitle = vi.fn();
function renderPanel(slug = 'alpha', searchParams = '', onUrlUpdate?: (e: unknown) => void) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <WorkItemsPanel params={{ harnessSlug: slug }} api={{ setTitle } as never} />
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => { wiState = { loading: false, fetching: false, data: ROWS, error: null }; setTitle.mockReset(); invalidateMock.mockReset(); });
afterEach(cleanup);

describe('WorkItemsPanel', () => {
  it('shows the pick-a-harness empty state when no slug is set', () => {
    renderPanel('');
    expect(screen.getByText(/Pick a harness to view its work items/i)).toBeTruthy();
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('shows the loading state while the query is loading', () => {
    wiState = { loading: true, fetching: true, data: null, error: null };
    renderPanel();
    expect(screen.getByText(/Loading work items/i)).toBeTruthy();
  });

  it('shows an error state when the query errors', () => {
    wiState = { loading: false, fetching: false, data: null, error: { message: 'boom' } };
    renderPanel();
    expect(screen.getByText(/Could not load work items: boom/i)).toBeTruthy();
  });

  it('shows the no-items message when the harness has none', () => {
    wiState = { loading: false, fetching: false, data: [], error: null };
    renderPanel();
    expect(screen.getByText(/No work items for this harness/i)).toBeTruthy();
  });

  it('renders the grid and sets the panel title from the row count', () => {
    renderPanel();
    expect(screen.getByTestId('grid')).toBeTruthy();
    expect(screen.getByTestId('row-WI-1')).toBeTruthy();
    expect(screen.getByTestId('row-F-2')).toBeTruthy();
    expect(setTitle).toHaveBeenCalledWith('Work items · alpha (2)');
  });

  it('shows "N of TOTAL" when the read was capped (true total on row[0]._meta)', () => {
    // Resolver stashes the true store total on the first row; the read returned
    // 2 rows but 57 exist → the title must report both, never the downloaded 2.
    wiState = {
      loading: false, fetching: false, error: null,
      data: [{ ...ROWS[0], _meta: { total: 57 } }, ROWS[1]],
    };
    renderPanel();
    expect(setTitle).toHaveBeenCalledWith('Work items · alpha (2 of 57)');
  });

  it('applies the quick-search substring filter (wq)', () => {
    renderPanel('alpha', '?wq=login');
    expect(screen.getByTestId('row-WI-1')).toBeTruthy();
    expect(screen.queryByTestId('row-F-2')).toBeNull();
  });

  it('shows the no-match message when the filter excludes everything', () => {
    renderPanel('alpha', '?wq=zzzznope');
    expect(screen.getByText(/No work items match the filter/i)).toBeTruthy();
  });

  it('invokes the query invalidate on the refresh button', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh work items' }));
    expect(invalidateMock).toHaveBeenCalledTimes(1);
  });

  it('writes the clicked row id into ?sel', async () => {
    const onUrlUpdate = vi.fn();
    renderPanel('alpha', '', onUrlUpdate);
    fireEvent.click(screen.getByTestId('row-WI-1'));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const ev = onUrlUpdate.mock.calls.at(-1)![0] as { searchParams: URLSearchParams };
    expect(ev.searchParams.get('sel')).toBe('WI-1');
  });
});
