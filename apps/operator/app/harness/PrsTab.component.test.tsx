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
import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', async () => {
  const React = await import('react');
  return {
    ...nuqsParsers,
    useQueryState: (_key: string, parser?: { __default?: unknown }) =>
      React.useState(parser?.__default ?? null),
    parseAsStringLiteral: () => ({ withDefault: (d: unknown) => ({ __default: d }) }),
    // P-049 added `prs_settings` via `parseAsBoolean.withDefault(false)`. Unlike
    // parseAsStringLiteral, parseAsBoolean is a bare parser object (not a factory).
    parseAsBoolean: { withDefault: (d: unknown) => ({ __default: d }) },
    // PR-3 added `prs_selected` via bare `parseAsInteger` (no withDefault).
    parseAsInteger: { __default: null },
  };
});

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { PrsTab, rowBelongsToViewedHarness, shouldShowAutoStatus } from './PrsTab';

describe('rowBelongsToViewedHarness — hive-scope auto-status honesty (PR-3 §4)', () => {
  it('single-harness rows (no member_slug) always belong', () => {
    expect(rowBelongsToViewedHarness({}, 'acme')).toBe(true);
    expect(rowBelongsToViewedHarness({ member_slug: undefined }, 'acme')).toBe(true);
  });
  it("a hive-scope row of the viewed harness belongs", () => {
    expect(rowBelongsToViewedHarness({ member_slug: 'acme' }, 'acme')).toBe(true);
  });
  it("a hive-scope row from a DIFFERENT member does NOT belong (suppress its auto-status)", () => {
    expect(rowBelongsToViewedHarness({ member_slug: 'other-member' }, 'acme')).toBe(false);
  });
});

describe('shouldShowAutoStatus — viewed harness AND open only (PR-3 §4)', () => {
  it('shows for an open PR of the viewed harness', () => {
    expect(shouldShowAutoStatus({ state: 'open' }, 'acme')).toBe(true);
    expect(shouldShowAutoStatus({ member_slug: 'acme', state: 'open' }, 'acme')).toBe(true);
  });
  it('suppresses for non-open PRs (merged/closed/gone) — state badge speaks, no "blocked" noise', () => {
    expect(shouldShowAutoStatus({ state: 'merged' }, 'acme')).toBe(false);
    expect(shouldShowAutoStatus({ state: 'closed' }, 'acme')).toBe(false);
    expect(shouldShowAutoStatus({ state: 'gone' }, 'acme')).toBe(false);
  });
  it('suppresses for a different member even when open (settings not held)', () => {
    expect(shouldShowAutoStatus({ member_slug: 'other', state: 'open' }, 'acme')).toBe(false);
  });
});

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

// ── PR-3: owner-gated auto-mode toggle ────────────────────────────────

/** A fetch mock that routes by URL: /prs (empty), /pr-reviewer-settings (gate),
 *  /claim-status (claim). `autoModeEditable` drives whether the toggle is live. */
function routedFetch(opts: { autoModeEditable: boolean; autoOn?: boolean }) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/pr-reviewer-settings')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          settings: {
            pr_reviewer_role_enabled: !!opts.autoOn,
            auto_review: !!opts.autoOn,
            auto_merge: !!opts.autoOn,
            merge_method: 'squash',
          },
          trustList: [],
          audit: [],
          viewer: { github_user_id: 1, github_login: 'owner' },
          editable: true,
          claimOwner: opts.autoModeEditable,
          autoModeEditable: opts.autoModeEditable,
        }),
      } as unknown as Response;
    }
    if (u.includes('/claim-status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'unclaimed', viewer_can_claim: true, claimants: [] }),
      } as unknown as Response;
    }
    // /prs and anything else
    return {
      ok: true,
      status: 200,
      json: async () => ({ prs: [], pollingFailedAt: null, noRemote: false }),
    } as unknown as Response;
  });
}

describe('PrsTab — auto-mode toggle is claimed-owner gated (PR-3)', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('a non-owner sees the auto toggle READ-ONLY (disabled)', async () => {
    vi.stubGlobal('fetch', routedFetch({ autoModeEditable: false }));
    const { findByLabelText } = render(<PrsTab harnessSlug="acme" />);
    const toggle = (await findByLabelText('Auto-apply agent recommendations')) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(true));
  });

  it('a claimed owner can flip the auto toggle (enabled)', async () => {
    vi.stubGlobal('fetch', routedFetch({ autoModeEditable: true, autoOn: false }));
    const { findByLabelText } = render(<PrsTab harnessSlug="acme" />);
    const toggle = (await findByLabelText('Auto-apply agent recommendations')) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('reflects auto-mode ON when role + both auto levers are set', async () => {
    vi.stubGlobal('fetch', routedFetch({ autoModeEditable: true, autoOn: true }));
    const { findByLabelText } = render(<PrsTab harnessSlug="acme" />);
    const toggle = (await findByLabelText('Auto-apply agent recommendations')) as HTMLButtonElement;
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));
  });
});
