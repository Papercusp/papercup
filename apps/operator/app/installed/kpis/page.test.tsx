// @vitest-environment jsdom
/**
 * Render-tier coverage for the Substrate KPIs page (`/installed/kpis`).
 * Covers: the loading state, the populated stat grid, the fetch-error state
 * (no prior data), and the stale-data banner (a background refresh fails
 * while previously-fetched data is still shown — the case that used to be
 * silently swallowed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));

import KPIsPage from './page';

function kpis(over: Record<string, unknown> = {}) {
  return {
    totals: {
      harnesses: 3,
      projects: 5,
      projects_by_status: { active: 4, archived: 1 },
      messages_24h: 120,
      executed_actions_24h: 42,
    },
    parents: [],
    directives: { open: 1, acknowledged: 2 },
    audit: { actions_24h_by_op: { create: 10, update: 5 } },
    autoloop: { active: 2, recent_fires: [] },
    system: { uptime_seconds: 3661 },
    ...over,
  };
}

let fetchImpl: (url: string) => Promise<Response>;
function installFetch() {
  const fn = vi.fn(async (url: string) => fetchImpl(String(url)));
  vi.stubGlobal('fetch', fn as unknown as typeof fetch);
  return fn;
}

beforeEach(() => {
  fetchImpl = async () => new Response(JSON.stringify(kpis()), { status: 200 });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('KPIsPage', () => {
  it('shows a loading state before the first fetch resolves', async () => {
    let resolveFetch!: (r: Response) => void;
    fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
    installFetch();

    render(<KPIsPage />);
    expect(screen.getByText(/Loading KPIs/i)).toBeTruthy();

    resolveFetch(new Response(JSON.stringify(kpis()), { status: 200 }));
    await waitFor(() => expect(screen.getByText('Substrate KPIs')).toBeTruthy());
  });

  it('renders the stat grid once data loads', async () => {
    installFetch();
    render(<KPIsPage />);
    await waitFor(() => expect(screen.getByText('Substrate KPIs')).toBeTruthy());
    expect(screen.getByText('120')).toBeTruthy(); // Messages 24h
    expect(screen.getByText('42')).toBeTruthy(); // Actions 24h
  });

  it('shows a full-page error when the first fetch fails and there is no prior data', async () => {
    fetchImpl = async () => new Response('boom', { status: 500 });
    installFetch();
    render(<KPIsPage />);
    await waitFor(() => expect(screen.getByText(/Failed to load/i)).toBeTruthy());
  });

  it('keeps showing stale data plus a warning banner when a later refresh fails', async () => {
    let callCount = 0;
    fetchImpl = async () => {
      callCount += 1;
      if (callCount === 1) return new Response(JSON.stringify(kpis()), { status: 200 });
      return new Response('boom', { status: 500 });
    };
    installFetch();

    render(<KPIsPage />);
    await waitFor(() => expect(screen.getByText('Substrate KPIs')).toBeTruthy());

    // Trigger a manual refresh that fails; the previously-fetched data (and
    // the page itself) must stay on screen rather than being replaced by the
    // full-page error state.
    screen.getByRole('button', { name: 'Refresh' }).click();

    await waitFor(() => expect(screen.getByText(/showing stale data/i)).toBeTruthy());
    expect(screen.getByText('Substrate KPIs')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
  });
});
