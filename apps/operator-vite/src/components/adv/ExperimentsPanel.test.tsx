// @vitest-environment jsdom
//
// ExperimentsPanel render coverage (experiment-registry-invocation-api P-051): the
// Benchmark view's experiment scoreboard. Mounts against a realistic
// `learning.experiments` row set (useSyncQuery mocked, the pinned sibling pattern —
// see DemandPanel.test.tsx) and pins the populated list (test/tier, arm scores, the
// winner highlight, decision), the nothing-run empty state, and the defensive
// fallback when a row has an unexpected shape.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let result: Record<string, unknown> = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: () => result,
}));

import { ExperimentsPanel } from "./ExperimentsPanel";

const runs = [
  {
    batteryId: "try-terser-worker",
    testId: "replay",
    tier: "offline",
    winner: "terser",
    arms: [
      {
        id: "baseline",
        label: "historical baseline",
        meanScore: 6.1,
        cells: 1,
        scored: 1,
        costUsd: 0,
      },
      {
        id: "terser",
        label: "terser worker",
        meanScore: 7.4,
        cells: 1,
        scored: 1,
        costUsd: 0.01,
      },
    ],
    totalCostUsd: 0.012,
    budgetExhausted: false,
    decision: "proposed",
    createdAt: "2026-06-14T06:00:00.000Z",
  },
];

afterEach(() => {
  cleanup();
  result = {
    data: [],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
});

describe("ExperimentsPanel", () => {
  it("renders a run with its arms, the winner highlight, cost, and decision", () => {
    result = {
      // WI-6395: the read is enveloped now — `[{ items }]`, not a flat row array.
      data: [{ items: runs }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<ExperimentsPanel />);
    expect(screen.getByText("Experiments")).toBeTruthy();
    expect(screen.getAllByText("replay").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("offline").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("baseline 6.1")).toBeTruthy();
    expect(screen.getByText("terser 7.4")).toBeTruthy();
    expect(screen.getByText("▲ terser")).toBeTruthy();
    expect(screen.getAllByText("$0.012").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("proposed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Baseline vs winner")).toBeTruthy();
    expect(
      document.querySelector(".pc-learning-visual__comparison"),
    ).toBeTruthy();
  });

  it("renders the nothing-run empty state on an empty ledger", () => {
    result = {
      // An OBSERVED empty — the read succeeded and there is nothing to show.
      data: [{ items: [] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<ExperimentsPanel />);
    expect(screen.getByText("No experiment runs")).toBeTruthy();
  });

  it("degrades to the empty state on a malformed row set (defensive guard)", () => {
    result = {
      data: [{ items: [{ totally: "unexpected" }] }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<ExperimentsPanel />);
    expect(screen.getByText("No experiment runs")).toBeTruthy();
  });

  // WI-6395: the whole point of the envelope. The resolver converts a data-layer
  // failure into a SUCCESSFUL empty read (never a 500), so `sync.error` stays
  // null and the panel used to render its calm "No experiment runs" — telling
  // the reader nothing has run, when in truth nothing could be READ.
  it("shows a degraded read as a fault, not as 'no experiment runs'", () => {
    result = {
      data: [
        {
          items: [],
          unavailable: true,
          unavailableKind: "pre-migration",
          unavailableReason: "experiment_runs does not exist",
        },
      ],
      loading: false,
      fetching: false,
      error: null, // the point: a data-layer fault with NO transport error
      invalidate: vi.fn(),
    };
    render(<ExperimentsPanel />);
    expect(screen.queryByText("No experiment runs")).toBeNull();
    expect(
      screen.getByText(
        "The experiment registry not available yet — this install hasn't created its storage (experiment_runs does not exist)",
      ),
    ).toBeTruthy();
  });

  it("renders the empty state while loading with no data", () => {
    result = {
      data: undefined,
      loading: true,
      fetching: true,
      error: null,
      invalidate: vi.fn(),
    };
    render(<ExperimentsPanel />);
    expect(screen.getByText("No experiment runs")).toBeTruthy();
  });
});
