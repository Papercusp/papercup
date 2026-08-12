// @vitest-environment jsdom
//
// DesignDashboard — the design-workspace tab. Load-bearing logic: the feature
// queue bucket counts (null/unset design_status counts as pending), the bucket
// filter (all/pending/accepted/ignored), pane selection (nuqs), and the
// selected-feature detail. A render-smoke drives mocked @papercusp/sync rows
// under a nuqs adapter; SketchPane/RegressionPane are stubbed (their own panes
// are covered elsewhere / e2e).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('./SketchPane', () => ({ default: () => <div data-testid="sketch-pane" /> }));
vi.mock('./RegressionPane', () => ({ default: () => <div data-testid="regression-pane" /> }));

const { syncRows, detailArgsSeen, invalidateMock } = vi.hoisted(() => ({
  syncRows: {
    features: [] as unknown[],
    featureDetail: [] as unknown[],
    memos: [] as unknown[],
    registry: [] as unknown[],
    tokens: [] as unknown[],
  },
  // WI-7232: records every designFeatures.detail subscription so a test can
  // assert the read is ENABLED only for a selected feature, not for all 390.
  detailArgsSeen: [] as Array<{ featureId: unknown; enabled: boolean }>,
  invalidateMock: vi.fn(),
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: ({
    queryName,
    args,
    enabled,
  }: {
    queryName: string;
    args?: Record<string, unknown>;
    enabled?: boolean;
  }) => {
    // The real hook returns nothing while disabled — model that, or the detail
    // read would look free and the enabled-gating regression would go unseen.
    const on = enabled !== false;
    if (queryName === 'designFeatures.detail') {
      detailArgsSeen.push({ featureId: args?.featureId, enabled: on });
    }
    const data =
      queryName === 'designFeatures.byHarness' ? syncRows.features
        : queryName === 'designFeatures.detail'
          ? on ? syncRows.featureDetail.filter((r) => (r as { featureId?: string }).featureId === args?.featureId) : []
          : queryName === 'designMemos.list' ? syncRows.memos
            : queryName === 'designRegistry.search' ? syncRows.registry
              : queryName === 'designTokens.list' ? syncRows.tokens
                : [];
    return { data, loading: false, fetching: false, error: null, transport: 'SSE', invalidate: invalidateMock };
  },
}));

/** WI-7232 — the LIST row carries EXACTLY these three fields. Deliberately not
 *  a superset: a fixture richer than the real payload lets the component read a
 *  field the wire no longer carries and still go green. */
function mkListRow(over: Record<string, unknown> = {}) {
  return { featureId: 'F-1', title: 'Feature one', designStatus: 'pending', ...over };
}

/** The on-demand detail row — the only place `summary` now lives. */
function mkDetail(over: Record<string, unknown> = {}) {
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
  mkListRow({ featureId: 'F-1', title: 'Alpha', designStatus: 'pending' }),
  mkListRow({ featureId: 'F-2', title: 'Beta', designStatus: 'accepted' }),
  mkListRow({ featureId: 'F-3', title: 'Gamma', designStatus: null }),
];

const FEATURE_DETAILS = [
  mkDetail({ featureId: 'F-1', title: 'Alpha', designStatus: 'pending', summary: 'Alpha implementation summary.', status: 'in_progress' }),
  mkDetail({ featureId: 'F-2', title: 'Beta', designStatus: 'accepted', summary: 'Beta implementation summary.', designSpecId: 'DS-9' }),
  mkDetail({ featureId: 'F-3', title: 'Gamma', designStatus: null, summary: null, discardedDesignWork: true }),
];

import DesignDashboard from './DesignDashboard';

function renderAt(searchParams = '') {
  return render(<DesignDashboard slug="my-harness" />, { wrapper: withNuqsTestingAdapter({ searchParams }) });
}

beforeEach(() => {
  syncRows.features = FEATURES;
  syncRows.featureDetail = FEATURE_DETAILS;
  syncRows.memos = [];
  syncRows.registry = [];
  syncRows.tokens = [];
  detailArgsSeen.length = 0;
  invalidateMock.mockClear();
});
afterEach(() => {
  cleanup();
});

describe('<DesignDashboard />', () => {
  it('renders the header scoped to the slug', () => {
    syncRows.features = [];
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

  // ── WI-7232: the list/detail split ───────────────────────────────────────
  //
  // `summary` was 383,500 B of a 521,715 B payload (81.78%) and only ever
  // rendered for the ONE selected feature. These pin BOTH halves: the list must
  // stay narrow, and every field the detail card reads must still be reachable.

  it('the LIST row carries exactly featureId/title/designStatus — no summary (WI-7232)', () => {
    for (const row of FEATURES) {
      expect(Object.keys(row).sort()).toEqual(['designStatus', 'featureId', 'title']);
      // Assert KEY ABSENCE, not a null value: a `summary: null` would still be
      // 390 keys on the wire and would read as "cut" when it is not.
      expect('summary' in row).toBe(false);
      expect('status' in row).toBe(false);
      expect('designSpecId' in row).toBe(false);
      expect('discardedDesignWork' in row).toBe(false);
      expect('needsDesign' in row).toBe(false);
      expect('updatedTs' in row).toBe(false);
    }
  });

  it('does NOT subscribe to designFeatures.detail until a feature is selected (WI-7232)', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    // The hook is mounted unconditionally (rules of hooks) but must be disabled.
    expect(detailArgsSeen.length).toBeGreaterThan(0);
    expect(detailArgsSeen.every((c) => c.enabled === false)).toBe(true);
  });

  it('renders the summary from the DETAIL read, for the selected feature only (WI-7232)', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    // Nothing rendered before selection — the summaries are not in the list.
    expect(screen.queryByText('Alpha implementation summary.')).toBeNull();

    fireEvent.click(screen.getByText('Alpha'));

    await waitFor(() => expect(screen.getByText('Alpha implementation summary.')).toBeTruthy());
    // Exactly ONE feature's summary is fetched, not all three.
    expect(screen.queryByText('Beta implementation summary.')).toBeNull();
    expect(detailArgsSeen.some((c) => c.enabled && c.featureId === 'F-1')).toBe(true);
    expect(detailArgsSeen.some((c) => c.enabled && c.featureId === 'F-2')).toBe(false);
  });

  it('every detail-card field survives the split — status, design spec, discarded work (WI-7232)', async () => {
    renderAt('?bucket=accepted');
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
    fireEvent.click(screen.getByText('Beta'));

    // Beta's detail row carries designSpecId DS-9 and discardedDesignWork false.
    await waitFor(() => expect(screen.getByText('DS-9')).toBeTruthy());
    expect(screen.getByText('Beta implementation summary.')).toBeTruthy();
    const grid = screen.getByText('Discarded work').closest('div')!;
    expect(grid.textContent).toContain('no');
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
