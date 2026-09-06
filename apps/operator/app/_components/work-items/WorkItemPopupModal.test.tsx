// @vitest-environment jsdom
/**
 * WorkItemPopupModal (chat-ref-pills-2026-07-26 P-008) — a clicked WI-/EI-/F-
 * ref pill opens this AS A POPUP (D-001) instead of navigating the Working
 * tab. Asserts: closed when `id` is null; the harness-gated empty state when
 * `harnessSlug` is missing (and the query stays disabled — never guesses
 * across harnesses); loading/not-found degrades; a resolved row renders the
 * REAL `WorkItemDetail` body with its popup-only Chat action suppressed; its
 * own cross-link (`onSelect`) passes straight through; and the close button /
 * Escape both fire `onClose`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';

const { syncResults, syncLoading, syncCalls } = vi.hoisted(() => ({
  syncResults: {} as Record<string, unknown[]>,
  syncLoading: { current: false },
  syncCalls: [] as Array<{ queryName: string; enabled?: boolean; args?: unknown }>,
}));

vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  ORIGIN_SCHEDULER_CLASSES: ['interactive-control', 'foreground-read', 'background-sync', 'bulk'],
  useSyncQuery: (opts: { queryName: string; enabled?: boolean; args?: unknown }) => {
    syncCalls.push({ queryName: opts.queryName, enabled: opts.enabled, args: opts.args });
    const enabled = opts.enabled !== false;
    return {
      data: enabled ? (syncResults[opts.queryName] ?? []) : [],
      loading: enabled && syncLoading.current,
      fetching: false,
      transport: 'sse' as const,
      invalidate: () => {},
      error: null,
    };
  },
}));

// WorkItemDetail renders URL-backed sections from DetailPanel, so the popup
// test must provide the same nuqs adapter as the component-level suites.
const renderPopup = (ui: Parameters<typeof render>[0]) =>
  render(ui, {
    wrapper: ({ children }) => (
      <NuqsTestingAdapter searchParams="">{children}</NuqsTestingAdapter>
    ),
  });

import WorkItemPopupModal from './WorkItemPopupModal';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(syncResults)) delete syncResults[k];
  syncLoading.current = false;
  syncCalls.length = 0;
});

describe('WorkItemPopupModal — open/closed', () => {
  it('renders nothing when id is null (closed)', () => {
    renderPopup(<WorkItemPopupModal id={null} harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.queryByTestId('wi-popup-body')).toBeNull();
  });
});

describe('WorkItemPopupModal — harness gating', () => {
  it('renders a "no harness context" empty state and never queries when harnessSlug is null', () => {
    renderPopup(<WorkItemPopupModal id="WI-5952" harnessSlug={null} onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/No harness context for WI-5952/)).toBeTruthy();
    const call = syncCalls.find((c) => c.queryName === 'workItems.detail');
    expect(call?.enabled).toBe(false);
  });
});

describe('WorkItemPopupModal — loading / not-found / found', () => {
  it('shows a loading state while the query is in flight', () => {
    syncLoading.current = true;
    renderPopup(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/Loading WI-5952/)).toBeTruthy();
  });

  it('shows "no item found" when the query settles with no matching row', () => {
    syncResults['workItems.detail'] = [];
    renderPopup(<WorkItemPopupModal id="WI-9999" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/No item found for WI-9999/)).toBeTruthy();
  });

  it('queries workItems.detail scoped to harnessSlug + id', () => {
    syncResults['workItems.detail'] = [
      { id: 'WI-5952', kind: 'task', family: 'issue', title: 'Build the popup', state: 'wip' },
    ];
    renderPopup(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    const call = syncCalls.find((c) => c.queryName === 'workItems.detail');
    expect(call).toMatchObject({ enabled: true, args: { harnessSlug: 'papercusp', id: 'WI-5952' } });
  });

  it('renders the REAL WorkItemDetail body (id + title) for a resolved row, unforked', () => {
    syncResults['workItems.detail'] = [
      { id: 'WI-5952', kind: 'task', family: 'issue', title: 'Build the popup', state: 'wip' },
    ];
    renderPopup(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText('WI-5952')).toBeTruthy();
    expect(screen.getByText('Build the popup')).toBeTruthy();
    // Inline Discuss is now the only popup-adjacent chat entry point. The
    // Working pane still renders WorkItemDetail's dock-backed action.
    expect(screen.queryByTestId('wi-detail-chat')).toBeNull();
    expect(screen.queryByTestId('wi-detail-discuss')).toBeNull();
  });
});

describe('WorkItemPopupModal — cross-link + close', () => {
  it('forwards WorkItemDetail\'s own cross-link (a feature-family "Open feature detail" click) straight to onSelect', () => {
    syncResults['workItems.detail'] = [
      { id: 'F-100', kind: 'feature', family: 'feature', title: 'A feature', state: 'open' },
    ];
    const onSelect = vi.fn();
    renderPopup(<WorkItemPopupModal id="F-100" harnessSlug="papercusp" onSelect={onSelect} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/Open feature detail/));
    expect(onSelect).toHaveBeenCalledWith('F-100');
  });

  it('the close button fires onClose', () => {
    syncResults['workItems.detail'] = [
      { id: 'WI-5952', kind: 'task', family: 'issue', title: 'Build the popup', state: 'wip' },
    ];
    const onClose = vi.fn();
    renderPopup(<WorkItemPopupModal id="WI-5952" harnessSlug="papercusp" onSelect={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByTestId('wi-popup-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
