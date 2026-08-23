// @vitest-environment jsdom
//
// PlansPane render (owner-plans-single-pane-2026-07-17 P-002/P-007): rows
// render with their needs-you / live / progress badges, the finished toggle
// flips ?plf, and clicking a row opens the plan popup (?pplan). The data hooks
// (usePlanList / useInboxAttention / useSyncQuery roster / useWorkspaceId) and
// the heavy PlanPopupModal (→ PlanDetail) are mocked; nuqs is a seeded store.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlanListRow } from '@/app/admin/plans/plans-api';

// jsdom has no layout, so the real @tanstack/react-virtual renders zero rows
// (WI-5339 virtualization) — mock it to render every item (same seam as
// ChatConversation.test).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        key: `vk-${i}`,
        start: i * 104,
        size: 104,
      })),
    getTotalSize: () => opts.count * 104,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

const { nuqs, setters, planListData, attentionItems, rosterData, setPlanArchived, confirmAnswer, toastSpies, planListRefresh } =
  vi.hoisted(() => ({
    nuqs: {} as Record<string, unknown>,
    setters: {} as Record<string, ReturnType<typeof vi.fn>>,
    planListData: { value: null as { plans: PlanListRow[] } | null },
    attentionItems: { value: [] as Array<{ planSlug: string | null; tier: string; needsHuman?: boolean; kind?: string }> },
    rosterData: { value: [{ active: [] as Array<{ currentPlanSlug?: string | null }> }] },
    setPlanArchived: vi.fn(async (_a?: unknown) => ({ ok: true as const })),
    confirmAnswer: { value: true },
    toastSpies: { success: vi.fn(), error: vi.fn() },
    planListRefresh: vi.fn(),
  }));
function mkSetter(key: string) {
  if (!setters[key]) setters[key] = vi.fn(async (v: unknown) => { nuqs[key] = v; });
  return setters[key];
}

