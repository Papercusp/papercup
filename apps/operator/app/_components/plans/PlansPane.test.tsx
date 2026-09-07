// @vitest-environment jsdom
//
// PlansPane render (owner-plans-single-pane-2026-07-17 P-002/P-007): rows
// render with their needs-you / live / progress badges, the finished toggle
// flips ?plf, and clicking a row opens the plan DASHBOARD app-pane takeover
// (?pdash — plan-visibility-revamp-2026-08-23 P-005/D-002). The data hooks
// (usePlanList / useInboxAttention / useSyncQuery roster / useWorkspaceId) and
// the heavy PlanPopupModal (→ PlanDetail) are mocked; nuqs is a seeded store.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PlanListRow } from "@/app/admin/plans/plans-api";

// jsdom has no layout, so the real @tanstack/react-virtual renders zero rows
// (WI-5339 virtualization) — mock it to render every item (same seam as
// the shared PapercupChat tests).
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

const {
  nuqs,
  setters,
  planListData,
  attentionItems,
  rosterData,
  workActivityData,
  cleanupFlag,
  setPlanArchived,
  confirmAnswer,
  toastSpies,
  planListRefresh,
} = vi.hoisted(() => ({
  nuqs: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>,
  planListData: { value: null as { plans: PlanListRow[] } | null },
  attentionItems: {
    value: [] as Array<{
      planSlug: string | null;
      tier: string;
      needsHuman?: boolean;
      kind?: string;
    }>,
  },
  rosterData: {
    value: [{ active: [] as Array<{ currentPlanSlug?: string | null }> }],
  },
  workActivityData: {
    value: [] as Array<{ slug: string; lastWorkAtMs: number }>,
  },
  cleanupFlag: { value: true },
  setPlanArchived: vi.fn(async (_a?: unknown) => ({ ok: true as const })),
  confirmAnswer: { value: true },
  toastSpies: { success: vi.fn(), error: vi.fn() },
  planListRefresh: vi.fn(),
}));
function mkSetter(key: string) {
  if (!setters[key])
    setters[key] = vi.fn(async (v: unknown) => {
      nuqs[key] = v;
    });
  return setters[key];
}

