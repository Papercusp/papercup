// @vitest-environment jsdom
//
// CoordHistory — the merged coord/* event-feed viewer. Real render logic
// exercised: the source filter pills, the plan_slug/owner filter inputs, the
// per-event rows (badge = kind, summary, from/to meta) and the empty state. A
// render-smoke drives a mocked /api/coord/history; filters live in nuqs (real
// testing adapter). The 5s poll + abort-on-supersede is an effect detail for e2e.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

const { feed, syncCalls, invalidateSpy } = vi.hoisted(() => ({
  feed: { items: [] as unknown[], total: 0, truncated: false, error: null as Error | null },
  syncCalls: [] as Array<{ args?: Record<string, unknown> }>,
  invalidateSpy: vi.fn(),
}));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: (opts: { args?: Record<string, unknown> }) => {
    syncCalls.push(opts);
    return { data: feed.items, loading: false, fetching: false, error: feed.error, invalidate: invalidateSpy };
  },
}));

/**
 * WI-7297: payloads are served PER ROW from /api/coord/history/:source/:msg_id,
 * never inline in the list feed. This stub answers that route only, so a test
 * asserting an expanded payload is really asserting the on-demand fetch.
 */
const PAYLOADS: Record<string, unknown> = {
  'escalation/m1': { detail: 'x' },
  'message/m2': { body: 'the body' },
};

const fetchSpy = vi.hoisted(() => vi.fn());

function stubHistory() {
  fetchSpy.mockImplementation(async (url: unknown) => {
    const m = /\/api\/coord\/history\/([^/]+)\/([^/]+)$/.exec(String(url));
    if (!m) return { ok: true, status: 200, json: async () => feed };
    const payload = PAYLOADS[`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`];
    return payload === undefined
      ? { ok: false, status: 404, json: async () => ({ error: 'history item not found' }) }
      : { ok: true, status: 200, json: async () => ({ payload }) };
  });
  vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
}

/**
 * ⚠ Deliberately NO `payload` key — this mirrors what the sync feed actually
 * delivers after WI-7297. A fixture that still carried one would let the
 * component read it off the list row and every test here would pass while the
 * live screen showed nothing.
 */
const ITEMS = [
  { ts: '2026-01-01T00:00:00Z', msg_id: 'm1', source: 'escalation', kind: 'blocked', from: 'agent-a', summary: 'needs a human', plan_slug: 'plan-x' },
  { ts: '2026-01-01T00:01:00Z', msg_id: 'm2', source: 'message', kind: 'note', to: ['human'], summary: 'fyi' },
];

beforeEach(() => {
  feed.items = [];
  feed.total = 0;
  feed.truncated = false;
  feed.error = null;
  syncCalls.length = 0;
  invalidateSpy.mockClear();
  stubHistory();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

import CoordHistory, { coordHistoryWindowLabel } from './CoordHistory';

function renderAt(searchParams = '') {
  return render(<CoordHistory />, { wrapper: withNuqsTestingAdapter({ searchParams }) });
}

describe('<CoordHistory />', () => {
  it('renders the source filter pills and filter inputs', () => {
    renderAt();
    expect(screen.getByText('Plan event')).toBeTruthy();
    expect(screen.getByText('Escalation')).toBeTruthy();
    expect(screen.getByText('plan_slug')).toBeTruthy();
    expect(screen.getByText('owner')).toBeTruthy();
  });

  it('shows the no-events empty state when the feed is empty', async () => {
    renderAt();
    await waitFor(() => expect(screen.getByText(/No coordination events match these filters\./i)).toBeTruthy());
  });

  it('renders a row per event with its kind badge, summary and total count', async () => {
    feed.items = ITEMS;
    feed.total = 2;
    renderAt();
    await waitFor(() => expect(screen.getByText('needs a human')).toBeTruthy());
    expect(screen.getByText('blocked')).toBeTruthy();
    expect(screen.getByText('fyi')).toBeTruthy();
    expect(screen.getByText('2 latest matches · up to 200')).toBeTruthy();
  });

  it('surfaces the plan badge on events carrying a plan_slug', async () => {
    feed.items = ITEMS;
    feed.total = 2;
    renderAt();
    await waitFor(() => expect(screen.getByText('plan: plan-x')).toBeTruthy());
  });
});

describe('coordHistoryWindowLabel', () => {
  it('changes the declared window instead of implying a corpus total', () => {
    expect(coordHistoryWindowLabel(40, 50)).toBe('40 latest matches · up to 50');
    expect(coordHistoryWindowLabel(40, 200)).toBe('40 latest matches · up to 200');
  });
});

describe('<CoordHistory /> interactions', () => {
  it('toggling a source pill narrows the named-query kinds args', async () => {
    renderAt();
    const before = syncCalls.length;

    // Deselect "Plan event" — the remaining three become an explicit kinds= set.
    fireEvent.click(screen.getByText('Plan event'));
    await waitFor(() =>
      expect(syncCalls.length).toBeGreaterThan(before),
    );
    const kinds = syncCalls.at(-1)?.args?.kinds as string[];
    expect(kinds).not.toContain('plan_event');
    expect(kinds).toContain('message');
  });

  it('typing a plan_slug filter updates the named-query args', async () => {
    renderAt();

    // Both filter inputs share the "(any)" placeholder; the first is plan_slug.
    const input = screen.getAllByPlaceholderText('(any)')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'plan-zed' } });
    await waitFor(() => expect(syncCalls.at(-1)?.args?.planSlug).toBe('plan-zed'));
  });

  it('expands a row to reveal its JSON payload, and collapses on a second click', async () => {
    feed.items = ITEMS;
    feed.total = 2;
    renderAt();
    const rowBtn = await screen.findByText('needs a human');
    // Payload is hidden until expanded.
    expect(screen.queryByText(/"detail": "x"/)).toBeNull();
    fireEvent.click(rowBtn);
    await waitFor(() => expect(screen.getByText(/"detail": "x"/)).toBeTruthy());
    fireEvent.click(rowBtn);
    await waitFor(() => expect(screen.queryByText(/"detail": "x"/)).toBeNull());
  });

  it('renders the error banner when the history fetch fails', async () => {
    feed.error = new Error('status 503');
    renderAt();
    await waitFor(() => expect(screen.getByText(/Error: status 503/)).toBeTruthy());
  });

  it('clicking Refresh invalidates the named query', () => {
    renderAt();
    fireEvent.click(screen.getByText('Refresh'));
    expect(invalidateSpy).toHaveBeenCalledOnce();
  });
});
