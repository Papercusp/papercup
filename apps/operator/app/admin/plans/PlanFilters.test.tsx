// @vitest-environment jsdom
/**
 * PlanFilters.test.tsx — the PlanRail filter controls (all nuqs-backed) + the
 * exported withinDateWindow predicate. Covers the search wiring, the owner /
 * initiative dropdowns gated on the plan list, the viewer-email-gated owner-view
 * toggle, the active-count + token chips, a quick toggle write, Clear-all, and
 * the date-window predicate's buckets/guards.
 *
 * Seams: nuqs via NuqsTestingAdapter, plans-api (usePlanViewerEmail),
 * plan-filtering / plan-sorting constants, Select stubbed to a native select.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactNode } from 'react';

let viewerEmail: string | null;
vi.mock('./plans-api', () => ({ usePlanViewerEmail: () => viewerEmail }));
vi.mock('./plan-filtering', () => ({ OWNER_VIEWS: ['all', 'mine', 'others'] }));
vi.mock('./plan-sorting', () => ({
  PLAN_SORTS: [{ id: 'default', label: 'Default' }, { id: 'recent', label: 'Recent' }],
  PLAN_SORT_IDS: ['default', 'recent'],
  planSortLabel: (s: string) => (s === 'recent' ? 'Recent' : 'Default'),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel }: {
    value: string; onChange: (v: string) => void; ariaLabel?: string;
    options: { value: string; label: ReactNode }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o, i) => <option key={o.value ?? i} value={o.value}>{typeof o.label === 'string' ? o.label : o.value}</option>)}
    </select>
  ),
}));

import PlanFilters, { withinDateWindow } from './PlanFilters';

interface Plan { owner?: string | null; initiative?: string | null; updated?: string | null }
const onQueryChange = vi.fn();
function renderFilters(opts: { plans?: Plan[]; searchParams?: string; query?: string; onUrlUpdate?: (e: unknown) => void } = {}) {
  const { plans = [], searchParams = '', query = '', onUrlUpdate } = opts;
  return render(
    <NuqsTestingAdapter searchParams={searchParams} onUrlUpdate={onUrlUpdate}>
      <PlanFilters
        list={{ data: { plans } } as never}
        query={query}
        onQueryChange={onQueryChange}
        searchRef={{ current: null }}
      />
    </NuqsTestingAdapter>,
  );
}

beforeEach(() => { viewerEmail = null; onQueryChange.mockReset(); });
afterEach(cleanup);

describe('PlanFilters component', () => {
  it('wires the search box to onQueryChange (empty → null)', () => {
    renderFilters({ query: 'seed' });
    fireEvent.change(screen.getByLabelText('Search plans'), { target: { value: 'auth' } });
    expect(onQueryChange).toHaveBeenCalledWith('auth');
    fireEvent.change(screen.getByLabelText('Search plans'), { target: { value: '' } });
    expect(onQueryChange).toHaveBeenLastCalledWith(null);
  });

  it('shows the owner dropdown only when more than one owner exists', () => {
    renderFilters({ plans: [{ owner: 'ada' }, { owner: 'bob' }] });
    expect(screen.getByLabelText('Plan owner filter')).toBeTruthy();
    cleanup();
    renderFilters({ plans: [{ owner: 'ada' }] });
    expect(screen.queryByLabelText('Plan owner filter')).toBeNull();
  });

  it('shows the initiative dropdown when initiatives exist', () => {
    renderFilters({ plans: [{ owner: 'ada', initiative: 'Platform' }] });
    expect(screen.getByLabelText('Plan initiative filter')).toBeTruthy();
  });

  it('always renders the sort dropdown', () => {
    renderFilters();
    expect(screen.getByLabelText('Plan sort order')).toBeTruthy();
  });

  it('gates the owner-view toggle on a resolvable viewer email', () => {
    renderFilters();
    expect(screen.queryByRole('group', { name: 'Plan owner view' })).toBeNull();
    cleanup();
    viewerEmail = 'me@x.test';
    renderFilters();
    expect(screen.getByRole('group', { name: 'Plan owner view' })).toBeTruthy();
  });

  it('shows the active count + token chips for active filters', () => {
    renderFilters({ searchParams: '?pInbox=true&pScout=true' });
    expect(screen.getByText('2 active')).toBeTruthy();
    expect(screen.getByText('has needs-human')).toBeTruthy();
    expect(screen.getByText('scout-created')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
  });

  it('writes a quick toggle into the URL', async () => {
    const onUrlUpdate = vi.fn();
    renderFilters({ onUrlUpdate });
    fireEvent.click(screen.getByRole('button', { name: 'needs human' }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const ev = onUrlUpdate.mock.calls.at(-1)![0] as { searchParams: URLSearchParams };
    expect(ev.searchParams.get('pInbox')).toBe('true');
  });

  it('clears a single filter via its token chip', async () => {
    const onUrlUpdate = vi.fn();
    renderFilters({ searchParams: '?pScout=true', onUrlUpdate });
    fireEvent.click(screen.getByRole('button', { name: 'Clear scout-created filter' }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const ev = onUrlUpdate.mock.calls.at(-1)![0] as { searchParams: URLSearchParams };
    expect(ev.searchParams.get('pScout')).toBeNull();
  });

  it('clears every filter via Clear', async () => {
    const onUrlUpdate = vi.fn();
    renderFilters({ searchParams: '?pInbox=true&pScout=true', onUrlUpdate });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
    const ev = onUrlUpdate.mock.calls.at(-1)![0] as { searchParams: URLSearchParams };
    expect(ev.searchParams.get('pInbox')).toBeNull();
    expect(ev.searchParams.get('pScout')).toBeNull();
  });
});

describe('withinDateWindow', () => {
  const NOW = 1_700_000_000_000;
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(NOW); });
  afterEach(() => vi.restoreAllMocks());
  const iso = (ageMs: number) => new Date(NOW - ageMs).toISOString();
  const DAY = 86_400_000;

  it('passes everything when no window is set', () => {
    expect(withinDateWindow(null, null)).toBe(true);
    expect(withinDateWindow(iso(DAY * 99), null)).toBe(true);
  });
  it('rejects a missing or unparseable updated timestamp', () => {
    expect(withinDateWindow(null, 'today')).toBe(false);
    expect(withinDateWindow('not-a-date', '7d')).toBe(false);
  });
  it('applies the today / 7d / 30d buckets', () => {
    expect(withinDateWindow(iso(DAY / 2), 'today')).toBe(true);
    expect(withinDateWindow(iso(DAY * 2), 'today')).toBe(false);
    expect(withinDateWindow(iso(DAY * 3), '7d')).toBe(true);
    expect(withinDateWindow(iso(DAY * 8), '7d')).toBe(false);
    expect(withinDateWindow(iso(DAY * 20), '30d')).toBe(true);
    expect(withinDateWindow(iso(DAY * 40), '30d')).toBe(false);
  });
});
