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
 * Seam: global fetch (the /api/design/regressions read). Rendered under
 * withNuqsTestingAdapter + a fresh react-query client per render (retries
 * off so the failure test settles immediately).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

let fetchImpl: () => Promise<Partial<Response>>;
const fetchMock = vi.fn(async () => (await fetchImpl()) as Response);

const respond = (items: ReturnType<typeof item>[]) => async () =>
  ({
    ok: true,
    json: async () => ({
      ok: true,
      counts: {
        baseline: items.length,
        current: items.length,
        diff: items.filter((i) => i.hasDiff).length,
        regressions: items.filter((i) => i.hasRegression).length,
      },
      items,
    }),
  }) as Partial<Response>;

function mount(searchParams = '') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RegressionPane />
    </QueryClientProvider>,
    { wrapper: withNuqsTestingAdapter({ searchParams }) },
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  fetchImpl = respond([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    fetchImpl = respond([
      item('zeta-clean'),
      item('beta-regressed', { hasDiff: true, hasRegression: true }),
      item('alpha-clean'),
      item('delta-regressed', { hasDiff: true, hasRegression: true }),
    ]);
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
    fetchImpl = respond([
      item('clean-one'),
      item('bad-one', { hasDiff: true, hasRegression: true }),
    ]);
    mount('?regressionFilter=regressions');
    await waitFor(() => expect(screen.getByText('bad-one')).toBeTruthy());
    expect(screen.queryByText('clean-one')).toBeNull();
  });

  it('filter=clean keeps only unflagged items', async () => {
    fetchImpl = respond([
      item('clean-one'),
      item('bad-one', { hasDiff: true, hasRegression: true }),
    ]);
    mount('?regressionFilter=clean');
    await waitFor(() => expect(screen.getByText('clean-one')).toBeTruthy());
    expect(screen.queryByText('bad-one')).toBeNull();
  });

  it('default filter (all) shows every item', async () => {
    fetchImpl = respond([
      item('clean-one'),
      item('bad-one', { hasDiff: true, hasRegression: true }),
    ]);
    mount();
    await waitFor(() => expect(screen.getByText('clean-one')).toBeTruthy());
    expect(screen.getByText('bad-one')).toBeTruthy();
  });

  it('renders an empty payload without crashing (no item rows)', async () => {
    fetchImpl = respond([]);
    mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/regressed|clean-/)).toBeNull();
  });

  it('renders the fetch-failure state without crashing', async () => {
    fetchImpl = async () => ({ ok: false, status: 500 }) as Partial<Response>;
    mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Settles into the error branch; the pane must not throw or leave
    // item rows around. (Exact error copy is presentation, not contract.)
    expect(screen.queryByText(/clean-|regressed/)).toBeNull();
  });
});
