// @vitest-environment jsdom
/**
 * DbHealthPanel.test — the dev-admin-rail "DB health" glance (P-007).
 *
 * Reads two sync queries: `dev.pgHealth` (snapshot → data[0]) + `dev.pgActiveQueries`
 * (flat rows). Covers: error from either surfaced via PanelState; the connection
 * KV + the version-string strip regex; the active-queries header count + empty
 * state; and the three per-query row variants — idle-in-transaction (is-down dot
 * + is-bad pill), slow (>5s → is-warn "slow" pill), normal (is-up dot, no pill) —
 * plus fmtDur's ms / Ns / Nm branches. Refresh invalidates BOTH queries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const H = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown[] | undefined; loading: boolean; fetching: boolean; error: Error | null; invalidate: ReturnType<typeof vi.fn> }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    H.results[queryName] ?? { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn() },
}));

import DbHealthPanel from './DbHealthPanel';

function seed(queryName: string, over: Partial<(typeof H.results)[string]> = {}) {
  H.results[queryName] = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), ...over };
  return H.results[queryName];
}

const HEALTH = (over = {}) => ({ version: 'PostgreSQL 16.2 (Ubuntu)', totalConnections: 10, activeConnections: 3, idleConnections: 7, ...over });
const QUERY = (over = {}) => ({ pid: 100, state: 'active', query: 'SELECT 1', duration_seconds: 0.2, application_name: null, client_addr: null, ...over });

beforeEach(() => {
  H.results = {};
});
afterEach(() => cleanup());

describe('<DbHealthPanel>', () => {
  it('shows the loading placeholder while pgHealth loads with no snapshot', () => {
    seed('dev.pgHealth', { data: undefined, loading: true });
    seed('dev.pgActiveQueries', { data: [] });
    render(<DbHealthPanel active={true} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('surfaces a pgHealth error', () => {
    seed('dev.pgHealth', { data: undefined, error: new Error('pool dead') });
    seed('dev.pgActiveQueries', { data: [] });
    render(<DbHealthPanel active={true} />);
    expect(screen.getByText('Failed to load: pool dead')).toBeTruthy();
  });

  it('surfaces a pgActiveQueries error when pgHealth has none', () => {
    seed('dev.pgHealth', { data: [HEALTH()] });
    seed('dev.pgActiveQueries', { data: undefined, error: new Error('queries unreadable') });
    render(<DbHealthPanel active={true} />);
    expect(screen.getByText('Failed to load: queries unreadable')).toBeTruthy();
  });

  it('renders the connection KV + the stripped PG version', () => {
    seed('dev.pgHealth', { data: [HEALTH()] });
    seed('dev.pgActiveQueries', { data: [] });
    render(<DbHealthPanel active={true} />);
    expect(screen.getByText('10 total · 3 active · 7 idle')).toBeTruthy();
    // "PostgreSQL 16.2 (Ubuntu)" → "16.2"
    expect(screen.getByText('16.2')).toBeTruthy();
  });

  it('shows the active-queries count header and the empty state when none', () => {
    seed('dev.pgHealth', { data: [HEALTH()] });
    seed('dev.pgActiveQueries', { data: [] });
    render(<DbHealthPanel active={true} />);
    expect(screen.getByText('Active queries (0)')).toBeTruthy();
    expect(screen.getByText('No active queries.')).toBeTruthy();
  });

  it('renders a NORMAL query row: is-up dot, no pill, fmtDur ms branch', () => {
    seed('dev.pgHealth', { data: [HEALTH()] });
    seed('dev.pgActiveQueries', { data: [QUERY({ pid: 100, duration_seconds: 0.25 })] });
    const { container } = render(<DbHealthPanel active={true} />);
    expect(screen.getByText('Active queries (1)')).toBeTruthy();
    expect(container.querySelector('.pcdar-dot.is-up')).toBeTruthy();
    expect(container.querySelector('.pcdar-pill')).toBeNull();
    // 0.25s → 250ms
    expect(screen.getByText(/pid 100 · active · 250ms/)).toBeTruthy();
  });

  it('renders an IDLE-IN-TRANSACTION row: is-down dot + is-bad "idle-in-tx" pill', () => {
    seed('dev.pgHealth', { data: [HEALTH()] });
    seed('dev.pgActiveQueries', { data: [QUERY({ pid: 200, state: 'idle in transaction', duration_seconds: 12 })] });
    const { container } = render(<DbHealthPanel active={true} />);
    const pill = screen.getByText('idle-in-tx');
    expect(pill.className).toContain('is-bad');
    expect(container.querySelector('.pcdar-dot.is-down')).toBeTruthy();
  });

  it('renders a SLOW row (>5s, not idle): is-warn "slow" pill + fmtDur seconds branch', () => {
    seed('dev.pgHealth', { data: [HEALTH()] });
    seed('dev.pgActiveQueries', { data: [QUERY({ pid: 300, state: 'active', duration_seconds: 12.3 })] });
    render(<DbHealthPanel active={true} />);
    const pill = screen.getByText('slow');
    expect(pill.className).toContain('is-warn');
    // 12.3s → "12.3s"
    expect(screen.getByText(/pid 300 · active · 12\.3s/)).toBeTruthy();
  });

  it('fmtDur minutes branch (≥60s) renders as Nm', () => {
    seed('dev.pgHealth', { data: [HEALTH()] });
    seed('dev.pgActiveQueries', { data: [QUERY({ pid: 400, duration_seconds: 120 })] });
    render(<DbHealthPanel active={true} />);
    // 120s → 2m
    expect(screen.getByText(/pid 400 · active · 2m/)).toBeTruthy();
  });

  it('appends application_name to the row sub when present', () => {
    seed('dev.pgHealth', { data: [HEALTH()] });
    seed('dev.pgActiveQueries', { data: [QUERY({ pid: 500, application_name: 'git-sync', duration_seconds: 0.5 })] });
    render(<DbHealthPanel active={true} />);
    expect(screen.getByText(/pid 500 · active · 500ms · git-sync/)).toBeTruthy();
  });

  it('refresh invalidates BOTH pgHealth and pgActiveQueries', () => {
    const health = seed('dev.pgHealth', { data: [HEALTH()] });
    const queries = seed('dev.pgActiveQueries', { data: [] });
    render(<DbHealthPanel active={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh DB health' }));
    expect(health.invalidate).toHaveBeenCalled();
    expect(queries.invalidate).toHaveBeenCalled();
  });
});
