// @vitest-environment jsdom
//
// OperatorActionLog — the harness-scoped log of long-running user actions.
// PURE helpers (formatRelative / formatElapsed / isOpenableHref /
// parseSummaryMeta) are extracted + exported and tested branch-by-branch;
// the component render-smoke drives a mocked @papercusp/sync so we can assert
// the empty / no-slug / populated surfaces without a live transport.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Hoisted mutable holder for the sync-query result the factory closes over.
const { sync } = vi.hoisted(() => ({
  sync: { data: [] as unknown[], loading: false, error: null as Error | null },
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: sync.data,
    loading: sync.loading,
    error: sync.error,
    fetching: false,
    transport: 'sse' as const,
    invalidate: () => {},
  }),
}));

vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'default' }));

// auto-animate touches layout APIs jsdom doesn't fully implement; the hook
// just returns a ref setter, so a no-op ref is a faithful stand-in.
vi.mock('@formkit/auto-animate/react', () => ({
  useAutoAnimate: () => [(() => {}) as unknown as (el: HTMLElement | null) => void],
}));

import {
  OperatorActionLog,
  formatRelative,
  formatElapsed,
  isOpenableHref,
  parseSummaryMeta,
  type UserAction,
} from './OperatorActionLog';

function resetSync() {
  sync.data = [];
  sync.loading = false;
  sync.error = null;
  // The component pins the last-seen rows into a module-global prefetch cache
  // (survives mount/unmount). Clear it so a prior test's rows don't seed the
  // next render (the seed would mask the empty/error branches).
  (globalThis as { __recentActionsCache?: Map<string, unknown> }).__recentActionsCache?.clear();
}

beforeEach(resetSync);
afterEach(() => {
  cleanup();
  resetSync();
});