import { nuqsParsers } from '@papercusp/test-config/nuqs-mock';
vi.mock('nuqs', () => ({
  ...nuqsParsers,
  // Apply the parser's withDefault (stored as `_d`) when the key is unset, so a
  // component reading `query.trim()` never sees undefined (real nuqs behavior).
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d,
    mkSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
  parseAsBoolean: { withDefault: (d: unknown) => ({ _d: d }) },
}));
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ data: rosterData.value, loading: false, error: null, invalidate: vi.fn() }),
}));
vi.mock('@/app/harness/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
// The sort picker is the shared Radix Select (design-primitives allowlists ZERO
// native <select>s in app code). Radix's popup does not open under jsdom, so
// stand in a native <select> carrying the SAME testId + aria-label — the same
// seam GoalProposalCard/FleetLaunchRow/PlanFilters already use.
vi.mock('@/app/harness/Select', () => ({
  Select: ({ value, onChange, options, ariaLabel, testId }: {
    value: string;
    onChange: (v: string) => void;
    options: Array<{ value: string; label: React.ReactNode }>;
    ariaLabel?: string;
    testId?: string;
  }) => (
    <select
      aria-label={ariaLabel}
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-1' }));
// Keep bucketOf real (buildGlanceRows uses it) — only stub the data hook + the write.
vi.mock('@/app/admin/plans/plans-api', async (orig) => ({
  ...(await orig<typeof import('@/app/admin/plans/plans-api')>()),
  usePlanList: () => ({ data: planListData.value, loading: planListData.value === null, error: null, refresh: planListRefresh }),
  setPlanArchived: (a: unknown) => setPlanArchived(a),
}));
vi.mock('sonner', () => ({ toast: toastSpies }));
vi.mock('@/app/harness/useConfirmDialog', () => ({
  useConfirmDialog: () => ({ confirm: async () => confirmAnswer.value, element: null }),
}));
vi.mock('../inbox/use-inbox-pending', () => ({
  effectiveTier: (i: { tier?: string }) => i.tier ?? 'activity',
  useInboxAttention: () => ({ items: attentionItems.value, loading: false, error: null, refresh: vi.fn() }),
}));
vi.mock('./PlanPopupModal', () => ({
  default: ({ planSlug }: { planSlug: string | null }) =>
    planSlug ? <div data-testid="popup-open">{planSlug}</div> : null,
}));
// WI-5547: PlansPane warms the Vditor/Lute stack on idle after mount so the
// first plan popup opens WARM (~430ms) instead of paying the ~600ms cold WASM
// init on the click. Spy on the preload so this wiring cannot silently regress.
const { preloadVditorSpy } = vi.hoisted(() => ({ preloadVditorSpy: vi.fn(() => Promise.resolve()) }));
vi.mock('@/app/_components/MarkdownEditor', () => ({ preloadVditor: preloadVditorSpy }));
// P-001: a row click STARTS the plan-popup-open interaction timing. Spy the hook
// so the wiring (click → beginInteraction) cannot silently regress.
const { beginInteractionSpy } = vi.hoisted(() => ({ beginInteractionSpy: vi.fn() }));
vi.mock('@/app/_components/perf/perf-marks', () => ({
  beginInteraction: beginInteractionSpy,
  endInteraction: vi.fn(),
  PERF_INTERACTIONS: { planPopupOpen: 'plan-popup-open' },
}));

import PlansPane from './PlansPane';

function plan(over: Partial<PlanListRow> & { slug: string }): PlanListRow {
  return {
    slug: over.slug, title: over.title ?? over.slug, status: over.status ?? 'active',
    updated: over.updated ?? '2026-07-17T00:00:00Z',
    archived: false, isLegacy: false, itemCounts: over.itemCounts,
    harness: 'papercusp', startStatus: over.startStatus,
    // Explicit pass-through: this factory BUILDS the row rather than spreading
    // `over`, so a field omitted here is silently dropped and a test that sets it
    // asserts against undefined while looking correct.
    origin: over.origin,
    triggered: over.triggered,
    triggerSources: over.triggerSources,
  } as PlanListRow;
}

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqs)) delete nuqs[k];
  for (const setter of Object.values(setters)) setter.mockClear();
  attentionItems.value = [];
  rosterData.value = [{ active: [] }];
  confirmAnswer.value = true;
  setPlanArchived.mockClear();
  toastSpies.success.mockClear();
  toastSpies.error.mockClear();
  planListRefresh.mockClear();
  preloadVditorSpy.mockClear();
  beginInteractionSpy.mockClear();
});

/** An ISO timestamp `days` in the past — for the stale (≥14d) threshold. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe('PlansPane', () => {
  it("renders the Inbox-style masthead/count and shows the filter row EXPANDED by default, with no toggle (WI-40982)", () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-active", title: "Active plan" }),
        plan({ slug: "p-shipped", title: "Shipped plan", status: "shipped" }),
      ],
    };

    render(<PlansPane />);
    expect(screen.getByText("Plans", { selector: "strong" })).toBeTruthy();
    expect(screen.getByTestId("plans-pane-count").textContent).toBe("1");
    expect(
      screen.getByTestId("plans-pane-count").getAttribute("aria-label"),
    ).toBe("1 plans shown");

    // Owner ask 2026-08-23: filters are ALWAYS open. Both halves are pinned —
    // the row present AND the disclosure button gone — because a regression that
    // restored the button would otherwise still satisfy a presence-only check.
    const filters = screen.getByTestId("plans-pane-filters");
    expect(filters).toBeTruthy();
    expect(screen.getByTestId("plans-pane-finished-toggle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "triggered" })).toBeTruthy();
    expect(screen.queryByTestId("plans-pane-filter-toggle")).toBeNull();
    // …and nothing else claims to control it either (a leftover aria-controls
    // pointing at the row would mean some collapsed trigger survived).
    expect(
      document.querySelector('[aria-controls="plans-pane-filters"]'),
    ).toBeNull();
  });

  it("clears a populated plan search from the compact search shell (P-020)", () => {
    nuqs.plq = "blocked";
    planListData.value = {
      plans: [plan({ slug: "p1", title: "Blocked plan" })],
    };
    render(<PlansPane />);

    fireEvent.click(screen.getByRole("button", { name: "Clear plan search" }));
    expect(setters.plq).toHaveBeenCalledWith(null);
  });

  // WI-39439. The owner's split is Blender vs everything-else, so ABSENCE of this
  // badge is load-bearing: it is what says "human or standard agent". The row that
  // must stay bare is the su-ideate one — a plan an su AGENT ideated. It reaches the
  // client as `origin: undefined` (the server derivation filters to origin='scout'),
  // so a regression that re-widens that derivation to "any ledger row" shows up here
  // as a badge on p-agent, not as a type error.
  it('marks ONLY Blender-routed plans with the provenance icon (WI-39439)', () => {
    planListData.value = {
      plans: [
        plan({ slug: 'p-blender', title: 'Blender plan', origin: 'scout' }),
        plan({ slug: 'p-agent', title: 'Agent-ideated plan' }),
        plan({ slug: 'p-human', title: 'Human plan' }),
      ],
    };

    render(<PlansPane />);
    const badges = screen.getAllByTestId('plans-pane-blender-badge');
    expect(badges).toHaveLength(1);
    // The owner asked for a BLENDER glyph specifically and for it to be hard to
    // miss, so both halves are pinned: an inline svg (lucide ships no blender, so
    // this is hand-drawn and a refactor could silently drop it) and the visible
    // word. Asserting only the testid would let either regress unnoticed.
    expect(badges[0].querySelector('svg')).toBeTruthy();
    expect(badges[0].textContent).toContain('Blender');
    // Assert WHICH row carries it — a single badge on the wrong row would also
    // satisfy a bare length check.
    expect(screen.getByTestId('plans-pane-row-p-blender').contains(badges[0])).toBe(true);
    expect(screen.getByTestId('plans-pane-row-p-agent').querySelector('[data-testid="plans-pane-blender-badge"]')).toBeNull();
    expect(screen.getByTestId('plans-pane-row-p-human').querySelector('[data-testid="plans-pane-blender-badge"]')).toBeNull();
  });

  it('renders active plans with needs-you, live, and progress badges', () => {
    planListData.value = {
      plans: [
        plan({ slug: 'p-hot', title: 'Hot plan', itemCounts: { done: 2, todo: 3 } }),
        plan({ slug: 'p-cold', title: 'Cold plan' }),
      ],
    };
    attentionItems.value = [{ planSlug: 'p-hot', tier: 'decision' }];
    rosterData.value = [{ active: [{ currentPlanSlug: 'p-hot' }, { currentPlanSlug: 'p-hot' }] }];

    render(<PlansPane />);
    expect(screen.getByText('Hot plan')).toBeTruthy();
    expect(screen.getByText('Cold plan')).toBeTruthy();
    // needs-you badge (1 decision item) + live badge (2 agents) on p-hot
    expect(screen.getByTestId('plans-pane-needs-badge').textContent).toBe('1');
    expect(screen.getByTestId('plans-pane-live-badge').textContent).toContain('2');
  });

  it('filters one-time vs triggered plans and renders the trigger-source badge', () => {
    planListData.value = {
      plans: [
        plan({ slug: 'plain', title: 'Plain plan', triggered: false }),
        plan({
          slug: 'event-plan',
          title: 'Event plan',
          triggered: true,
          triggerSources: ['external', 'manual'],
        }),
      ],
    };
    nuqs.plTrigger = 'triggered';
    render(<PlansPane />);
    expect(screen.queryByText('Plain plan')).toBeNull();
    expect(screen.getByText('Event plan')).toBeTruthy();
    expect(screen.getByTestId('plans-pane-trigger-badge').textContent).toBe('event + manual');
    expect(screen.getByRole('button', { name: 'triggered' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens the plan popup (sets ?pplan) when a row is clicked', () => {
    planListData.value = { plans: [plan({ slug: 'p-open', title: 'Open me' })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByRole("button", { name: "Open plan Open me" }));
    expect(setters.pplan).toHaveBeenCalledWith('p-open');
  });

  it('starts the plan-popup-open interaction timing on a row click (P-001 wiring)', () => {
    planListData.value = { plans: [plan({ slug: 'p-open', title: 'Open me' })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId('plans-pane-row-p-open'));
    expect(beginInteractionSpy).toHaveBeenCalledWith('plan-popup-open');
  });

  it('finished toggle flips ?plf', () => {
    planListData.value = { plans: [plan({ slug: 'p1' })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId('plans-pane-finished-toggle'));
    expect(setters.plf).toHaveBeenCalledWith(true);
  });

  it('shows the active-empty message when there are no active plans', () => {
    planListData.value = { plans: [plan({ slug: 'shipped', status: 'shipped' })] };
    render(<PlansPane />);
    expect(screen.getByText(/everything is finished/i)).toBeTruthy();
  });

  it('does NOT flash "everything is finished" on a cold load with an empty plan list (WI-5338)', () => {
    // The plan feed has hydrated to an empty array before the real rows stream
    // in (loading already false). This used to flash the celebratory empty
    // state over hundreds of real active plans.
    planListData.value = { plans: [] };
    render(<PlansPane />);
    expect(screen.queryByText(/everything is finished/i)).toBeNull();
    expect(screen.getByText(/no plans yet/i)).toBeTruthy();
  });

  /* ── Stale-plan sweep: one-click archive (P-008 / EI-15304) ────────── */

  it('offers archive on a STALE row only', () => {
    planListData.value = {
      plans: [
        plan({ slug: 'p-stale', title: 'Stale plan', updated: daysAgo(30) }),
        plan({ slug: 'p-fresh', title: 'Fresh plan', updated: daysAgo(2) }),
      ],
    };
    render(<PlansPane />);
    expect(screen.getByTestId('plans-pane-archive-p-stale')).toBeTruthy();
    expect(screen.queryByTestId('plans-pane-archive-p-fresh')).toBeNull();
  });

  it('archives the plan after the confirm is accepted', async () => {
    planListData.value = { plans: [plan({ slug: 'p-stale', title: 'Stale plan', updated: daysAgo(30) })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId('plans-pane-archive-p-stale'));
    await waitFor(() => expect(setPlanArchived).toHaveBeenCalled());
    expect(setPlanArchived).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'p-stale', archived: true, harness: 'papercusp' }),
    );
    await waitFor(() => expect(toastSpies.success).toHaveBeenCalled());
    // The archived row must LEAVE the list. Verified live that the
    // harness_plans → plans.list SSE invalidation alone did not re-render it
    // within 3s, so the handler refreshes the plan feed explicitly.
    expect(planListRefresh).toHaveBeenCalled();
  });

  it('does NOT archive when the confirm is declined', async () => {
    confirmAnswer.value = false;
    planListData.value = { plans: [plan({ slug: 'p-stale', updated: daysAgo(30) })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId('plans-pane-archive-p-stale'));
    await waitFor(() => expect(confirmAnswer.value).toBe(false));
    expect(setPlanArchived).not.toHaveBeenCalled();
  });

  it('surfaces a failed archive as an error toast', async () => {
    setPlanArchived.mockResolvedValueOnce({ ok: false, error: 'plan_not_found' } as never);
    planListData.value = { plans: [plan({ slug: 'p-stale', updated: daysAgo(30) })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId('plans-pane-archive-p-stale'));
    await waitFor(() => expect(toastSpies.error).toHaveBeenCalled());
    expect(toastSpies.success).not.toHaveBeenCalled();
  });

  /* ── Vditor warm-preload regression guard (WI-5547) ─────────────────────
   * The "several seconds to load a plan" report: the first plan popup paid the
   * cold Vditor/Lute WASM init (~600ms) on the click. PlansPane now warms it on
   * an idle timer after mount. These guard that the warm-up stays (a) DEFERRED
   * off the render critical path and (b) actually scheduled — so a refactor that
   * drops the effect, or swaps back to an unreliable requestIdleCallback, reds
   * here instead of silently regressing the open latency. */

  it('schedules the Vditor preload on idle after mount, not synchronously on the render path', () => {
    vi.useFakeTimers();
    try {
      planListData.value = { plans: [plan({ slug: 'p1' })] };
      render(<PlansPane />);
      // Must NOT run during render/mount — that would put the ~600ms WASM warm
      // back on the critical path it was moved off of.
      expect(preloadVditorSpy).not.toHaveBeenCalled();
      // Fires once the idle timer elapses (a plain setTimeout, so fake timers
      // drive it — a requestIdleCallback swap, which is unreliable in the Tauri
      // WebKitGTK webview, would never fire here and fail this assertion).
      act(() => { vi.advanceTimersByTime(2000); });
      expect(preloadVditorSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels the pending preload when PlansPane unmounts before it fires', () => {
    vi.useFakeTimers();
    try {
      planListData.value = { plans: [plan({ slug: 'p1' })] };
      const { unmount } = render(<PlansPane />);
      unmount();
      act(() => { vi.advanceTimersByTime(2000); });
      // No post-unmount work: the effect cleanup clears the timer.
      expect(preloadVditorSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
