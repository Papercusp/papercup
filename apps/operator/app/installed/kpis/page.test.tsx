// @vitest-environment jsdom
/**
 * Render-tier coverage for the Substrate KPIs page (`/installed/kpis`).
 * Covers: the loading state, the populated stat grid, the fetch-error state
 * (no prior data), and the stale-data banner (a background refresh fails
 * while previously-fetched data is still shown — the case that used to be
 * silently swallowed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('@/lib/useLexicon', () => ({ useLexicon: () => (k: string) => k }));
const { syncState, invalidateSpy } = vi.hoisted(() => ({
  syncState: { data: [] as unknown[], loading: false, fetching: false, error: null as Error | null },
  invalidateSpy: vi.fn(),
}));
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ ...syncState, invalidate: invalidateSpy }),
}));

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

beforeEach(() => {
  Object.assign(syncState, { data: [kpis()], loading: false, fetching: false, error: null });
  invalidateSpy.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('KPIsPage', () => {
  it('shows a loading state before the first fetch resolves', async () => {
    Object.assign(syncState, { data: [], loading: true });
    render(<KPIsPage />);
    expect(screen.getByText(/Loading KPIs/i)).toBeTruthy();
  });

  it('renders the stat grid once data loads', () => {
    render(<KPIsPage />);
    expect(screen.getByText('Substrate KPIs')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy(); // Messages 24h
    expect(screen.getByText('42')).toBeTruthy(); // Actions 24h
  });

  it('shows a full-page error when the first query fails and there is no prior data', () => {
    Object.assign(syncState, { data: [], error: new Error('boom') });
    render(<KPIsPage />);
    expect(screen.getByText(/Failed to load/i)).toBeTruthy();
  });

  it('keeps showing stale data plus a warning when revalidation fails', () => {
    Object.assign(syncState, { data: [kpis()], error: new Error('boom') });
    render(<KPIsPage />);
    screen.getByRole('button', { name: 'Refresh' }).click();
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(screen.getByText(/showing stale data/i)).toBeTruthy();
    expect(screen.getByText('Substrate KPIs')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
  });
});
