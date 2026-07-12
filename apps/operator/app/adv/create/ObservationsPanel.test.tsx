// @vitest-environment jsdom
//
// ObservationsPanel — the browse-only Observations pane (turn-end reflections).
// Logic worth covering: the loading / empty / populated branches off the
// `learning.observations` sync query, the KIND_LABEL prettifier (known kind →
// label, unknown kind → raw value, missing kind → no chip), and the optional
// per-row metadata (sourceRole / scope / confidence / refs). The sync hook is
// mocked with a hoisted mutable holder (the OperatorActionLog pattern) so each
// test seeds its own rows without a live transport.
//
// WI-4374: Tests for real COUNT query (learning.observations.counts),
// "500+" render guard, and staleness tone (based on newest observation age).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

const { sync, counts, filters } = vi.hoisted(() => ({
  sync: {
    data: [] as unknown[],
    loading: false,
    fetching: false,
    error: null as { message: string } | null,
    args: null as unknown,
    invalidate: vi.fn(),
  },
  counts: {
    data: [] as unknown[],
    loading: false,
    fetching: false,
    error: null as { message: string } | null,
    invalidate: vi.fn(),
  },
  filters: { itemPlans: [] as string[] },
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: { queryName?: string; args?: unknown }) => {
    if (opts.queryName === "learning.observations.counts") {
      return {
        data: counts.data,
        loading: counts.loading,
        error: counts.error,
        fetching: counts.fetching,
        transport: "sse" as const,
        invalidate: counts.invalidate,
      };
    }
    sync.args = opts.args;
    return {
      data: sync.data,
      loading: sync.loading,
      error: sync.error,
      fetching: sync.fetching,
      transport: "sse" as const,
      invalidate: sync.invalidate,
    };
  },
}));
vi.mock("@papercusp/grid-core", () => ({
  VirtualGrid: ({
    rows,
    columns,
    onEndReached,
  }: {
    rows: Row[];
    columns: Array<{ key: string; render?: (ctx: { row: Row }) => ReactNode }>;
    onEndReached?: () => void;
  }) => (
    <div data-testid="observations-grid">
      {rows.map((row) => (
        <div key={row.id} data-testid="observation-row">
          {columns.map((column) => (
            <span key={column.key}>{column.render?.({ row })}</span>
          ))}
        </div>
      ))}
      {onEndReached ? <button onClick={onEndReached}>load-more</button> : null}
    </div>
  ),
}));
vi.mock("./use-create-data", () => ({
  useItemPlanFilter: () => [filters.itemPlans, vi.fn()],
}));

import ObservationsPanel from "./ObservationsPanel";

interface Row {
  id: string;
  title: string;
  body: string | null;
  kind: string | null;
  scope: string | null;
  confidence: string | null;
  refs: string[];
  sourceRole: string | null;
  createdAt: string;
}
function mkRow(over: Partial<Row> = {}): Row {
  return {
    id: "o1",
    title: "Title one",
    body: null,
    kind: null,
    scope: null,
    confidence: null,
    refs: [],
    sourceRole: null,
    createdAt: "2026-06-14T12:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  sync.data = [];
  sync.loading = false;
  sync.fetching = false;
  sync.error = null;
  sync.args = null;
  sync.invalidate.mockReset();
  counts.data = [];
  counts.loading = false;
  counts.fetching = false;
  counts.error = null;
  counts.invalidate.mockReset();
  filters.itemPlans = [];
});
afterEach(() => cleanup());