import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  // Apply the parser's withDefault (stored as `_d`) when the key is unset, so a
  // component reading `query.trim()` never sees undefined (real nuqs behavior).
  useQueryState: (key: string, parser?: { _d?: unknown }) => [
    nuqs[key] !== undefined ? nuqs[key] : parser?._d,
    mkSetter(key),
  ],
  parseAsString: { withDefault: (d: unknown) => ({ _d: d }) },
  parseAsBoolean: { withDefault: (d: unknown) => ({ _d: d }) },
  parseAsStringEnum: () => ({ withDefault: (d: unknown) => ({ _d: d }) }),
}));
vi.mock("@papercusp/sync", () => ({
  onSyncBusEvent: () => () => {},
  // PlansPane → PlanDashboardHost (the ?pdash param constant, P-005) →
  // operator-core lazy-with-retry, which RE-EXPORTS from @papercusp/sync — so
  // this mock must supply it or module evaluation throws "lazyWithRetry is not
  // a function" at collection. The lazy dashboard IS rendered by the split
  // layout's aside (portal-work-two-pane-2026-09-01 P-002), so the stub echoes
  // the props the aside passes and exposes its `onBack`.
  lazyWithRetry:
    () =>
    (props: {
      planSlug: string;
      harnessSlug: string | null;
      onBack: () => void;
    }) => (
      <div
        data-testid="plan-dashboard-stub"
        data-plan={props.planSlug}
        data-harness={props.harnessSlug ?? ""}
      >
        <button
          type="button"
          data-testid="plan-dashboard-back"
          onClick={props.onBack}
        >
          back
        </button>
      </div>
    ),
  // Branched by queryName: the pane now runs TWO sync queries (advRoster.list
  // + planWorkActivity.list, P-002) — a queryName-blind mock would feed the
  // roster payload to the work-activity join and silently render no ⚒ times.
  useSyncQuery: ({ queryName }: { queryName: string }) => ({
    data:
      queryName === "planWorkActivity.list"
        ? workActivityData.value
        : rosterData.value,
    loading: false,
    error: null,
    invalidate: vi.fn(),
  }),
}));
vi.mock("@/app/harness/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// The sort picker is the shared Radix Select (design-primitives allowlists ZERO
// native <select>s in app code). Radix's popup does not open under jsdom, so
// stand in a native <select> carrying the SAME testId + aria-label — the same
// seam GoalProposalCard/FleetLaunchRow/PlanFilters already use.
vi.mock("@/app/harness/Select", () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    testId,
  }: {
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
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/lib/use-workspace-id", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@/lib/flag-hooks", () => ({ useFlag: () => cleanupFlag.value }));
// Keep bucketOf real (buildGlanceRows uses it) — only stub the data hook + the write.
vi.mock("@/app/admin/plans/plans-api", async (orig) => ({
  ...(await orig<typeof import("@/app/admin/plans/plans-api")>()),
  usePlanList: () => ({
    data: planListData.value,
    loading: planListData.value === null,
    error: null,
    refresh: planListRefresh,
  }),
  setPlanArchived: (a: unknown) => setPlanArchived(a),
}));
vi.mock("sonner", () => ({ toast: toastSpies }));
vi.mock("@/app/harness/useConfirmDialog", () => ({
  useConfirmDialog: () => ({
    confirm: async () => confirmAnswer.value,
    element: null,
  }),
}));
vi.mock("../inbox/use-inbox-pending", () => ({
  effectiveTier: (i: { tier?: string }) => i.tier ?? "activity",
  useInboxAttention: () => ({
    items: attentionItems.value,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("./PlanPopupModal", () => ({
  default: ({
    planSlug,
    origin,
    ownerIdentity,
  }: {
    planSlug: string | null;
    origin?: "scout" | null;
    ownerIdentity?: PlanListRow["ownerIdentity"] | null;
  }) =>
    planSlug ? (
      <div
        data-testid="popup-open"
        data-origin={origin ?? "user"}
        data-owner={ownerIdentity?.handle ?? "User"}
      >
        {planSlug}
      </div>
    ) : null,
}));
// WI-5547: PlansPane warms the Vditor/Lute stack on idle after mount so the
// first plan popup opens WARM (~430ms) instead of paying the ~600ms cold WASM
// init on the click. Spy on the preload so this wiring cannot silently regress.
const { preloadVditorSpy } = vi.hoisted(() => ({
  preloadVditorSpy: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/app/_components/MarkdownEditor", () => ({
  preloadVditor: preloadVditorSpy,
}));
// P-001: a row click STARTS the plan-popup-open interaction timing. Spy the hook
// so the wiring (click → beginInteraction) cannot silently regress.
const { beginInteractionSpy } = vi.hoisted(() => ({
  beginInteractionSpy: vi.fn(),
}));
vi.mock("@/app/_components/perf/perf-marks", () => ({
  beginInteraction: beginInteractionSpy,
  endInteraction: vi.fn(),
  PERF_INTERACTIONS: { planPopupOpen: "plan-popup-open" },
}));

import PlansPane from "./PlansPane";

function plan(over: Partial<PlanListRow> & { slug: string }): PlanListRow {
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    status: over.status ?? "active",
    updated: over.updated ?? "2026-07-17T00:00:00Z",
    archived: false,
    isLegacy: false,
    itemCounts: over.itemCounts,
    harness: "papercusp",
    startStatus: over.startStatus,
    // Explicit pass-through: this factory BUILDS the row rather than spreading
    // `over`, so a field omitted here is silently dropped and a test that sets it
    // asserts against undefined while looking correct.
    origin: over.origin,
    ownerIdentity: over.ownerIdentity,
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
  workActivityData.value = [];
  cleanupFlag.value = true;
  confirmAnswer.value = true;
  setPlanArchived.mockClear();
  toastSpies.success.mockClear();
  toastSpies.error.mockClear();
  planListRefresh.mockClear();
  preloadVditorSpy.mockClear();
  beginInteractionSpy.mockClear();
  vi.unstubAllGlobals();
});

/** An ISO timestamp `days` in the past — for the stale (≥14d) threshold. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** The pane now hydrates its persisted resolver profile before a start. Keep
 * that GET distinct from the actual run POST so these tests assert the route
 * they mean instead of accidentally treating the hydration response as one. */
function resolverAwareFetch(runId: string) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input) === "/api/agent-config"
      ? {
          ok: true,
          json: async () => ({
            config: {
              resolverProfiles: {
                "plan-cleanup": {
                  model: null,
                  effort: null,
                  account: "default",
                  carry: "warm",
                },
              },
            },
          }),
        }
      : {
          ok: true,
          json: async () => ({
            ok: true,
            runId,
            launched: true,
            resolverNeeded: true,
          }),
        },
  );
}

describe("PlansPane", () => {
  it("renders the Inbox-style masthead/count and shows the filter row EXPANDED by default, with no toggle (WI-40982)", () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-active", title: "Active plan" }),
        plan({ slug: "p-shipped", title: "Shipped plan", status: "shipped" }),
      ],
    };

    render(<PlansPane />);
    expect(screen.getByText("Plan workspace")).toBeTruthy();
    expect(screen.getByText("Plans", { selector: "strong" })).toBeTruthy();
    expect(screen.getByTestId("plans-pane-count-value").textContent).toBe("1");
    expect(screen.getByTestId("plans-pane-count").textContent).toContain(
      "shown",
    );
    expect(
      screen.getByTestId("plans-pane-count").getAttribute("aria-label"),
    ).toBe("1 plan shown");
    expect(screen.getByTestId("plans-pane-visible-scope").textContent).toBe(
      "1 shown · active only",
    );
    expect(
      screen.getByRole("region", { name: "Plan search and filters" }),
    ).toBeTruthy();

    // Owner ask 2026-08-23: filters are ALWAYS open. Both halves are pinned —
    // the row present AND the disclosure button gone — because a regression that
    // restored the button would otherwise still satisfy a presence-only check.
    const filters = screen.getByTestId("plans-pane-filters");
    expect(filters).toBeTruthy();
    expect(screen.getByTestId("plans-pane-finished-toggle")).toBeTruthy();
    expect(screen.getByRole("button", { name: "triggered" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Plan source" })).toBeTruthy();
    expect(screen.queryByTestId("plans-pane-filter-toggle")).toBeNull();
    // …and nothing else claims to control it either (a leftover aria-controls
    // pointing at the row would mean some collapsed trigger survived).
    expect(
      document.querySelector('[aria-controls="plans-pane-filters"]'),
    ).toBeNull();
  });

  it("mounts the clean-up strip under the masthead with the exact shown-plan count and deep-links the new run", async () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-active", title: "Active plan" }),
        plan({ slug: "p-ready", title: "Ready plan", status: "ready" }),
        plan({ slug: "p-shipped", title: "Shipped plan", status: "shipped" }),
      ],
    };
    const fetchMock = resolverAwareFetch("cleanup-run-1");
    vi.stubGlobal("fetch", fetchMock);

    render(<PlansPane />);
    const start = screen.getByTestId(
      "plans-cleanup-start",
    ) as HTMLButtonElement;
    expect(start.textContent).toContain("Clean up 2 shown plans");
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);

    await waitFor(() =>
      expect(setters.opcln).toHaveBeenCalledWith("cleanup-run-1"),
    );
    const startCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/admin/plan-cleanup",
    )!;
    const body = JSON.parse((startCall[1] as RequestInit).body as string);
    expect(body.planSlugs).toEqual(["p-active", "p-ready"]);
  });

  it("starts the same clean-up machinery from a single plan row", async () => {
    planListData.value = {
      plans: [plan({ slug: "p-active", title: "Active plan" })],
    };
    const fetchMock = resolverAwareFetch("cleanup-row-1");
    vi.stubGlobal("fetch", fetchMock);

    render(<PlansPane />);
    fireEvent.click(screen.getByTestId("plans-pane-cleanup-p-active"));

    await waitFor(() =>
      expect(setters.opcln).toHaveBeenCalledWith("cleanup-row-1"),
    );
    const startCall = fetchMock.mock.calls.find(
      ([url]) => url === "/api/admin/plan-cleanup",
    )!;
    expect(JSON.parse((startCall[1] as RequestInit).body as string)).toEqual({
      op: "start",
      planSlugs: ["p-active"],
      filter: {
        scope: "single-plan",
        entryPoint: "plans-row",
        shownCount: 1,
        planSlug: "p-active",
        harness: "papercusp",
      },
      harness: "papercusp",
      launch: { model: null, effort: null, account: "default", carry: "warm" },
    });
  });

  it("removes the clean-up strip entirely when its default-on flag is overridden off", () => {
    cleanupFlag.value = false;
    planListData.value = { plans: [plan({ slug: "p-active" })] };
    render(<PlansPane />);
    expect(screen.queryByTestId("plans-cleanup-idle")).toBeNull();
    expect(screen.queryByTestId("plans-pane-cleanup-p-active")).toBeNull();
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

  it("labels every row Blender or with the resolved plan-owner handle", () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-blender", title: "Blender plan", origin: "scout" }),
        plan({
          slug: "p-agent",
          title: "Agent-authored plan",
          ownerIdentity: {
            id: "agent-rin",
            handle: "Rin",
            kind: "agent",
            verified: true,
          },
        }),
        plan({
          slug: "p-human",
          title: "Human plan",
          ownerIdentity: {
            id: "avi",
            handle: "Avi",
            kind: "human",
            verified: true,
          },
        }),
        plan({ slug: "p-fallback", title: "Unresolved owner plan" }),
      ],
    };

    render(<PlansPane />);
    const sourceBadges = screen.getAllByTestId("plans-pane-source-badge");
    const blender = sourceBadges.filter(
      (badge) => badge.getAttribute("data-plan-provenance") === "blender",
    );
    const user = sourceBadges.filter(
      (badge) => badge.getAttribute("data-plan-provenance") === "user",
    );
    expect(blender).toHaveLength(1);
    expect(user).toHaveLength(3);
    // The owner asked for a BLENDER glyph specifically and for it to be hard to
    // miss, so both halves are pinned: an inline svg (lucide ships no blender, so
    // this is hand-drawn and a refactor could silently drop it) and the visible
    // word. Asserting only the testid would let either regress unnoticed.
    expect(blender[0].querySelector("svg")).toBeTruthy();
    expect(blender[0].textContent).toContain("Blender");
    // Assert WHICH row carries it — a single badge on the wrong row would also
    // satisfy a bare length check.
    expect(
      screen.getByTestId("plans-pane-row-p-blender").contains(blender[0]),
    ).toBe(true);
    expect(screen.getByTestId("plans-pane-row-p-agent").textContent).toContain(
      "Rin",
    );
    expect(screen.getByTestId("plans-pane-row-p-human").textContent).toContain(
      "Avi",
    );
    expect(
      screen.getByTestId("plans-pane-row-p-fallback").textContent,
    ).toContain("User");
    expect(user.map((badge) => badge.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining([
        "Plan source: Rin (User)",
        "Plan source: Avi (User)",
        "Plan source: User",
      ]),
    );
  });

  it("passes the same canonical source and owner into a deep-linked popup", () => {
    planListData.value = {
      plans: [
        plan({
          slug: "p-user",
          title: "User plan",
          ownerIdentity: {
            id: "avi",
            handle: "Avi",
            kind: "human",
            verified: true,
          },
        }),
      ],
    };
    nuqs.pplan = "p-user";
    render(<PlansPane />);
    expect(screen.getByTestId("popup-open").getAttribute("data-origin")).toBe(
      "user",
    );
    expect(screen.getByTestId("popup-open").getAttribute("data-owner")).toBe(
      "Avi",
    );
  });

  it("filters by the URL-owned All / User / Blender source facet", () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-blender", title: "Blender plan", origin: "scout" }),
        plan({
          slug: "p-user",
          title: "User plan",
          ownerIdentity: {
            id: "avi",
            handle: "Avi",
            kind: "human",
            verified: true,
          },
        }),
      ],
    };
    nuqs.plSource = "user";

    render(<PlansPane />);

    expect(screen.getByText("User plan")).toBeTruthy();
    expect(screen.queryByText("Blender plan")).toBeNull();
    expect(
      screen.getByRole("button", { name: "User" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Blender" }));
    expect(setters.plSource).toHaveBeenCalledWith("blender");
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(setters.plSource).toHaveBeenCalledWith(null);
  });

  it("uses a filter-specific empty state when the source facet excludes every plan", () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-blender", title: "Blender plan", origin: "scout" }),
      ],
    };
    nuqs.plSource = "user";

    render(<PlansPane />);

    expect(
      screen.getByText("No plans match the current filters."),
    ).toBeTruthy();
    expect(screen.queryByText(/everything is finished/i)).toBeNull();
  });

  it("renders active plans with needs-you, live, and progress badges", () => {
    planListData.value = {
      plans: [
        plan({
          slug: "p-hot",
          title: "Hot plan",
          itemCounts: { done: 2, todo: 3 },
        }),
        plan({ slug: "p-cold", title: "Cold plan" }),
      ],
    };
    attentionItems.value = [{ planSlug: "p-hot", tier: "decision" }];
    rosterData.value = [
      { active: [{ currentPlanSlug: "p-hot" }, { currentPlanSlug: "p-hot" }] },
    ];

    render(<PlansPane />);
    expect(screen.getByText("Hot plan")).toBeTruthy();
    expect(screen.getByText("Cold plan")).toBeTruthy();
    // needs-you badge (1 decision item) + live badge (2 agents) on p-hot
    expect(screen.getByTestId("plans-pane-needs-badge").textContent).toBe("1");
    expect(screen.getByTestId("plans-pane-live-badge").textContent).toContain(
      "2",
    );
  });

  it("filters one-time vs triggered plans and renders the trigger-source badge", () => {
    planListData.value = {
      plans: [
        plan({ slug: "plain", title: "Plain plan", triggered: false }),
        plan({
          slug: "event-plan",
          title: "Event plan",
          triggered: true,
          triggerSources: ["external", "manual"],
        }),
      ],
    };
    nuqs.plTrigger = "triggered";
    render(<PlansPane />);
    expect(screen.queryByText("Plain plan")).toBeNull();
    expect(screen.getByText("Event plan")).toBeTruthy();
    expect(screen.getByTestId("plans-pane-trigger-badge").textContent).toBe(
      "event + manual",
    );
    expect(
      screen
        .getByRole("button", { name: "triggered" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("opens the plan DASHBOARD (sets scoped ?pdash) when a row is clicked — the popup path is retired (P-005/D-002)", () => {
    planListData.value = {
      plans: [plan({ slug: "p-open", title: "Open me" })],
    };
    render(<PlansPane />);
    fireEvent.click(screen.getByRole("button", { name: "Open plan Open me" }));
    // Scoped ref (wpop/wppop grammar): the sidebar is a cross-harness mount,
    // so the ref carries the plan row's own harness.
    expect(setters.pdash).toHaveBeenCalledWith("papercusp::p-open");
    // The popup param is NOT written from a row click any more (the setter
    // still exists — PlansPane keeps the ?pplan popup mounted for deep links).
    expect(setters.pplan).not.toHaveBeenCalled();
    // And the WI-5547 popup-open perf mark no longer starts here — nothing
    // would ever close it (the dashboard renders no Vditor parse).
    expect(beginInteractionSpy).not.toHaveBeenCalled();
  });

  /* ── layout="split" (portal-work-two-pane-2026-09-01 P-002 / D-001) ─────
     The portal's /plans full-page route asks for list + dashboard. The
     sidebar keeps the stack default, whose DOM must stay exactly as it was. */

  it("stack (the default) renders no aside and no split modifier", () => {
    planListData.value = { plans: [plan({ slug: "p1" })] };
    render(<PlansPane />);
    const root = screen.getByTestId("plans-pane");
    expect(root.className).toBe("plans-pane");
    expect(root.getAttribute("data-layout")).toBe("stack");
    expect(root.hasAttribute("data-has-selection")).toBe(false);
    expect(screen.queryByTestId("plans-pane-aside")).toBeNull();
    expect(screen.queryByTestId("plan-dashboard-stub")).toBeNull();
    // The column wrapper (display:contents in CSS) holds the list.
    const column = root.querySelector(".plans-pane__column");
    expect(column?.contains(screen.getByTestId("plans-pane-row-p1"))).toBe(
      true,
    );
  });

  it("split with no ?pdash renders the empty aside and no dashboard", () => {
    planListData.value = { plans: [plan({ slug: "p1" })] };
    render(<PlansPane layout="split" />);
    const root = screen.getByTestId("plans-pane");
    expect(root.className).toBe("plans-pane plans-pane--split");
    expect(root.getAttribute("data-layout")).toBe("split");
    expect(root.hasAttribute("data-has-selection")).toBe(false);
    const aside = screen.getByTestId("plans-pane-aside");
    // A focus landmark, never tab-reachable.
    expect(aside.getAttribute("tabindex")).toBe("-1");
    expect(aside.contains(screen.getByTestId("plans-pane-aside-empty"))).toBe(
      true,
    );
    expect(screen.queryByTestId("plan-dashboard-stub")).toBeNull();
    const row = screen.getByTestId("plans-pane-row-p1");
    expect(row.classList.contains("is-selected")).toBe(false);
    expect(root.querySelector(".plans-pane__column")?.contains(row)).toBe(
      true,
    );
  });

  it("split renders the ?pdash plan's dashboard in the aside, marks its row selected, and the dashboard's back clears the param", () => {
    planListData.value = {
      plans: [plan({ slug: "p1" }), plan({ slug: "p2" })],
    };
    nuqs.pdash = "papercusp::p2";
    try {
      render(<PlansPane layout="split" />);
      const root = screen.getByTestId("plans-pane");
      expect(root.hasAttribute("data-has-selection")).toBe(true);
      const aside = screen.getByTestId("plans-pane-aside");
      const dash = screen.getByTestId("plan-dashboard-stub");
      expect(aside.contains(dash)).toBe(true);
      expect(dash.getAttribute("data-plan")).toBe("p2");
      expect(dash.getAttribute("data-harness")).toBe("papercusp");
      expect(screen.queryByTestId("plans-pane-aside-empty")).toBeNull();
      const selected = screen.getByTestId("plans-pane-row-p2");
      expect(selected.classList.contains("is-selected")).toBe(true);
      expect(selected.getAttribute("aria-current")).toBe("true");
      const other = screen.getByTestId("plans-pane-row-p1");
      expect(other.classList.contains("is-selected")).toBe(false);
      expect(other.hasAttribute("aria-current")).toBe(false);
      // Selection stays URL-owned: the dashboard's own back clears `?pdash`.
      fireEvent.click(screen.getByTestId("plan-dashboard-back"));
      expect(setters.pdash).toHaveBeenCalledWith(null);
    } finally {
      delete nuqs.pdash;
    }
  });

  it("finished toggle flips ?plf", () => {
    planListData.value = { plans: [plan({ slug: "p1" })] };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId("plans-pane-finished-toggle"));
    expect(setters.plf).toHaveBeenCalledWith(true);
  });

  it("exposes the sort picker in the toolbar and writes ?plSort (WI-40982)", () => {
    planListData.value = {
      plans: [
        plan({
          slug: "p-old",
          title: "Older plan",
          updated: "2026-08-01T00:00:00Z",
        }),
        plan({
          slug: "p-new",
          title: "Newer plan",
          updated: "2026-08-09T00:00:00Z",
        }),
      ],
    };
    render(<PlansPane />);

    const sort = screen.getByTestId("plans-pane-sort") as HTMLSelectElement;
    expect(sort.getAttribute("aria-label")).toBe("Sort plans");
    expect(sort.value).toBe("needs");

    fireEvent.change(sort, { target: { value: "title" } });
    expect(setters.plSort).toHaveBeenCalledWith("title");
  });

  it("re-orders the rendered rows when ?plSort changes, without changing which rows show", () => {
    // Titles are deliberately INVERSE to recency, so the two orders disagree —
    // a test where both orders coincide would pass against a sort that is wired
    // to nothing at all.
    planListData.value = {
      plans: [
        plan({
          slug: "p-zulu",
          title: "Zulu",
          updated: "2026-08-09T00:00:00Z",
        }),
        plan({
          slug: "p-alpha",
          title: "Alpha",
          updated: "2026-08-01T00:00:00Z",
        }),
      ],
    };
    const rowsInOrder = () =>
      Array.from(
        document.querySelectorAll('[data-testid^="plans-pane-row-"]'),
      ).map((el) => el.getAttribute("data-testid"));

    // Default: no needs-you anywhere, so recency decides — newest (Zulu) leads.
    const first = render(<PlansPane />);
    expect(rowsInOrder()).toEqual([
      "plans-pane-row-p-zulu",
      "plans-pane-row-p-alpha",
    ]);
    first.unmount();

    nuqs.plSort = "title";
    render(<PlansPane />);
    // Same two rows, flipped: a sort re-orders, it never adds or drops a row.
    expect(rowsInOrder()).toEqual([
      "plans-pane-row-p-alpha",
      "plans-pane-row-p-zulu",
    ]);
    expect(screen.getByTestId("plans-pane-count-value").textContent).toBe("2");
  });

  it("shows the active-empty message when there are no active plans", () => {
    planListData.value = {
      plans: [plan({ slug: "shipped", status: "shipped" })],
    };
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

  it("offers archive on a STALE row only", () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-stale", title: "Stale plan", updated: daysAgo(30) }),
        plan({ slug: "p-fresh", title: "Fresh plan", updated: daysAgo(2) }),
      ],
    };
    render(<PlansPane />);
    expect(screen.getByTestId("plans-pane-archive-p-stale")).toBeTruthy();
    expect(screen.queryByTestId("plans-pane-archive-p-fresh")).toBeNull();
  });

  it("archives the plan after the confirm is accepted", async () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-stale", title: "Stale plan", updated: daysAgo(30) }),
      ],
    };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId("plans-pane-archive-p-stale"));
    await waitFor(() => expect(setPlanArchived).toHaveBeenCalled());
    expect(setPlanArchived).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "p-stale",
        archived: true,
        harness: "papercusp",
      }),
    );
    await waitFor(() => expect(toastSpies.success).toHaveBeenCalled());
    // The archived row must LEAVE the list. Verified live that the
    // harness_plans → plans.list SSE invalidation alone did not re-render it
    // within 3s, so the handler refreshes the plan feed explicitly.
    expect(planListRefresh).toHaveBeenCalled();
  });

  it("does NOT archive when the confirm is declined", async () => {
    confirmAnswer.value = false;
    planListData.value = {
      plans: [plan({ slug: "p-stale", updated: daysAgo(30) })],
    };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId("plans-pane-archive-p-stale"));
    await waitFor(() => expect(confirmAnswer.value).toBe(false));
    expect(setPlanArchived).not.toHaveBeenCalled();
  });

  /* ── Dual recency pair (plan-visibility-revamp-2026-08-23 P-002 / D-003) ── */

  it("renders the ✎/⚒ pair: hot work under 1h, dim em-dash when never worked", () => {
    planListData.value = {
      plans: [
        plan({ slug: "p-worked", title: "Worked plan", updated: daysAgo(3) }),
        plan({ slug: "p-idle", title: "Idle plan", updated: daysAgo(3) }),
      ],
    };
    workActivityData.value = [
      { slug: "p-worked", lastWorkAtMs: Date.now() - 5 * 60_000 },
    ];
    render(<PlansPane />);

    const workedT = screen.getByTestId("plans-pane-work-t-p-worked");
    expect(workedT.textContent).toBe("5m");
    expect(workedT.className).toContain("plans-pane__row-t--hot");

    const idleT = screen.getByTestId("plans-pane-work-t-p-idle");
    expect(idleT.textContent).toBe("—");
    expect(idleT.className).toContain("plans-pane__row-t--dim");

    // The ✎ half still reads the plan-doc clock, beside the ⚒ half.
    expect(screen.getByTestId("plans-pane-edit-t-p-worked").textContent).toBe(
      "3d",
    );
  });

  it("work older than 1h renders plain — neither hot nor dim", () => {
    planListData.value = {
      plans: [plan({ slug: "p-warm", updated: daysAgo(3) })],
    };
    workActivityData.value = [
      { slug: "p-warm", lastWorkAtMs: Date.now() - 5 * 3_600_000 },
    ];
    render(<PlansPane />);
    const t = screen.getByTestId("plans-pane-work-t-p-warm");
    expect(t.textContent).toBe("5h");
    expect(t.className).not.toContain("--hot");
    expect(t.className).not.toContain("--dim");
  });

  it("recent WORK keeps an unedited plan un-stale — no badge, no archive (D-003)", () => {
    planListData.value = {
      plans: [
        plan({
          slug: "p-worked-old-edit",
          title: "Worked, unedited",
          updated: daysAgo(30),
        }),
        plan({ slug: "p-abandoned", title: "Abandoned", updated: daysAgo(30) }),
      ],
    };
    workActivityData.value = [
      { slug: "p-worked-old-edit", lastWorkAtMs: Date.now() - 3_600_000 },
    ];
    render(<PlansPane />);
    // The worked plan: NOT stale despite the 30d-old edit …
    expect(
      screen.queryByTestId("plans-pane-archive-p-worked-old-edit"),
    ).toBeNull();
    // … while the genuinely abandoned sibling still reads stale.
    expect(screen.getByTestId("plans-pane-archive-p-abandoned")).toBeTruthy();
    const badges = screen.getAllByTestId("plans-pane-stale-badge");
    expect(badges).toHaveLength(1);
    expect(
      screen.getByTestId("plans-pane-row-p-abandoned").contains(badges[0]!),
    ).toBe(true);
  });

  it("surfaces a failed archive as an error toast", async () => {
    setPlanArchived.mockResolvedValueOnce({
      ok: false,
      error: "plan_not_found",
    } as never);
    planListData.value = {
      plans: [plan({ slug: "p-stale", updated: daysAgo(30) })],
    };
    render(<PlansPane />);
    fireEvent.click(screen.getByTestId("plans-pane-archive-p-stale"));
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

  it("schedules the Vditor preload on idle after mount, not synchronously on the render path", () => {
    vi.useFakeTimers();
    try {
      planListData.value = { plans: [plan({ slug: "p1" })] };
      render(<PlansPane />);
      // Must NOT run during render/mount — that would put the ~600ms WASM warm
      // back on the critical path it was moved off of.
      expect(preloadVditorSpy).not.toHaveBeenCalled();
      // Fires once the idle timer elapses (a plain setTimeout, so fake timers
      // drive it — a requestIdleCallback swap, which is unreliable in the Tauri
      // WebKitGTK webview, would never fire here and fail this assertion).
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(preloadVditorSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the pending preload when PlansPane unmounts before it fires", () => {
    vi.useFakeTimers();
    try {
      planListData.value = { plans: [plan({ slug: "p1" })] };
      const { unmount } = render(<PlansPane />);
      unmount();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      // No post-unmount work: the effect cleanup clears the timer.
      expect(preloadVditorSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
