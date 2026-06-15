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

const { feed } = vi.hoisted(() => ({
  feed: { items: [] as unknown[], total: 0, truncated: false },
}));

function stubHistory() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => feed })) as unknown as typeof fetch,
  );
}

const ITEMS = [
  { ts: '2026-01-01T00:00:00Z', msg_id: 'm1', source: 'escalation', kind: 'blocked', from: 'agent-a', summary: 'needs a human', plan_slug: 'plan-x', payload: { detail: 'x' } },
  { ts: '2026-01-01T00:01:00Z', msg_id: 'm2', source: 'message', kind: 'note', to: ['human'], summary: 'fyi', payload: {} },
];

beforeEach(() => {
  feed.items = [];
  feed.total = 0;
  feed.truncated = false;
  stubHistory();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

import CoordHistory from './CoordHistory';

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
    // "2 of 2" count summary.
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });

  it('surfaces the plan badge on events carrying a plan_slug', async () => {
    feed.items = ITEMS;
    feed.total = 2;
    renderAt();
    await waitFor(() => expect(screen.getByText('plan: plan-x')).toBeTruthy());
  });
});

describe('<CoordHistory /> interactions', () => {
  // Last fetched URL — every refetch goes through this single global stub.
  const lastUrl = () => {
    const f = (globalThis.fetch as ReturnType<typeof vi.fn>);
    return String(f.mock.calls.at(-1)?.[0] ?? '');
  };

  it('toggling a source pill off narrows the query to a kinds= filter and refetches', async () => {
    renderAt();
    // Initial fetch: all four sources selected → no kinds= filter.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(lastUrl()).not.toContain('kinds=');
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    // Deselect "Plan event" — the remaining three become an explicit kinds= set.
    fireEvent.click(screen.getByText('Plan event'));
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before),
    );
    const url = lastUrl();
    expect(url).toContain('kinds=');
    expect(url).not.toContain('plan_event');
    expect(url).toContain('message');
  });

  it('typing a plan_slug filter refetches with plan_slug in the query', async () => {
    renderAt();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());

    // Both filter inputs share the "(any)" placeholder; the first is plan_slug.
    const input = screen.getAllByPlaceholderText('(any)')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'plan-zed' } });
    await waitFor(() => expect(lastUrl()).toContain('plan_slug=plan-zed'));
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response));
    renderAt();
    await waitFor(() => expect(screen.getByText(/Error: status 503/)).toBeTruthy());
  });

  it('clicking Refresh issues another fetch', async () => {
    renderAt();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const before = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() =>
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before),
    );
  });
});