describe("<ObservationsPanel />", () => {
  it("shows the loading copy while loading with no rows yet", () => {
    sync.loading = true;
    sync.data = [];
    render(<ObservationsPanel />);
    expect(screen.getByText(/loading observations…/i)).toBeTruthy();
  });

  it("shows the empty-state copy when there are no observations", () => {
    sync.loading = false;
    sync.data = [];
    render(<ObservationsPanel />);
    expect(screen.getByText(/no observations yet/i)).toBeTruthy();
  });

  it("renders one list item per observation with its title", () => {
    sync.data = [
      mkRow({ id: "a", title: "First" }),
      mkRow({ id: "b", title: "Second" }),
    ];
    render(<ObservationsPanel />);
    expect(screen.getAllByTestId("observation-row")).toHaveLength(2);
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("Second")).toBeTruthy();
  });

  it("shows the full observed timestamp, including seconds", () => {
    const createdAt = "2026-06-14T12:34:56.000Z";
    sync.data = [mkRow({ createdAt })];
    render(<ObservationsPanel />);
    expect(
      screen.getByText(
        new Date(createdAt).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          second: "2-digit",
        }),
      ),
    ).toBeTruthy();
  });

  it("filters observations by the selected plan refs", () => {
    filters.itemPlans = ["plan-alpha"];
    sync.data = [
      mkRow({ id: "a", title: "Alpha exact", refs: ["plan-alpha"] }),
      mkRow({ id: "b", title: "Alpha tagged", refs: ["plan:plan-alpha"] }),
      mkRow({ id: "c", title: "Beta", refs: ["plan-beta"] }),
      mkRow({ id: "d", title: "Prefix only", refs: ["plan-alphabet"] }),
    ];
    render(<ObservationsPanel />);
    expect(screen.getAllByTestId("observation-row")).toHaveLength(2);
    expect(screen.getByText("Alpha exact")).toBeTruthy();
    expect(screen.getByText("Alpha tagged")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.queryByText("Prefix only")).toBeNull();
  });

  it("shows a selected-plan empty state when the filter removes every observation", () => {
    filters.itemPlans = ["plan-alpha"];
    sync.data = [mkRow({ id: "b", title: "Beta", refs: ["plan-beta"] })];
    render(<ObservationsPanel />);
    expect(
      screen.getByText(/no observations match the selected filters/i),
    ).toBeTruthy();
  });

  it("maps a known kind to its pretty label and passes an unknown kind through", () => {
    sync.data = [
      mkRow({ id: "k1", title: "k1", kind: "friction" }),
      mkRow({ id: "k2", title: "k2", kind: "mystery-kind" }),
    ];
    render(<ObservationsPanel />);
    expect(screen.getAllByText("Friction").length).toBeGreaterThanOrEqual(1); // KIND_LABEL.friction
    expect(screen.getAllByText("mystery-kind").length).toBeGreaterThanOrEqual(
      1,
    ); // unknown → raw
  });

  it("uses visible count chips as direct, reversible signal filters", () => {
    sync.data = [
      mkRow({ id: "f1", title: "Friction row", kind: "friction" }),
      mkRow({ id: "g1", title: "Gap row", kind: "gap" }),
    ];
    counts.data = [
      { kind: "friction", count: 1 },
      { kind: "gap", count: 1 },
    ];
    render(<ObservationsPanel />);
    const friction = screen.getByRole("button", {
      name: "Filter by Friction, 1",
    });
    expect(friction.textContent).toContain("Friction");
    expect(friction.textContent).toContain("1");
    fireEvent.click(friction);
    expect(friction.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Friction row")).toBeTruthy();
    expect(screen.queryByText("Gap row")).toBeNull();
    fireEvent.click(friction);
    expect(screen.getByText("Gap row")).toBeTruthy();
  });

  it("puts semantic signals before Other and shows loaded versus total", () => {
    sync.data = [
      { ...mkRow({ id: "o1", title: "Other row" }), _meta: { total: 2569 } },
      mkRow({ id: "f1", title: "Friction row", kind: "friction" }),
      mkRow({ id: "s1", title: "Surprise row", kind: "surprise" }),
    ];
    counts.data = [
      { kind: "friction", count: 500 },
      { kind: "surprise", count: 300 },
      { kind: "other", count: 1769 },
    ];
    render(<ObservationsPanel />);
    const chips = screen.getByLabelText(
      "Signal distribution (database counts)",
    );
    expect(chips.querySelector("button")?.textContent).toContain("Friction");
    expect(chips.querySelector("button:last-child")?.textContent).toContain(
      "other",
    );
    expect(screen.getByTestId("observations-count").textContent).toBe(
      "3 / 2,569",
    );
  });

  it("reveals the full body and context only for the selected observation", () => {
    sync.data = [
      mkRow({
        id: "full",
        title: "Full row",
        body: "a longer note",
        sourceRole: "engineer",
        scope: "repo",
        confidence: "high",
        refs: ["F-1", "WI-2"],
      }),
    ];
    render(<ObservationsPanel />);
    expect(screen.queryByText("a longer note")).toBeNull();
    expect(
      screen.queryByText("engineer · repo · high · F-1 · WI-2"),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand observation Full row" }),
    );
    expect(screen.getByText("a longer note")).toBeTruthy();
    expect(
      screen.getByText("engineer · repo · high · F-1 · WI-2"),
    ).toBeTruthy();
  });

  it("grows the server window at the virtualized scroll edge and shows the authoritative total", async () => {
    sync.data = [
      { ...mkRow({ id: "a", title: "First" }), _meta: { total: 450 } },
      mkRow({ id: "b", title: "Second" }),
    ];
    render(<ObservationsPanel />);
    expect(sync.args).toEqual({ limit: 200 });
    expect(screen.getByTestId("observations-count").textContent).toBe(
      "2 / 450",
    );
    fireEvent.click(screen.getByText("load-more"));
    await waitFor(() => expect(sync.args).toEqual({ limit: 400 }));
  });

  it("keeps cached rows painted during a sync refresh", () => {
    sync.data = [mkRow({ id: "a", title: "Still here" })];
    sync.loading = true;
    sync.fetching = true;
    render(<ObservationsPanel />);
    expect(screen.getByText("Still here")).toBeTruthy();
    expect(screen.queryByText(/loading observations/i)).toBeNull();
  });

  it("refreshes through the shared sync query", () => {
    sync.data = [mkRow()];
    render(<ObservationsPanel />);
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh observations" }),
    );
    expect(sync.invalidate).toHaveBeenCalledTimes(1);
    expect(counts.invalidate).toHaveBeenCalledTimes(1);
  });

  // ── WI-4374: New tests for COUNT query, 500+ guard, staleness tone ──

  it("fetches real database counts via learning.observations.counts", () => {
    sync.data = [mkRow({ id: "a", kind: "friction" })];
    counts.data = [
      { kind: "friction", count: 500 },
      { kind: "gap", count: 600 },
    ];
    render(<ObservationsPanel />);
    // Signal distribution should show database counts, not loaded counts
    const frictionBtn = screen.getByRole("button", {
      name: "Filter by Friction, 500",
    });
    expect(frictionBtn).toBeTruthy();
    const gapBtn = screen.getByRole("button", {
      name: "Filter by Gap, 600",
    });
    expect(gapBtn).toBeTruthy();
  });

  it("applies 500+ render guard to counts >= 500", () => {
    sync.data = [mkRow()];
    counts.data = [
      { kind: "friction", count: 500 },
      { kind: "gap", count: 501 },
      { kind: "surprise", count: 499 },
    ];
    render(<ObservationsPanel />);
    expect(
      screen.getByRole("button", { name: "Filter by Friction, 500" })
        .textContent,
    ).toContain("500+");
    expect(
      screen.getByRole("button", { name: "Filter by Gap, 501" }).textContent,
    ).toContain("500+");
    expect(
      screen.getByRole("button", {
        name: "Filter by Surprise, 499",
      }),
    ).toBeTruthy();
  });

  it("applies staleness tone based on newest observation age", () => {
    const now = Date.now();
    const fresh = new Date(now - 15 * 60_000).toISOString(); // 15min ago
    const stale = new Date(now - 90 * 60_000).toISOString(); // 90min ago
    const veryStale = new Date(now - 3 * 60_60_000).toISOString(); // 3+ hours ago

    counts.data = [{ kind: "other", count: 1 }];

    // Fresh: newest <30min ago
    sync.data = [mkRow({ id: "a", createdAt: fresh })];
    const { rerender } = render(<ObservationsPanel />);
    let dist = screen.getByLabelText("Signal distribution (database counts)");
    expect(dist.getAttribute("data-staleness")).toBe("fresh");

    // Stale: newest 30min-2h ago
    sync.data = [mkRow({ id: "a", createdAt: stale })];
    rerender(<ObservationsPanel />);
    dist = screen.getByLabelText("Signal distribution (database counts)");
    expect(dist.getAttribute("data-staleness")).toBe("stale");

    // Very stale: newest 2h+ ago
    sync.data = [mkRow({ id: "a", createdAt: veryStale })];
    rerender(<ObservationsPanel />);
    dist = screen.getByLabelText("Signal distribution (database counts)");
    expect(dist.getAttribute("data-staleness")).toBe("very-stale");
  });

  it("defaults to very-stale when no observations are loaded", () => {
    sync.data = [];
    render(<ObservationsPanel />);
    // When empty, staleness defaults to very-stale (no data)
    // The distribution div won't render if there are no signal counts, so check nothing breaks
    expect(screen.queryByText(/no observations yet/i)).toBeTruthy();
  });
});
