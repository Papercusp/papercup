// @vitest-environment jsdom
//
// CoordDashboard — the /coord coordination surface. Real render logic exercised
// here: the four URL-backed panel tabs (sessions/inbox/plans/history) and which
// panel mounts for a given ?panel value, plus the empty-state copy each panel
// shows when its polled endpoint returns nothing. A render-smoke drives a mocked
// fetch (all endpoints empty) with CoordHistory stubbed; the polling/abort
// machinery itself is an effect detail left to e2e.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { withNuqsTestingAdapter } from 'nuqs/adapters/testing';

vi.mock('./CoordHistory', () => ({ default: () => <div data-testid="coord-history">history</div> }));

function stubEmpty() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('hook-health')) return { ok: true, json: async () => ({ healthy: true, last_success_ts: null, last_error: null }) } as unknown as Response;
      if (u.includes('presence')) return { ok: true, json: async () => ({ active: [], stale: [] }) } as unknown as Response;
      if (u.includes('inbox')) return { ok: true, json: async () => ({ items: [] }) } as unknown as Response;
      if (u.includes('plans')) return { ok: true, json: async () => ({ plans: [] }) } as unknown as Response;
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch,
  );
}

beforeEach(() => stubEmpty());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAt(searchParams: string) {
  return render(<CoordDashboard />, { wrapper: withNuqsTestingAdapter({ searchParams }) });
}

import CoordDashboard from './CoordDashboard';

describe('<CoordDashboard />', () => {
  it('renders the header and four panel tabs', () => {
    renderAt('');
    expect(screen.getByText('Coordination')).toBeTruthy();
    for (const tab of ['Sessions', 'Inbox', 'Plans', 'History']) {
      expect(screen.getByRole('button', { name: tab })).toBeTruthy();
    }
  });

  it('defaults to the Sessions panel and shows its empty state', async () => {
    renderAt('');
    await waitFor(() => expect(screen.getByText(/No active agent sessions\./i)).toBeTruthy());
  });

  it('mounts the Inbox panel for ?panel=inbox', async () => {
    renderAt('?panel=inbox');
    await waitFor(() => expect(screen.getByText(/Inbox is empty\./i)).toBeTruthy());
  });

  it('mounts the Plans panel for ?panel=plans', async () => {
    renderAt('?panel=plans');
    await waitFor(() => expect(screen.getByText(/No structured plans found\./i)).toBeTruthy());
  });

  it('mounts the (stubbed) History panel for ?panel=history', () => {
    renderAt('?panel=history');
    expect(screen.getByTestId('coord-history')).toBeTruthy();
  });

  it('switches panels on tab click', async () => {
    renderAt('');
    fireEvent.click(screen.getByRole('button', { name: 'Plans' }));
    await waitFor(() => expect(screen.getByText(/No structured plans found\./i)).toBeTruthy());
  });
});
