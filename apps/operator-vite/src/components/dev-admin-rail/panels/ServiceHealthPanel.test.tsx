// @vitest-environment jsdom
/**
 * ServiceHealthPanel.test — the dev-admin-rail "Service health" glance (P-005).
 *
 * Reads the `dev.serviceHealth` sync snapshot (data[0].services). Covers the
 * PanelState branches (loading / error / empty) and the per-probe row variants:
 * absent (present:false → is-absent dot + "absent" pill + note fallback), up
 * (is-good "up" pill + "<status> · <ms>ms" sub, optional "· N err"), and down
 * (is-bad "down" pill). Refresh button drives the query invalidate.
 *
 * `@papercusp/sync` is mocked with a hoisted store keyed by queryName; panel-kit
 * (PanelBar/PanelState) renders for real.
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

import ServiceHealthPanel from './ServiceHealthPanel';

function seed(queryName: string, over: Partial<(typeof H.results)[string]> = {}) {
  H.results[queryName] = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), ...over };
  return H.results[queryName];
}

beforeEach(() => {
  H.results = {};
});
afterEach(() => cleanup());

describe('<ServiceHealthPanel>', () => {
  it('shows the loading placeholder while loading with no data', () => {
    seed('dev.serviceHealth', { data: undefined, loading: true });
    render(<ServiceHealthPanel active={true} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('surfaces an error via PanelState', () => {
    seed('dev.serviceHealth', { data: undefined, error: new Error('probe boom') });
    render(<ServiceHealthPanel active={true} />);
    expect(screen.getByText('Failed to load: probe boom')).toBeTruthy();
  });

  it('renders the empty hint when there are no services', () => {
    seed('dev.serviceHealth', { data: [{ services: [] }] });
    render(<ServiceHealthPanel active={true} />);
    expect(screen.getByText('No probe data.')).toBeTruthy();
  });

  it('renders an UP service: is-good "up" pill + "<status> · <ms>ms" sub', () => {
    seed('dev.serviceHealth', {
      data: [{ services: [{ name: 'operator', up: true, status: 200, latencyMs: 12 }] }],
    });
    const { container } = render(<ServiceHealthPanel active={true} />);
    expect(screen.getByText('operator')).toBeTruthy();
    const pill = screen.getByText('up');
    expect(pill.className).toContain('is-good');
    expect(screen.getByText('200 · 12ms')).toBeTruthy();
    expect(container.querySelector('.pcdar-dot.is-up')).toBeTruthy();
  });

  it('appends "· N err" to an up service with recentErrors', () => {
    seed('dev.serviceHealth', {
      data: [{ services: [{ name: 'vite', up: true, status: 200, latencyMs: 5, recentErrors: 3 }] }],
    });
    render(<ServiceHealthPanel active={true} />);
    expect(screen.getByText('200 · 5ms · 3 err')).toBeTruthy();
  });

  it('renders status fallback "—" when up service has null status', () => {
    seed('dev.serviceHealth', {
      data: [{ services: [{ name: 'scout', up: true, status: null, latencyMs: 8 }] }],
    });
    render(<ServiceHealthPanel active={true} />);
    expect(screen.getByText('— · 8ms')).toBeTruthy();
  });

  it('renders a DOWN service: is-bad "down" pill', () => {
    seed('dev.serviceHealth', {
      data: [{ services: [{ name: 'web', up: false, status: 503, latencyMs: 40 }] }],
    });
    const { container } = render(<ServiceHealthPanel active={true} />);
    const pill = screen.getByText('down');
    expect(pill.className).toContain('is-bad');
    expect(container.querySelector('.pcdar-dot.is-down')).toBeTruthy();
  });

  it('renders an ABSENT service (present:false): is-absent dot, "absent" pill, note fallback', () => {
    seed('dev.serviceHealth', {
      data: [{ services: [{ name: 'shop', up: false, status: null, latencyMs: 0, present: false }] }],
    });
    const { container } = render(<ServiceHealthPanel active={true} />);
    const pill = screen.getByText('absent');
    expect(pill.className).not.toContain('is-good');
    expect(pill.className).not.toContain('is-bad');
    expect(container.querySelector('.pcdar-dot.is-absent')).toBeTruthy();
    // No note → falls back to 'not running'.
    expect(screen.getByText('not running')).toBeTruthy();
  });

  it('absent service shows its custom note when provided', () => {
    seed('dev.serviceHealth', {
      data: [{ services: [{ name: 'code-server', up: false, status: null, latencyMs: 0, present: false, note: 'disabled on this box' }] }],
    });
    render(<ServiceHealthPanel active={true} />);
    expect(screen.getByText('disabled on this box')).toBeTruthy();
  });

  it('refresh button calls the query invalidate', () => {
    const r = seed('dev.serviceHealth', { data: [{ services: [{ name: 'operator', up: true, status: 200, latencyMs: 9 }] }] });
    render(<ServiceHealthPanel active={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Service health' }));
    expect(r.invalidate).toHaveBeenCalled();
  });
});
