// @vitest-environment jsdom
/**
 * AdvHistoryTab `?view=archive|live` switch (plan
 * project-history-tab-desktop-and-portal-2026-09-16, P-011).
 *
 * The tab now serves TWO sources behind one surface: the git/PG `archive`
 * (a REST round-trip through /api/harness/<slug>/project-history) and `live`
 * activity (the `projectHistoryEvents.byHarness` sync resolver P-009 added).
 * This suite pins the four things that switch owes, each of which fails
 * SILENTLY on screen if it regresses:
 *
 *  1. archive is the DEFAULT — a bare `/history` must not open on live;
 *  2. `?view=live` mounts the timeline against the resolver, with the harness
 *     scope actually threaded into the query args (a hardcoded or dropped
 *     `harnessSlug` renders a plausible-looking timeline for the wrong pot);
 *  3. live does NOT pay the archive's REST round-trip. On `papercusp` that
 *     request is ~1,448 plans; firing it under the live view is invisible to a
 *     screenshot and to every render assertion, so only a request-log
 *     assertion can catch it (AdvHistoryTab.tsx: `if (view !== 'archive') return`);
 *  4. selecting Archive clears the param to `null` rather than writing
 *     `?view=archive` — the default must stay absent from the URL, or every
 *     shared link carries a redundant param.
 *
 * Both views are mocked to marker elements: each has its own suite, and what is
 * under test here is WHICH source is mounted and what it is asked for, never
 * how either renders.
 *
 * NOTE (test-config): `defineVitestConfig({ layer: 'unit' })` does NOT enable
 * `globals`, so vitest's API is imported explicitly and `cleanup()` is called by
 * hand — without it @testing-library/react leaks DOM between cases and nearly
 * every query fails "Found multiple elements".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ── nuqs: a per-key store, so `?view=` is both seedable and observable. ──
let nuqsState: Record<string, unknown> = {};
let nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
/**
 * The default is read as `defaultValue` — the key `@papercusp/test-config/nuqs-mock`
 * actually writes in `.withDefault()`. Reading `__default` (as the sibling pagination
 * suite does) yields `undefined` for EVERY key, so each unseeded param falls through
 * to `null`: `view` would arrive null rather than 'archive', the component would take
 * its non-default branch, and it would still render plausibly. `__default` is kept as
 * a fallback only so this mock survives that shape too.
 */
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { defaultValue?: unknown; __default?: unknown }) => {
    const set = vi.fn(async (v: unknown) => {
      nuqsState[key] = typeof v === 'function' ? (v as (p: unknown) => unknown)(nuqsState[key]) : v;
    });
    nuqsSetters[key] = set;
    return [nuqsState[key] ?? parser?.defaultValue ?? parser?.__default ?? null, set];
  },
}));

const advScope = { slug: 'papercusp', allMode: false } as { slug: string | null; allMode: boolean };
vi.mock('./AdvShell', () => ({ useAdvScope: () => advScope }));

/**
 * BOTH primitives must be mocked. The module is mocked wholesale, so providing
 * only `ProjectHistoryView` (as the pagination suite does — it predates the live
 * view) makes `ActivityTimelineView` undefined and the live branch throws on
 * render instead of failing an assertion.
 */
vi.mock('@papercusp/ui-primitives', () => ({
  ProjectHistoryView: ({ plans }: { plans: unknown[] }) => (
    <div data-testid="history-archive" data-plans={plans.length} />
  ),
  ActivityTimelineView: ({
    events,
    live,
  }: {
    events: Array<{ id: string; title: string; ref: string }>;
    live?: boolean;
  }) => (
    <div
      data-testid="history-live"
      data-count={events.length}
      data-live={String(Boolean(live))}
      data-refs={events.map((e) => e.ref).join(',')}
    />
  ),
}));

/** Every `useSyncQuery` argument object the live view passed, in order. */
let syncCalls: Array<{ queryName: string; args?: Record<string, unknown> }> = [];
let syncResult: { data: unknown; loading: boolean; error: unknown } = {
  data: [],
  loading: false,
  error: null,
};
vi.mock('@papercusp/sync', () => ({
  useSyncQuery: (opts: { queryName: string; args?: Record<string, unknown> }) => {
    syncCalls.push({ queryName: opts.queryName, args: opts.args });
    return syncResult;
  },
}));

import AdvHistoryTab from './AdvHistoryTab';

/** Every URL the ARCHIVE path requested — the subject for claim 3. */
let requested: string[] = [];

function archiveBody(planCount: number) {
  return {
    project: { name: 'papercusp', generatedAt: new Date(0).toISOString() },
    plans: Array.from({ length: planCount }, (_, i) => ({
      slug: `plan-${i}`,
      title: `Plan ${i}`,
      status: 'shipped',
      items: [],
      commits: [],
    })),
    page: { offset: 0, limit: planCount, total: planCount, hasMore: false },
  };
}

