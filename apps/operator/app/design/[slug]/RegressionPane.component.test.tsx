// @vitest-environment jsdom
/**
 * RegressionPane — the Lost Pixel visual-regression browser on the design tab
 * (plan §12). The load-bearing logic is the derivation pipeline: filter mode
 * (all / regressions / clean, a nuqs param) → regressions-first sort →
 * alphabetical within each group. None of it was covered. Pins:
 *   - regressions sort above clean items; alphabetical inside each group
 *   - the three filter modes select the right subsets
 *   - `?regressionFilter=` seeds the filter (nuqs deep-link contract)
 *   - fetch failure and empty states render without crashing
 *
 * Seam: @papercusp/sync `designRegressions.list`. Rendered under
 * withNuqsTestingAdapter so the URL-driven filter contract is exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import RegressionPane from './RegressionPane';

interface ItemOver {
  hasRegression?: boolean;
  hasBaseline?: boolean;
  hasCurrent?: boolean;
  hasDiff?: boolean;
}

function item(name: string, over: ItemOver = {}) {
  return {
    name,
    hasBaseline: true,
    hasCurrent: true,
    hasDiff: false,
    hasRegression: false,
    baselineMtime: 1_700_000_000_000,
    currentMtime: 1_700_000_000_000,
    diffMtime: null,
    ...over,
  };
}

const { syncState } = vi.hoisted(() => ({
  syncState: {
    data: [] as unknown[],
    loading: false,
    error: null as Error | null,
  },
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: syncState.data,
    loading: syncState.loading,
    fetching: false,
    error: syncState.error,
    transport: 'SSE',
    invalidate: vi.fn(),
  }),
}));

const payload = (items: ReturnType<typeof item>[]) => ({
  counts: {
    baseline: items.length,
    current: items.length,
    diff: items.filter((i) => i.hasDiff).length,
    regressions: items.filter((i) => i.hasRegression).length,
  },
  items,
});

function mount(searchParams = '') {
  return render(<RegressionPane />, { wrapper: withNuqsTestingAdapter({ searchParams }) });
}

beforeEach(() => {
  syncState.data = [payload([])];
  syncState.loading = false;
  syncState.error = null;
});

afterEach(() => {
  cleanup();
});

/** Names in on-screen order, scoped to rendered item rows by their text. */
const orderOf = (names: string[]): string[] => {
  const all = names
    .map((n) => screen.queryByText(n))
    .filter((el): el is HTMLElement => el !== null);
  return all
    .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .map((el) => el.textContent ?? '');
};

describe('RegressionPane derivation', () => {
  it('sorts regressions above clean items, alphabetical within each group', async () => {
    syncState.data = [payload([
      item('zeta-clean'),
      item('beta-regressed', { hasDiff: true, hasRegression: true }),
      item('alpha-clean'),
      item('delta-regressed', { hasDiff: true, hasRegression: true }),
    ])];
    mount();
    await waitFor(() => expect(screen.getByText('alpha-clean')).toBeTruthy());
    expect(orderOf(['zeta-clean', 'beta-regressed', 'alpha-clean', 'delta-regressed'])).toEqual([
      'beta-regressed',
      'delta-regressed',
      'alpha-clean',
      'zeta-clean',
    ]);
  });

  it('filter=regressions keeps only flagged items', async () => {
    syncState.data = [payload([
      item('clean-one'),
      item('bad-one', { hasDiff: true, hasRegression: true }),
    ])];
    mount('?regressionFilter=regressions');
    await waitFor(() => expect(screen.getByText('bad-one')).toBeTruthy());
    expect(screen.queryByText('clean-one')).toBeNull();
  });

  it('filter=clean keeps only unflagged items', async () => {
    syncState.data = [payload([
      item('clean-one'),
      item('bad-one', { hasDiff: true, hasRegression: true }),
    ])];
    mount('?regressionFilter=clean');
    await waitFor(() => expect(screen.getByText('clean-one')).toBeTruthy());
    expect(screen.queryByText('bad-one')).toBeNull();
  });

  it('default filter (all) shows every item', async () => {
    syncState.data = [payload([
      item('clean-one'),
      item('bad-one', { hasDiff: true, hasRegression: true }),
    ])];
    mount();
    await waitFor(() => expect(screen.getByText('clean-one')).toBeTruthy());
    expect(screen.getByText('bad-one')).toBeTruthy();
  });

  it('renders an empty payload without crashing (no item rows)', async () => {
    syncState.data = [payload([])];
    mount();
    await waitFor(() => expect(screen.getByText('No items match.')).toBeTruthy());
    expect(screen.queryByText(/regressed|clean-/)).toBeNull();
  });

  it('renders the fetch-failure state without crashing', async () => {
    syncState.data = [];
    syncState.error = new Error('HTTP 500');
    mount();
    await waitFor(() => expect(screen.getByText(/Failed: HTTP 500/)).toBeTruthy());
    // Settles into the error branch; the pane must not throw or leave
    // item rows around. (Exact error copy is presentation, not contract.)
    expect(screen.queryByText(/clean-|regressed/)).toBeNull();
  });
});
