// @vitest-environment jsdom
/**
 * PrsTab component-level regression test.
 *
 * Guards the render-loop fix: PrsTab is mounted by AdvPrsPanel /
 * AdvHarnessPanelPage as `<PrsTab harnessSlug={slug} />` with NO
 * `trustedAuthorIds` prop, so the default param applied. When that default
 * was `new Set()` (a fresh reference every render) and `load` listed it in its
 * useCallback deps, `useEffect(() => void load(), [load])` re-fired on every
 * render — an infinite reload loop that stormed /api/harness/<slug>/prs (a
 * single mount was observed firing 194 requests) and wedged the webview's
 * connection pool, leaving the panel stuck on "Loading…".
 *
 * The fix decouples fetching (keyed on harnessSlug only) from the per-row
 * trusted/reviewerRoleEnabled enrichment (now a render-time memo). This test
 * asserts a single mount fetches exactly once and a parent re-render does not
 * refetch.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

beforeAll(() => {
  if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

// nuqs needs an adapter at runtime; stub useQueryState to plain useState so the
// component is testable in isolation (matches the next/navigation mock pattern
// used by the other component tests).
vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    useQueryState: (_key: string, parser?: { __default?: unknown }) =>
      React.useState(parser?.__default ?? null),
    parseAsStringLiteral: () => ({ withDefault: (d: unknown) => ({ __default: d }) }),
    // P-049 added `prs_settings` via `parseAsBoolean.withDefault(false)`. Unlike
    // parseAsStringLiteral, parseAsBoolean is a bare parser object (not a factory).
    parseAsBoolean: { withDefault: (d: unknown) => ({ __default: d }) },
  };
});

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { PrsTab } from './PrsTab';

function countPrsCalls(spy: ReturnType<typeof vi.fn>): number {
  return spy.mock.calls.filter((c) => String(c[0]).includes('/prs')).length;
}

describe('PrsTab — no render-loop refetch (regression)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ prs: [], pollingFailedAt: null, noRemote: false }),
      }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('fetches /prs exactly once on mount (default trustedAuthorIds does not loop)', async () => {
    render(<PrsTab harnessSlug="acme" />);

    // settle: the empty state replaces "Loading…"
    await waitFor(() => {
      expect(document.body.textContent).toContain('No PRs match this filter.');
    });

    // Give any stray render→effect cycles a chance to fire, then assert it
    // stayed at a single request (the bug fired dozens-to-hundreds here).
    await new Promise((r) => setTimeout(r, 50));
    expect(countPrsCalls(fetchSpy)).toBe(1);
  });

  it('does not refetch when the parent re-renders with a fresh default', async () => {
    const view = render(<PrsTab harnessSlug="acme" />);
    await waitFor(() => expect(document.body.textContent).toContain('No PRs match this filter.'));
    expect(countPrsCalls(fetchSpy)).toBe(1);

    // Re-render the same element — a new render pass (and thus a new default
    // `new Set()`) must NOT trigger another fetch.
    view.rerender(<PrsTab harnessSlug="acme" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(countPrsCalls(fetchSpy)).toBe(1);
  });
});
