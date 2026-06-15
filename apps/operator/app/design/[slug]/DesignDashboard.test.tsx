// @vitest-environment jsdom
//
// DesignDashboard — the design-workspace tab. Load-bearing logic: the feature
// queue bucket counts (null/unset design_status counts as pending), the bucket
// filter (all/pending/accepted/ignored), pane selection (nuqs), and the
// selected-feature detail. A render-smoke drives a mocked /api/design/features
// under a fresh react-query client + nuqs adapter; SketchPane/RegressionPane are
// stubbed (their own panes are covered elsewhere / e2e).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('./SketchPane', () => ({ default: () => <div data-testid="sketch-pane" /> }));
vi.mock('./RegressionPane', () => ({ default: () => <div data-testid="regression-pane" /> }));

const { feed } = vi.hoisted(() => ({ feed: { features: [] as unknown[] } }));

function stubFeatures() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => feed })) as unknown as typeof fetch,
  );
}

function mkFeature(over: Record<string, unknown> = {}) {
  return {
    featureId: 'F-1',
    title: 'Feature one',
    summary: null,
    status: 'in_progress',
    needsDesign: true,
    designStatus: 'pending',
    designSpecId: null,
    discardedDesignWork: false,
    updatedTs: null,
    ...over,
  };
}

const FEATURES = [
  mkFeature({ featureId: 'F-1', title: 'Alpha', designStatus: 'pending' }),
  mkFeature({ featureId: 'F-2', title: 'Beta', designStatus: 'accepted' }),
  mkFeature({ featureId: 'F-3', title: 'Gamma', designStatus: null }),
];

import DesignDashboard from './DesignDashboard';

function renderAt(searchParams = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DesignDashboard slug="my-harness" />
    </QueryClientProvider>,
    { wrapper: withNuqsTestingAdapter({ searchParams }) },
  );
}

beforeEach(() => {
  feed.features = FEATURES;
  stubFeatures();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<DesignDashboard />', () => {
  it('renders the header scoped to the slug', () => {
    feed.features = [];
    renderAt();
    expect(screen.getByText(/· my-harness/)).toBeTruthy();
  });

  it('counts null/unset design_status as pending in the bucket tallies', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    // F-1 pending + F-3 (null → pending) = 2 pending; F-2 accepted = 1.
    const buckets = screen.getByRole('group', { name: /Filter design features by status/i });
    const pendingBtn = within(buckets).getByRole('button', { name: /pending/i });
    expect(pendingBtn.textContent).toContain('2');
    const acceptedBtn = within(buckets).getByRole('button', { name: /accepted/i });
    expect(acceptedBtn.textContent).toContain('1');
  });

  it('lists every feature in the all bucket', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.getByText('Gamma')).toBeTruthy();
  });

  it('filters to accepted features for ?bucket=accepted', async () => {
    renderAt('?bucket=accepted');
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('Gamma')).toBeNull();
  });

  it('shows the empty detail prompt until a feature is selected', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('Pick a feature to inspect')).toBeTruthy());
  });

  it('opens the feature detail when a queue row is clicked', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    fireEvent.click(screen.getByText('Alpha'));
    // Detail pane surfaces the Feature ID key.
    await waitFor(() => expect(screen.getByText('Feature ID')).toBeTruthy());
  });

  it('mounts the stubbed sketch pane for ?pane=sketch', async () => {
    renderAt('?pane=sketch');
    await waitFor(() => expect(screen.getByTestId('sketch-pane')).toBeTruthy());
  });

  it('clicking the accepted bucket filters the queue to accepted features', async () => {
    renderAt(); // starts in the "all" bucket
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.getByText('Gamma')).toBeTruthy();

    const buckets = screen.getByRole('group', { name: /Filter design features by status/i });
    fireEvent.click(within(buckets).getByRole('button', { name: /accepted/i }));

    // Only the accepted feature (Beta) remains; pending ones drop out.
    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull());
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(screen.queryByText('Gamma')).toBeNull();
  });
});
