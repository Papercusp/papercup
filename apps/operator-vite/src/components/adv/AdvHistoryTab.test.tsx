// @vitest-environment jsdom
/**
 * AdvHistoryTab pagination (WI-10001548 defect A).
 *
 * The tab used to GET the whole archive in one unpaginated request and render
 * `document.plans` entire. On `papercusp` that is 1,448 plans / ~63MB, which no
 * webview parses — so the route now serves a page plus a `page` block, and this
 * suite pins the three things the client owes in return:
 *
 *  - it ASKS for a bounded page (a request with no `?limit` is the old defect);
 *  - "Load more" APPENDS at the right offset instead of re-fetching from 0 —
 *    re-fetching would re-transmit every page already on screen, which is the
 *    entire cost pagination exists to avoid, and it looks identical on screen;
 *  - the opened depth round-trips through nuqs (`?historyPages=`), so a reload
 *    restores it in ONE request and an agent can read it via `ui:get_state`.
 *
 * ProjectHistoryView is mocked to a plan-count marker: it has its own suite, and
 * what is under test here is which plans reach it, never how they render.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// ── nuqs: a per-key store, so ?historyPages= is observable and seedable. ──
const nuqsState: Record<string, unknown> = { historyPages: 1 };
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  useQueryState: (key: string, parser?: { __default?: unknown }) => {
    const set = vi.fn(async (v: unknown) => {
      nuqsState[key] = typeof v === 'function' ? (v as (p: unknown) => unknown)(nuqsState[key]) : v;
    });
    nuqsSetters[key] = set;
    return [nuqsState[key] ?? parser?.__default ?? null, set];
  },
}));

const advScope = { slug: 'papercusp', allMode: false } as { slug: string | null; allMode: boolean };
vi.mock('./AdvShell', () => ({ useAdvScope: () => advScope }));

vi.mock('@papercusp/ui-primitives', () => ({
  ProjectHistoryView: ({ plans }: { plans: unknown[] }) => (
    <div data-testid="history-view" data-plans={plans.length} />
  ),
}));

import AdvHistoryTab from './AdvHistoryTab';

/**
 * ASCII ESC, built from its char code.
 *
 * A RAW 0x1b in this file reds `lint:no-control-bytes` (a green-checkpoint leg) and
 * makes ripgrep treat the file as binary, so it drops out of every later search. The
 * runtime string is byte-identical either way — which is the point: the ANSI-stripping
 * assertion below must exercise a REAL escape, never the inert text `\x1b`.
 */
const ESC = String.fromCharCode(0x1b);

/** Every URL the component requested, in order — the assertion subject for offsets. */
let requested: string[] = [];

function planPage(offset: number, count: number, total: number) {
  return {
    schemaVersion: 2,
    project: { id: 'papercusp', name: 'Papercusp', repository: null },
    source: { kind: 'papercusp-plan-export', planCount: count },
    plans: Array.from({ length: count }, (_value, index) => ({
      slug: `plan-${offset + index}`,
      title: `Plan ${offset + index}`,
      items: [],
      decisions: [],
      completedItems: [],
    })),
    page: { count, total, offset, limit: 20, hasMore: offset + count < total },
  };
}

beforeEach(() => {
  requested = [];
  nuqsState.historyPages = 1;
  advScope.slug = 'papercusp';
  advScope.allMode = false;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requested.push(url);
    const parsed = new URL(url, 'http://localhost');
    const offset = Number(parsed.searchParams.get('offset') ?? 0);
    const limit = Number(parsed.searchParams.get('limit') ?? 20);
    const total = 1448;
    return {
      ok: true,
      status: 200,
      json: async () => planPage(offset, Math.min(limit, total - offset), total),
    };
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AdvHistoryTab pagination', () => {
  it('requests a bounded first page and reports the archive total', async () => {
    render(<AdvHistoryTab />);

    await waitFor(() => expect(screen.getByTestId('history-view')).toBeTruthy());
    expect(requested).toHaveLength(1);
    // The defect was a request carrying NO bound at all; assert the bound is present
    // and is one page, not merely that some query string exists.
    expect(requested[0]).toContain('limit=20');
    expect(requested[0]).toContain('offset=0');
    expect(screen.getByTestId('history-view').getAttribute('data-plans')).toBe('20');
    expect(screen.getByText(/Showing 20 of 1448 plans\./)).toBeTruthy();
  });

  it('appends the next page at the loaded offset instead of re-fetching from zero', async () => {
    render(<AdvHistoryTab />);
    await waitFor(() => expect(screen.getByTestId('history-view')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /Load 20 more/ }));

    await waitFor(() => expect(screen.getByTestId('history-view').getAttribute('data-plans')).toBe('40'));
    expect(requested).toHaveLength(2);
    // offset=20 is the whole point: a second `offset=0` would render the same 40
    // plans while re-transmitting the first page.
    expect(requested[1]).toContain('offset=20');
    expect(requested[1]).toContain('limit=20');
    expect(screen.getByText(/Showing 40 of 1448 plans\./)).toBeTruthy();
    // The opened depth is URL state, not useState — otherwise a reload loses it and
    // `ui:get_state` cannot see it.
    expect(nuqsState.historyPages).toBe(2);
  });

  it('restores an already-opened depth in ONE request rather than replaying clicks', async () => {
    nuqsState.historyPages = 3;
    render(<AdvHistoryTab />);

    await waitFor(() => expect(screen.getByTestId('history-view').getAttribute('data-plans')).toBe('60'));
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('limit=60');
  });

  it('clamps a restore to the route cap so a hand-edited URL cannot ask for the archive', async () => {
    nuqsState.historyPages = 999;
    render(<AdvHistoryTab />);

    await waitFor(() => expect(screen.getByTestId('history-view')).toBeTruthy());
    expect(requested[0]).toContain('limit=100');
  });

  it('hides Load more once the last page is in hand', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      return { ok: true, status: 200, json: async () => planPage(0, 12, 12) };
    }));
    render(<AdvHistoryTab />);

    await waitFor(() => expect(screen.getByTestId('history-view')).toBeTruthy());
    expect(screen.getByText(/Showing 12 of 12 plans\./)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull();
  });

  it('surfaces a route failure as an error with ANSI stripped, not an empty archive', async () => {
    const coloured = `${ESC}[31mplan read failed${ESC}[0m`;
    // Guard the instrument itself: if this fixture ever degrades to the inert text
    // `\x1b`, the strip assertion below passes while testing nothing.
    expect(coloured.charCodeAt(0)).toBe(27);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: coloured, code: 'plan-read-failed' }),
    })));
    render(<AdvHistoryTab />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('plan read failed');
    expect(screen.getByRole('alert').textContent).not.toContain('[31m');
  });
});
