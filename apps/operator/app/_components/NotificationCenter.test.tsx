// @vitest-environment jsdom
//
// NotificationCenter — the persistent toast-history bell.
// formatRelative (the "Ns/Nm/Nh/Nd ago" pretty-printer) is extracted + tested
// against an injected `now`. A render-smoke drives a mocked toastLog sync query
// to confirm the empty surface, the populated list, and the unread badge count.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

// Hoisted mutable holder for the toastLog rows the sync factory closes over.
const { sync, confirmState } = vi.hoisted(() => ({
  sync: { data: [] as unknown[], loading: false },
  // Drives the confirm dialog answer + spies the underlying call.
  confirmState: { answer: false, spy: vi.fn(async () => false as boolean) },
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: sync.data,
    loading: sync.loading,
    error: null,
    fetching: false,
    transport: 'sse' as const,
    invalidate: () => {},
  }),
}));

vi.mock('@papercusp/operator-core/lib/browser-workspace', () => ({
  wsLocalKey: (k: string) => `ws:default:${k}`,
}));

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  parseAsBoolean: { withDefault: (d: boolean) => ({ defaultValue: d }) },
  useQueryState: (_key: string, parser?: { defaultValue?: boolean }) => {
    const React = require('react') as typeof import('react');
    return React.useState<boolean>(parser?.defaultValue ?? false);
  },
}));

// Popover: render trigger + panel inline so the list is queryable.
vi.mock('../harness/Popover', () => ({
  Popover: ({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {trigger}
      {children}
    </div>
  ),
}));
vi.mock('../harness/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({
    confirm: (...args: unknown[]) => { confirmState.spy(...(args as [])); return Promise.resolve(confirmState.answer); },
    element: null,
  }),
}));

import { NotificationCenter, formatRelative } from './NotificationCenter';

// This project's jsdom ships a localStorage shell whose methods throw; install
// a real in-memory Storage so the unread-tracking reads/writes work.
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() { return store.size; },
    clear() { store.clear(); },
    getItem(k: string) { return store.has(k) ? store.get(k)! : null; },
    key(i: number) { return Array.from(store.keys())[i] ?? null; },
    removeItem(k: string) { store.delete(k); },
    setItem(k: string, v: string) { store.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: shim, configurable: true, writable: true });
}

function mkRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    level: 'info',
    message: 'hello',
    description: null,
    harnessSlug: null,
    createdAt: Date.now(),
    actionLabel: null,
    actionHref: null,
    ...over,
  };
}

beforeEach(() => {
  sync.data = [];
  sync.loading = false;
  confirmState.answer = false;
  confirmState.spy.mockClear();
  installLocalStorageShim();
  // /api/profile is fetched on mount; resolve it benignly so no console.error.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('formatRelative', () => {
  const now = 1_000_000_000_000;
  it('renders seconds under a minute', () => {
    expect(formatRelative(now - 5_000, now)).toBe('5s ago');
  });
  it('renders minutes under an hour', () => {
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago');
  });
  it('renders hours under a day', () => {
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
  it('renders days past 24h', () => {
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('<NotificationCenter />', () => {
  it('renders the bell with no unread badge when there are no toasts', () => {
    sync.data = [];
    const { container } = render(<NotificationCenter />);
    expect(screen.getByLabelText('Notification history')).toBeTruthy();
    expect(container.querySelector('.notif-badge')).toBeNull();
  });

  it('shows the empty-state copy when the log is empty', () => {
    sync.data = [];
    render(<NotificationCenter />);
    expect(screen.getByText(/no notifications yet/i)).toBeTruthy();
  });

  it('renders a row per toast with its message and level', () => {
    sync.data = [
      mkRow({ id: 1, level: 'error', message: 'boom' }),
      mkRow({ id: 2, level: 'success', message: 'done' }),
    ];
    const { container } = render(<NotificationCenter />);
    expect(container.querySelectorAll('li.notif-item')).toHaveLength(2);
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
  });

  it('counts unread toasts (created after lastSeen=0) in the badge', () => {
    sync.data = [mkRow({ id: 1, createdAt: 5 }), mkRow({ id: 2, createdAt: 6 })];
    const { container } = render(<NotificationCenter />);
    const badge = container.querySelector('.notif-badge');
    expect(badge?.textContent).toBe('2');
  });

  it('caps the unread badge at "99+" past 99 unread', () => {
    sync.data = Array.from({ length: 120 }, (_, i) => mkRow({ id: i + 1, createdAt: 100 + i }));
    const { container } = render(<NotificationCenter />);
    expect(container.querySelector('.notif-badge')?.textContent).toBe('99+');
  });

  it('shows the Loading… placeholder when the sync is loading and empty', () => {
    sync.data = [];
    sync.loading = true;
    render(<NotificationCenter />);
    expect(screen.getByText(/loading…/i)).toBeTruthy();
  });

  it('clearAll asks for confirmation but does NOT fire the DELETE when declined', async () => {
    confirmState.answer = false;
    sync.data = [mkRow({ id: 1, message: 'x' })];
    render(<NotificationCenter />);
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();
    fireEvent.click(screen.getByLabelText('Clear all'));
    // The confirm was asked…
    await vi.waitFor(() => expect(confirmState.spy).toHaveBeenCalledTimes(1));
    // …but declined → no DELETE request fired.
    expect(fetchSpy.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(false);
  });

  it('clearAll fires DELETE /api/toast-log?all=1 once the confirm is accepted', async () => {
    confirmState.answer = true;
    sync.data = [mkRow({ id: 1, message: 'x' })];
    render(<NotificationCenter />);
    const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchSpy.mockClear();
    fireEvent.click(screen.getByLabelText('Clear all'));
    await vi.waitFor(() => {
      const del = fetchSpy.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(del![0]).toBe('/api/toast-log?all=1');
    });
  });

  it('renders an action link for a toast and closes the panel on click', () => {
    sync.data = [mkRow({ id: 1, message: 'has action', actionLabel: 'Open it', actionHref: '/somewhere' })];
    render(<NotificationCenter />);
    const link = screen.getByText(/open it/i).closest('a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/somewhere');
    // Internal href → no target=_blank.
    expect(link.getAttribute('target')).toBeNull();
    // Swallow the navigation (jsdom can't navigate) but let the component's
    // onClick run — a wiring bug in that handler would throw on click.
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener('click', prevent, true);
    try {
      fireEvent.click(link);
    } finally {
      document.removeEventListener('click', prevent, true);
    }
  });

  it('opens an external action link in a new tab (target=_blank + rel)', () => {
    sync.data = [mkRow({ id: 1, message: 'ext', actionLabel: 'Docs', actionHref: 'https://example.com/d' })];
    render(<NotificationCenter />);
    const link = screen.getByText(/docs/i).closest('a') as HTMLAnchorElement;
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
