// @vitest-environment jsdom
//
// AnalyzePanel — the Analyze stage's per-cycle detail loader (WI-6395).
//
// WHY THIS FILE EXISTS AT ALL. AnalyzePanel shipped with NO test file. That is
// how its worst defect survived: `CycleDetailLoader` rendered "Loading cycle
// artifacts…" for `!cycle`, and because the resolver converts a data-layer
// failure into a SUCCESSFUL empty read, a FAILED load fell into that branch and
// left a spinner running forever — no error, no retry, and nothing in the UI
// that would ever change. A permanent fake spinner is worse than a wrong empty
// state: it actively instructs the reader to keep waiting.
//
// These pin the three states that used to collapse into two. The distinction is
// only observable through `unavailable` provenance + `loading`, so this suite is
// the reason both exist.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let cycleResult: Record<string, unknown> = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
/** The panel's OTHER read (the cycle list) — kept deliberately empty so these
 *  tests are about the detail loader and nothing else. */
const listResult = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: { queryName: string }) =>
    opts.queryName === "learning.analyzeCycle" ? cycleResult : listResult,
}));

vi.mock("@/lib/useLexicon", () => ({ useLexicon: () => (k: string) => k }));

import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: () => [null, vi.fn()],
}));

import { CycleDetailLoader } from "./AnalyzePanel";

beforeEach(() => {
  cycleResult = {
    data: [],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
});
afterEach(() => cleanup());

describe("CycleDetailLoader — the three states (WI-6395)", () => {
  it("a DEGRADED read renders a fault with its cause, never a spinner", () => {
    cycleResult = {
      data: [
        {
          unavailable: true,
          unavailableKind: "read-failed",
          unavailableReason: "connection terminated unexpectedly",
        },
      ],
      loading: false,
      fetching: false,
      // The point: the resolver caught it and returned SUCCESS, so there is no
      // transport error to key off. Before the fix this rendered as loading.
      error: null,
      invalidate: vi.fn(),
    };
    render(<CycleDetailLoader cycleId="cyc-1" />);
    expect(screen.queryByText("Loading cycle artifacts…")).toBeNull();
    expect(
      screen.getByText(
        "This cycle's artifacts unavailable (connection terminated unexpectedly)",
      ),
    ).toBeTruthy();
  });

  it("a TRANSPORT error also renders a fault (the branch that already worked)", () => {
    cycleResult = {
      data: undefined,
      loading: false,
      fetching: false,
      error: new Error("socket hang up"),
      invalidate: vi.fn(),
    };
    render(<CycleDetailLoader cycleId="cyc-1" />);
    expect(screen.queryByText("Loading cycle artifacts…")).toBeNull();
    // Transport messages stay detail-free by standing decision — the arbitrary
    // socket text must not reach the screen.
    expect(screen.getByText("This cycle's artifacts unavailable")).toBeTruthy();
    expect(screen.queryByText(/socket hang up/)).toBeNull();
  });

  it("only claims to be LOADING while a read is genuinely in flight", () => {
    cycleResult = {
      data: undefined,
      loading: true,
      fetching: true,
      error: null,
      invalidate: vi.fn(),
    };
    render(<CycleDetailLoader cycleId="cyc-1" />);
    expect(screen.getByText("Loading cycle artifacts…")).toBeTruthy();
  });

  it("a settled, genuinely EMPTY read says so instead of pretending to load", () => {
    cycleResult = {
      data: [],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<CycleDetailLoader cycleId="cyc-1" />);
    // This is the second forever-spinner: a cycle that simply stored nothing
    // also hit `!cycle` and read as "Loading…" indefinitely.
    expect(screen.queryByText("Loading cycle artifacts…")).toBeNull();
    expect(
      screen.getByText(
        "This cycle recorded no artifacts — its generation ran but stored nothing to show.",
      ),
    ).toBeTruthy();
  });

  // Non-vacuousness: the suite must be able to observe the SUCCESS path too, or
  // "no spinner" above could be passing for the wrong reason (e.g. the component
  // throwing). A real cycle renders real content.
  it("renders the cycle when the read succeeds (proves the probe is not blind)", () => {
    cycleResult = {
      data: [
        {
          cycleId: "cyc-1",
          startedAt: new Date(1_000_000).toISOString(),
          ideas: [{ id: "idea-1", title: "A real idea" }],
          scored: [],
          fusions: [],
          routed: [],
          ideators: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<CycleDetailLoader cycleId="cyc-1" />);
    expect(screen.queryByText("Loading cycle artifacts…")).toBeNull();
    expect(screen.getByText("A real idea")).toBeTruthy();
  });
});
