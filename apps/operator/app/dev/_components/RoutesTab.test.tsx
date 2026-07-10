// @vitest-environment jsdom
//
// RoutesTab — the recent route_invocations traffic panel. Two pure formatters
// carry its display logic: fmtRelTime (now-anchored "Ns/m/h/d ago") and
// fmtDuration (ms → "Ns" → "Nm Ss", null-safe), pinned below. The render-level
// tests drive every gated branch of the body — loading, error, the `degraded`
// (migration-077-missing) notice, the empty state, and the populated grid —
// plus the row-limit Select, asserting it writes the nuqs param and refetches
// at the new limit. The five mutually-exclusive render gates are exactly where
// a wrong condition would hide from the formatter tests.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@papercusp/grid-core', () => ({
  VirtualGrid: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="grid" data-rows={rows.length} />
  ),
}));

const { nuqsStore } = vi.hoisted(() => ({ nuqsStore: new Map<string, string>() }));
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => {
  const React = require('react');
  return {
    ...nuqsParsers,
    parseAsStringEnum: () => ({ withDefault: (d: string) => ({ _default: d }) }),
    useQueryState: (key: string, parser: { _default?: string }) => {
      const [, force] = React.useState(0);
      const value = nuqsStore.has(key) ? nuqsStore.get(key)! : parser?._default ?? null;
      const set = (v: string) => { nuqsStore.set(key, v); force((n: number) => n + 1); };
      return [value, set];
    },
  };
});

vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, ariaLabel, options }: {
    value: string; onChange: (v: string) => void; ariaLabel: string;
    options: { value: string; label: string }[];
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  ),
}));

import RoutesTab, { fmtRelTime, fmtDuration } from './RoutesTab';

const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();

describe('fmtRelTime', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it('renders seconds-ago under a minute', () => {
    expect(fmtRelTime(new Date(NOW - 30_000).toISOString())).toBe('30s ago');
  });
  it('renders minutes-ago under an hour', () => {
    expect(fmtRelTime(new Date(NOW - 5 * 60_000).toISOString())).toBe('5m ago');
  });
  it('renders hours-ago under a day', () => {
    expect(fmtRelTime(new Date(NOW - 3 * 3_600_000).toISOString())).toBe('3h ago');
  });
  it('renders days-ago past a day', () => {
    expect(fmtRelTime(new Date(NOW - 2 * 86_400_000).toISOString())).toBe('2d ago');
  });
});

describe('fmtDuration', () => {
  it('renders an em dash for null', () => { expect(fmtDuration(null)).toBe('—'); });
  it('renders raw ms under a second', () => { expect(fmtDuration(250)).toBe('250ms'); });
  it('renders seconds with two decimals under a minute', () => { expect(fmtDuration(1500)).toBe('1.50s'); });
  it('renders "Nm Ss" past a minute', () => { expect(fmtDuration(65_000)).toBe('1m 5s'); });
});

describe('<RoutesTab /> render gates + limit control', () => {
  beforeEach(() => nuqsStore.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

  it('shows the loading placeholder until the fetch resolves', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    render(<RoutesTab />);
    expect(screen.getByText('loading…')).toBeTruthy();
  });

  it('renders the error branch on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 }) as Response));
    render(<RoutesTab />);
    await waitFor(() => expect(screen.getByText('HTTP 502')).toBeTruthy());
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('renders the migration-077 notice when the response is degraded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ rows: [], degraded: true })));
    render(<RoutesTab />);
    await waitFor(() =>
      expect(screen.getByText(/route_invocations table not present/)).toBeTruthy(),
    );
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('renders the empty state when no invocations are recorded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ rows: [] })));
    render(<RoutesTab />);
    await waitFor(() =>
      expect(screen.getByText('no route invocations recorded yet.')).toBeTruthy(),
    );
    expect(screen.queryByTestId('grid')).toBeNull();
  });

  it('renders the grid when rows are present', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ok({ rows: [
        { method: 'GET', path: '/a', status: 'ok', duration_ms: 5, principal_kind: null, principal_trust: null, invoked_at: new Date().toISOString() },
        { method: 'POST', path: '/b', status: 'err', duration_ms: null, principal_kind: 'agent', principal_trust: 'trusted', invoked_at: new Date().toISOString() },
      ] }),
    ));
    render(<RoutesTab />);
    const grid = await screen.findByTestId('grid');
    expect(grid.getAttribute('data-rows')).toBe('2');
  });

  it('defaults to limit 100 and refetches with a new limit when changed', async () => {
    const fetchMock = vi.fn(async () => ok({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<RoutesTab />);
    await waitFor(() => expect(screen.getByText('no route invocations recorded yet.')).toBeTruthy());
    expect((fetchMock.mock.calls[0][0] as string)).toContain('limit=100');

    fireEvent.change(screen.getByLabelText('Route invocations row limit'), { target: { value: '500' } });
    await waitFor(() => expect(nuqsStore.get('routesLimit')).toBe('500'));
    await waitFor(() =>
      expect((fetchMock.mock.calls.at(-1)![0] as string)).toContain('limit=500'),
    );
  });
});