describe('formatRelative', () => {
  const now = 1_000_000_000_000;
  it('returns "just now" under a second', () => {
    expect(formatRelative(now - 500, now)).toBe('just now');
  });
  it('clamps a future timestamp to "just now" (never negative)', () => {
    expect(formatRelative(now + 5000, now)).toBe('just now');
  });
  it('formats seconds, minutes, hours, and days', () => {
    expect(formatRelative(now - 5_000, now)).toBe('5s ago');
    expect(formatRelative(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});

describe('formatElapsed', () => {
  const now = 1_000_000_000_000;
  it('renders "<1s" for sub-second spans', () => {
    expect(formatElapsed(now - 300, null, now)).toBe('<1s');
  });
  it('renders whole seconds under a minute', () => {
    expect(formatElapsed(now - 12_000, null, now)).toBe('12s');
  });
  it('renders "Nm Ns" past a minute', () => {
    expect(formatElapsed(now - (2 * 60_000 + 4_000), null, now)).toBe('2m 4s');
  });
  it('uses finishedAt when present rather than now', () => {
    const started = now - 100_000;
    const finished = started + 9_000;
    expect(formatElapsed(started, finished, now)).toBe('9s');
  });
});

describe('isOpenableHref', () => {
  it('accepts http(s) URLs, hashes, and route paths', () => {
    expect(isOpenableHref('https://example.com')).toBe(true);
    expect(isOpenableHref('http://x.test/y')).toBe(true);
    expect(isOpenableHref('#anchor')).toBe(true);
    expect(isOpenableHref('/harness/foo')).toBe(true);
  });
  it('rejects empty/nullish and filesystem-looking paths', () => {
    expect(isOpenableHref(null)).toBe(false);
    expect(isOpenableHref(undefined)).toBe(false);
    expect(isOpenableHref('')).toBe(false);
    expect(isOpenableHref('/home/avi/.papercusp/runs/foo.log')).toBe(false);
    expect(isOpenableHref('/var/log/x')).toBe(false);
    expect(isOpenableHref('relative/path')).toBe(false);
  });
});

describe('parseSummaryMeta', () => {
  it('returns all-null for an empty summary', () => {
    expect(parseSummaryMeta(null)).toEqual({ cleaned: null, duration: null, cost: null });
  });
  it('extracts a duration token and cleans the summary', () => {
    const r = parseSummaryMeta('completed (9s)');
    expect(r.duration).toBe('9s');
    expect(r.cleaned).toBe('completed');
    expect(r.cost).toBeNull();
  });
  it('extracts a multi-unit duration token', () => {
    const r = parseSummaryMeta('done (2m 4s)');
    expect(r.duration).toBe('2m 4s');
    expect(r.cleaned).toBe('done');
  });
  it('extracts a cost token', () => {
    const r = parseSummaryMeta('replan · cost=0.044');
    expect(r.cost).toBe('0.044');
    expect(r.cleaned).toBe('replan');
  });
  it('extracts duration AND cost together, leaving clean text', () => {
    const r = parseSummaryMeta('cleanup (12s) · cost=0.1');
    expect(r.duration).toBe('12s');
    expect(r.cost).toBe('0.1');
    expect(r.cleaned).toBe('cleanup');
  });
  it('returns cleaned:null when nothing but tokens remain', () => {
    const r = parseSummaryMeta('(5s)');
    expect(r.duration).toBe('5s');
    expect(r.cleaned).toBeNull();
  });
});

function mkAction(over: Partial<UserAction> = {}): UserAction {
  return {
    id: 1,
    kind: 'replan',
    status: 'succeeded',
    summary: 'replan complete (9s)',
    detailUrl: null,
    errorText: null,
    invocationId: null,
    startedAt: Date.now() - 10_000,
    finishedAt: Date.now() - 1_000,
    actor: null,
    ...over,
  };
}

describe('<OperatorActionLog />', () => {
  it('prompts to pick a harness when slug is null', () => {
    render(<OperatorActionLog slug={null} />);
    expect(screen.getByText(/pick a harness/i)).toBeTruthy();
  });

  it('shows the empty-state copy when there are no actions', () => {
    sync.data = [];
    render(<OperatorActionLog slug="my-harness" />);
    expect(screen.getByText(/no actions yet/i)).toBeTruthy();
  });

  it('renders a row per action with its kind and parsed duration pill', () => {
    sync.data = [mkAction({ id: 1, kind: 'replan' }), mkAction({ id: 2, kind: 'cleanup' })];
    const { container } = render(<OperatorActionLog slug="my-harness" />);
    expect(container.querySelectorAll('li.notif-item')).toHaveLength(2);
    expect(screen.getByText('replan')).toBeTruthy();
    expect(screen.getByText('cleanup')).toBeTruthy();
    // The "(9s)" token is parsed out into a standalone duration pill.
    expect(screen.getAllByTitle('Run duration').length).toBeGreaterThan(0);
  });

  it('renders an error surface with a retry button when sync errors and there is no data', () => {
    sync.error = new Error('boom');
    render(<OperatorActionLog slug="my-harness" />);
    expect(screen.getByText(/could not load action log/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('shows the loading placeholder when sync is loading with no rows', () => {
    sync.loading = true;
    sync.data = [];
    render(<OperatorActionLog slug="my-harness" />);
    expect(screen.getByText(/loading actions/i)).toBeTruthy();
  });

  it('still renders rows (not the error surface) when sync errors BUT data is present', () => {
    sync.error = new Error('transient');
    sync.data = [mkAction({ id: 7, kind: 'snapshot' })];
    render(<OperatorActionLog slug="my-harness" />);
    // error + data → the list wins; no error banner.
    expect(screen.queryByText(/could not load action log/i)).toBeNull();
    expect(screen.getByText('snapshot')).toBeTruthy();
  });

  it('renders an openable detail link as an anchor, and hides it for filesystem-path detailUrls', () => {
    sync.data = [
      mkAction({ id: 1, kind: 'with-link', detailUrl: 'https://example.com/run/1', summary: 'ok' }),
      mkAction({ id: 2, kind: 'fs-path', detailUrl: '/home/avi/.papercusp/runs/x.log', summary: 'ok' }),
    ];
    render(<OperatorActionLog slug="my-harness" />);
    const links = screen.getAllByText(/open ↗/);
    // Only the http(s) row gets an "open" link; the filesystem path is filtered.
    expect(links).toHaveLength(1);
    const a = links[0].closest('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com/run/1');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders the error text (truncated, in the bad color) for a failed action', () => {
    sync.data = [mkAction({ id: 1, kind: 'replan', status: 'failed', errorText: 'exploded mid-run', summary: null })];
    render(<OperatorActionLog slug="my-harness" />);
    expect(screen.getByText('exploded mid-run')).toBeTruthy();
  });

  it('falls back to a "(no summary)" placeholder when a succeeded action has no summary and no error', () => {
    sync.data = [mkAction({ id: 1, kind: 'cleanup', status: 'succeeded', summary: null, errorText: null })];
    render(<OperatorActionLog slug="my-harness" />);
    expect(screen.getByText('(no summary)')).toBeTruthy();
  });

  it('renders the cost pill when the summary carries a cost token', () => {
    sync.data = [mkAction({ id: 1, kind: 'replan', summary: 'replan (12s) · cost=0.044' })];
    render(<OperatorActionLog slug="my-harness" />);
    expect(screen.getByTitle('Run cost (USD)')).toBeTruthy();
    expect(screen.getByText('0.044')).toBeTruthy();
  });

  it('marks a running action with the running level class and a live elapsed duration', () => {
    sync.data = [mkAction({ id: 1, kind: 'replan', status: 'running', finishedAt: null, summary: 'in flight' })];
    const { container } = render(<OperatorActionLog slug="my-harness" />);
    // The row carries the status-keyed class…
    expect(container.querySelector('li.notif-item--running')).toBeTruthy();
    // …and a live elapsed duration pill (running rows show the fallback counter).
    expect(screen.getByTitle('Run duration')).toBeTruthy();
  });
});