beforeEach(() => {
  nuqsState = {};
  nuqsSetters = {};
  syncCalls = [];
  syncResult = { data: [], loading: false, error: null };
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(String(url));
      return { ok: true, status: 200, json: async () => archiveBody(3) } as unknown as Response;
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A resolver row, in `ProjectHistoryEventRow` shape (P-009's consumer contract). */
function eventRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    eventId: 'ev-1',
    kind: 'work-item.completed',
    tsMs: Date.UTC(2026, 8, 17, 12, 0, 0),
    actor: 'su-9b321e53',
    subjectKind: 'work-item',
    subjectId: 'WI-10001645',
    title: 'Wire the live view into both apps',
    planSlug: null,
    status: 'done',
    ...over,
  };
}

describe('AdvHistoryTab view switch', () => {
  it('defaults to the archive when no ?view is present', async () => {
    render(<AdvHistoryTab />);

    await waitFor(() => expect(screen.getByTestId('history-archive')).toBeTruthy());
    expect(screen.queryByTestId('history-live')).toBeNull();
    // The default must not have been written into the URL to take effect.
    expect(nuqsState.view).toBeUndefined();
  });

  it('mounts the live timeline against projectHistoryEvents with the scoped harness', async () => {
    nuqsState.view = 'live';
    syncResult = { data: [eventRow()], loading: false, error: null };

    render(<AdvHistoryTab />);

    await waitFor(() => expect(screen.getByTestId('history-live')).toBeTruthy());
    expect(screen.queryByTestId('history-archive')).toBeNull();

    const call = syncCalls.at(-1);
    expect(call?.queryName).toBe('projectHistoryEvents.byHarness');
    // The scope must be THREADED, not hardcoded: swap the pot, get that pot.
    expect(call?.args?.harnessSlug).toBe('papercusp');

    const view = screen.getByTestId('history-live');
    expect(view.getAttribute('data-count')).toBe('1');
    // `live` drives the pulsing dot + "Ns ago"; an archive-styled live view is a defect.
    expect(view.getAttribute('data-live')).toBe('true');
    // toTimelineEvent must carry the subject through as the row's ref.
    expect(view.getAttribute('data-refs')).toBe('WI-10001645');
  });

  it('does not pay the archive round-trip while the live view is on screen', async () => {
    nuqsState.view = 'live';
    syncResult = { data: [eventRow()], loading: false, error: null };

    render(<AdvHistoryTab />);
    await waitFor(() => expect(screen.getByTestId('history-live')).toBeTruthy());

    // The whole point of gating the effect. A screenshot cannot see this.
    expect(requested.filter((u) => u.includes('/project-history'))).toEqual([]);
  });

  it('still fetches the archive exactly once in the default view', async () => {
    render(<AdvHistoryTab />);
    await waitFor(() => expect(screen.getByTestId('history-archive')).toBeTruthy());

    // Positive control for the assertion above: it must be able to observe a
    // request at all, or `toEqual([])` would pass for the wrong reason.
    const archiveCalls = requested.filter((u) => u.includes('/project-history'));
    expect(archiveCalls.length).toBe(1);
    expect(archiveCalls[0]).toContain('/api/harness/papercusp/project-history');
  });

  it('clears the param rather than writing the default when Archive is selected', async () => {
    nuqsState.view = 'live';
    syncResult = { data: [], loading: false, error: null };

    render(<AdvHistoryTab />);
    await waitFor(() => expect(screen.getByTestId('history-live')).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: 'Archive' }));

    // `null`, never the literal 'archive' — the default stays out of the URL.
    expect(nuqsSetters.view).toHaveBeenCalledWith(null);
  });

  it('selects the live view by name', async () => {
    render(<AdvHistoryTab />);
    await waitFor(() => expect(screen.getByTestId('history-archive')).toBeTruthy());

    fireEvent.click(screen.getByRole('tab', { name: 'Live activity' }));

    expect(nuqsSetters.view).toHaveBeenCalledWith('live');
  });

  it('surfaces a resolver failure as an alert instead of an empty timeline', async () => {
    nuqsState.view = 'live';
    syncResult = { data: undefined, loading: false, error: new Error('resolver exploded') };

    render(<AdvHistoryTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // An empty timeline reads as "nothing happened yet" — the opposite of the truth.
    expect(screen.queryByTestId('history-live')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('resolver exploded');
  });

  it('offers no switch until a pot is selected', async () => {
    advScope.allMode = true;
    try {
      render(<AdvHistoryTab />);
      await waitFor(() => expect(screen.getByText('Select a pot')).toBeTruthy());
      expect(screen.queryByRole('tab')).toBeNull();
    } finally {
      advScope.allMode = false;
    }
  });
});
