// @vitest-environment jsdom
//
// ObservationsPanel — the browse-only Observations pane (turn-end reflections).
// Logic worth covering: the loading / empty / populated branches off the
// `learning.observations` sync query, the KIND_LABEL prettifier (known kind →
// label, unknown kind → raw value, missing kind → no chip), and the optional
// per-row metadata (sourceRole / scope / confidence / refs). The sync hook is
// mocked with a hoisted mutable holder (the OperatorActionLog pattern) so each
// test seeds its own rows without a live transport.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

const { sync, filters } = vi.hoisted(() => ({
  sync: {
    data: [] as unknown[],
    loading: false,
    fetching: false,
    error: null as { message: string } | null,
    args: null as unknown,
    invalidate: vi.fn(),
  },
  filters: { itemPlans: [] as string[] },
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: { args?: unknown }) => {
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
    expect(screen.getByText("Friction")).toBeTruthy(); // KIND_LABEL.friction
    expect(screen.getByText("mystery-kind")).toBeTruthy(); // unknown → raw
  });

  it("uses the distribution segments as direct, reversible signal filters", () => {
    sync.data = [
      mkRow({ id: "f1", title: "Friction row", kind: "friction" }),
      mkRow({ id: "g1", title: "Gap row", kind: "gap" }),
    ];
    render(<ObservationsPanel />);
    const friction = screen.getByRole("button", {
      name: "Filter by Friction, 1",
    });
    fireEvent.click(friction);
    expect(friction.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Friction row")).toBeTruthy();
    expect(screen.queryByText("Gap row")).toBeNull();
    fireEvent.click(friction);
    expect(screen.getByText("Gap row")).toBeTruthy();
  });

  it("renders the optional body, sourceRole, scope, confidence, and refs metadata", () => {
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
    expect(screen.getByTestId("observations-count").textContent).toBe("450");
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
  });
});
