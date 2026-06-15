// @vitest-environment jsdom
/**
 * NotificationsPanel.test — the dev-admin-rail "Notifications" stream (P-004).
 *
 * Reads `toastLog.recent`. Covers: the empty hint; newest-first sort; the
 * error-count pill (only when ≥1 un-hidden error); per-level dot classing;
 * description + harnessSlug rendering. Interactions: per-row dismiss (X) hides
 * the row and decrements the error count; clear-all (Trash2) DELETEs the toast
 * log (global fetch stubbed) and only shows when data is non-empty.
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

import NotificationsPanel from './NotificationsPanel';

function seed(over: Partial<(typeof H.results)[string]> = {}) {
  H.results['toastLog.recent'] = { data: [], loading: false, fetching: false, error: null, invalidate: vi.fn(), ...over };
  return H.results['toastLog.recent'];
}

const ROW = (over = {}) => ({ id: 1, level: 'info', message: 'hello', createdAt: Date.now(), ...over });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  H.results = {};
  fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('<NotificationsPanel>', () => {
  it('renders the empty hint with no rows', () => {
    seed({ data: [] });
    render(<NotificationsPanel active={true} />);
    expect(screen.getByText('No notifications yet.')).toBeTruthy();
  });

  it('surfaces a sync error', () => {
    seed({ data: undefined, error: new Error('stream gone') });
    render(<NotificationsPanel active={true} />);
    expect(screen.getByText('Failed to load: stream gone')).toBeTruthy();
  });

  it('sorts rows newest-first by createdAt', () => {
    seed({
      data: [
        ROW({ id: 1, message: 'older', createdAt: 1000 }),
        ROW({ id: 2, message: 'newest', createdAt: 3000 }),
        ROW({ id: 3, message: 'middle', createdAt: 2000 }),
      ],
    });
    render(<NotificationsPanel active={true} />);
    const titles = screen.getAllByText(/older|newest|middle/).map((n) => n.textContent);
    expect(titles).toEqual(['newest', 'middle', 'older']);
  });

  it('shows the error-count pill only when there is an un-hidden error', () => {
    seed({
      data: [ROW({ id: 1, level: 'info', message: 'a' }), ROW({ id: 2, level: 'error', message: 'boom' })],
    });
    render(<NotificationsPanel active={true} />);
    expect(screen.getByText('1 err')).toBeTruthy();
  });

  it('no error-count pill when there are zero errors', () => {
    seed({ data: [ROW({ id: 1, level: 'info', message: 'a' })] });
    render(<NotificationsPanel active={true} />);
    expect(screen.queryByText(/\d+ err/)).toBeNull();
  });

  it('classes the dot by level: error → is-down, info → is-up', () => {
    seed({ data: [ROW({ id: 1, level: 'error', message: 'boom' })] });
    const { container } = render(<NotificationsPanel active={true} />);
    expect(container.querySelector('.pcdar-dot.is-down')).toBeTruthy();
    cleanup();
    seed({ data: [ROW({ id: 2, level: 'info', message: 'fine' })] });
    const { container: c2 } = render(<NotificationsPanel active={true} />);
    expect(c2.querySelector('.pcdar-dot.is-up')).toBeTruthy();
  });

  it('renders description + harnessSlug in the sub line', () => {
    seed({ data: [ROW({ id: 1, level: 'warning', message: 'careful', description: 'extra detail', harnessSlug: 'pot-a' })] });
    render(<NotificationsPanel active={true} />);
    expect(screen.getByText('extra detail')).toBeTruthy();
    expect(screen.getByText(/warning · pot-a ·/)).toBeTruthy();
  });

  it('dismiss (X) hides the row and decrements the error count', () => {
    seed({ data: [ROW({ id: 1, level: 'error', message: 'boom' }), ROW({ id: 2, level: 'info', message: 'ok' })] });
    render(<NotificationsPanel active={true} />);
    expect(screen.getByText('1 err')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    // The error row's dismiss button is the first Dismiss (newest-first: error id1 vs info id2 — both default createdAt; pick the boom row).
    const dismissButtons = screen.getAllByRole('button', { name: 'Dismiss' });
    // Find the dismiss within the boom row.
    const boomRow = screen.getByText('boom').closest('.pcdar-row')!;
    const boomDismiss = boomRow.querySelector('button[aria-label="Dismiss"]') as HTMLButtonElement;
    expect(dismissButtons.length).toBe(2);
    fireEvent.click(boomDismiss);
    expect(screen.queryByText('boom')).toBeNull();
    expect(screen.queryByText('1 err')).toBeNull();
  });

  it('clear-all only renders when data is non-empty and DELETEs the toast log', () => {
    seed({ data: [] });
    render(<NotificationsPanel active={true} />);
    expect(screen.queryByRole('button', { name: 'Clear all notifications' })).toBeNull();
    cleanup();

    seed({ data: [ROW({ id: 1, level: 'info', message: 'a' })] });
    render(<NotificationsPanel active={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear all notifications' }));
    expect(fetchMock).toHaveBeenCalledWith('/api/toast-log?all=1', { method: 'DELETE' });
  });

  it('refresh button calls the sync invalidate', () => {
    const r = seed({ data: [ROW({ id: 1, level: 'info', message: 'a' })] });
    render(<NotificationsPanel active={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Notifications' }));
    expect(r.invalidate).toHaveBeenCalled();
  });
});
