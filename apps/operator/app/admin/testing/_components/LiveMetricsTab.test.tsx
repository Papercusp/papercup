// @vitest-environment jsdom
/**
 * LiveMetricsTab.test.tsx — the web-vitals live observer tab. Covers the two
 * exported pure helpers (filterAndSortEvents: kind + route filter, the three
 * sorts, the 50-row cap; countEventsByKind: zero-defaulted 5-kind tally) and the
 * component (subscribe wiring, count badges, empty vs grid, the kind filter, and
 * Clear).
 *
 * Seams: nuqs via NuqsTestingAdapter, RichGrid + Button + Select stubbed, the
 * vitals-recorder (subscribe/clearEvents/rateINP) stubbed — subscribe's callback
 * is captured so the test can push events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

let subCb: ((events: unknown[]) => void) | null = null;
const clearEventsMock = vi.fn();
vi.mock('../_lib/vitals-recorder', () => ({
  subscribe: (cb: (e: unknown[]) => void) => { subCb = cb; return () => {}; },
  clearEvents: () => clearEventsMock(),
  rateINP: () => 'good',
}));
vi.mock('@papercusp/grid-core', () => ({
  RichGrid: ({ rows, getRowId }: { rows: { id: string }[]; getRowId: (r: { id: string }) => string }) => (
    <div data-testid="grid">{rows.map((r) => <div key={getRowId(r)} data-testid={`row-${getRowId(r)}`} />)}</div>
  ),
}));
vi.mock('../../../harness/Button', () => ({ Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button> }));
vi.mock('../../../harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: {
    value: string; onChange: (v: string) => void; ariaLabel?: string; options: { value: string; label: string }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import LiveMetricsTab, { filterAndSortEvents, countEventsByKind } from './LiveMetricsTab';

interface PE { id: string; kind: string; route: string; duration: number; target: string; detail?: string; ts: number }
const ev = (over: Partial<PE> & { id: string }): PE => ({ kind: 'interaction', route: '/a', duration: 10, target: 'x', ts: 100, ...over });

describe('filterAndSortEvents', () => {
  const EVENTS: PE[] = [
    ev({ id: '1', kind: 'interaction', route: '/harness', duration: 50, ts: 300 }),
    ev({ id: '2', kind: 'longtask', route: '/adv', duration: 80, ts: 100 }),
    ev({ id: '3', kind: 'interaction', route: '/harness/x', duration: 20, ts: 200 }),
  ];
  const ids = (xs: PE[]) => xs.map((e) => e.id);

  it('filters by kind', () => {
    expect(ids(filterAndSortEvents(EVENTS, 'interaction', '', 'ts'))).toEqual(['1', '3']);
  });
  it('filters by route substring', () => {
    expect(ids(filterAndSortEvents(EVENTS, 'all', '/harness', 'ts'))).toEqual(['1', '3']);
  });
  it('sorts by duration desc, ts desc, and route asc', () => {
    expect(ids(filterAndSortEvents(EVENTS, 'all', '', 'duration'))).toEqual(['2', '1', '3']);
    expect(ids(filterAndSortEvents(EVENTS, 'all', '', 'ts'))).toEqual(['1', '3', '2']);
    expect(ids(filterAndSortEvents(EVENTS, 'all', '', 'route'))).toEqual(['2', '1', '3']);
  });
  it('caps the result at 50 rows', () => {
    const many = Array.from({ length: 60 }, (_, i) => ev({ id: String(i), duration: i }));
    expect(filterAndSortEvents(many, 'all', '', 'duration')).toHaveLength(50);
  });
});

describe('countEventsByKind', () => {
  it('zero-defaults all five kinds and tallies present ones', () => {
    const c = countEventsByKind([ev({ id: '1', kind: 'interaction' }), ev({ id: '2', kind: 'interaction' }), ev({ id: '3', kind: 'console-error' })]);
    expect(c).toEqual({ interaction: 2, longtask: 0, 'layout-shift': 0, 'console-error': 1, 'unhandled-error': 0 });
  });
});

describe('LiveMetricsTab component', () => {
  beforeEach(() => { subCb = null; clearEventsMock.mockReset(); });
  afterEach(cleanup);

  function renderTab(searchParams = '') {
    return render(<NuqsTestingAdapter searchParams={searchParams}><LiveMetricsTab /></NuqsTestingAdapter>);
  }

  it('renders the header and the empty state before any events arrive', () => {
    renderTab();
    expect(screen.getByText('Live metrics')).toBeTruthy();
    expect(screen.getByText(/No events yet/i)).toBeTruthy();
  });

  it('renders the grid + the N-of-M counter once events stream in', () => {
    renderTab();
    act(() => subCb!([
      ev({ id: 'a', kind: 'interaction', duration: 50 }),
      ev({ id: 'b', kind: 'longtask', duration: 80 }),
    ]));
    expect(screen.getByTestId('row-a')).toBeTruthy();
    expect(screen.getByTestId('row-b')).toBeTruthy();
    expect(screen.getByText('2 of 2 events')).toBeTruthy();
  });

  it('honors the kind filter from the URL', () => {
    renderTab('?kind=longtask');
    act(() => subCb!([ev({ id: 'a', kind: 'interaction' }), ev({ id: 'b', kind: 'longtask' })]));
    expect(screen.getByTestId('row-b')).toBeTruthy();
    expect(screen.queryByTestId('row-a')).toBeNull();
    expect(screen.getByText('1 of 2 events')).toBeTruthy();
  });

  it('calls clearEvents when Clear is clicked', () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clearEventsMock).toHaveBeenCalledTimes(1);
  });
});
