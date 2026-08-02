// @vitest-environment jsdom
//
// AnalyzePanel — the settle point for PERF_INTERACTIONS.learningViewSwitch
// (EI-19375505819043214).
//
// WHY THIS FILE EXISTS. The owner reported that the Learning tab's analyze view
// "took several seconds expanding the sections and just displayed loading
// artifacts". Every learning.* resolver measures well under a second on the live
// operator (learning.analyze and learning.analyzeCycle are ~25ms each), so the
// multi-second cost is client-side — and NOTHING measured it: the Learning tab
// had no instrumented interaction at all, which is why the regression reached a
// human instead of reddening a check.
//
// LearningTab begins the interaction on a view change; this panel ends it. The
// value of the whole instrument therefore rests on this settle point firing at
// the right MOMENT, which is what these tests pin:
//
//   - not while the read is still in flight (that would report ~0ms and make a
//     genuinely slow view look instant — a false green, the worst outcome for a
//     perf guard);
//   - once the content is final, including a FAULT. Ending only on success
//     would leave a failed read's start mark dangling until STALE_START_MS
//     discarded it, so a slow FAILING view — exactly what the owner described —
//     would silently measure nothing.
//
// The begin/end pair is spied rather than exercised through the real User
// Timing API: `endInteraction` no-ops unless a matching `beginInteraction` ran,
// so asserting on the real implementation would test the measure-once guard
// (already covered in perf-marks.test.ts) instead of this panel's timing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

let analyzeResult: Record<string, unknown> = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
/** The per-cycle detail read — held empty; these tests are about the panel's
 *  own primary read (learning.analyze) and nothing else. */
const cycleResult = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: { queryName: string }) =>
    opts.queryName === "learning.analyzeCycle" ? cycleResult : analyzeResult,
}));

vi.mock("@/lib/useLexicon", () => ({ useLexicon: () => (k: string) => k }));

import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: () => [null, vi.fn()],
}));

// Spy begin/end, keep the real PERF_INTERACTIONS names so a rename of the
// interaction breaks this test rather than silently passing against a stale
// string literal.
const perfMarks = vi.hoisted(() => ({ begin: vi.fn(), end: vi.fn() }));
vi.mock("@/app/_components/perf/perf-marks", async (orig) => ({
  ...(await orig<typeof import("@/app/_components/perf/perf-marks")>()),
  beginInteraction: perfMarks.begin,
  endInteraction: perfMarks.end,
}));

import { AnalyzePanel } from "./AnalyzePanel";
import { PERF_INTERACTIONS } from "@/app/_components/perf/perf-marks";

const snapshot = {
  cycles: [
    {
      cycleId: "scout-1",
      at: "2026-08-02T21:00:00.000Z",
      ideasCount: 8,
      proposalsCount: 2,
      routedCount: 1,
      verdicts: ["keep", "reject"],
      tick: null,
    },
  ],
};

beforeEach(() => {
  perfMarks.begin.mockClear();
  perfMarks.end.mockClear();
  analyzeResult = {
    data: [],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
});
afterEach(() => cleanup());

describe("AnalyzePanel — learning-view-switch settle point", () => {
  it("does NOT end the interaction while the read is still in flight", () => {
    analyzeResult = {
      data: undefined,
      loading: true,
      fetching: true,
      error: null,
      invalidate: vi.fn(),
    };
    render(<AnalyzePanel />);
    // Ending here would stop the clock while the loading artifacts are still on
    // screen — reporting a fast switch for a slow one.
    expect(perfMarks.end).not.toHaveBeenCalled();
  });

  it("ends the interaction once the snapshot has resolved", () => {
    analyzeResult = {
      data: [snapshot],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<AnalyzePanel />);
    expect(perfMarks.end).toHaveBeenCalledWith(
      PERF_INTERACTIONS.learningViewSwitch,
    );
  });

  it("ends the interaction on a FAULT too, so a slow failing view is still measured", () => {
    analyzeResult = {
      data: undefined,
      loading: false,
      fetching: false,
      error: new Error("read failed"),
      invalidate: vi.fn(),
    };
    render(<AnalyzePanel />);
    expect(perfMarks.end).toHaveBeenCalledWith(
      PERF_INTERACTIONS.learningViewSwitch,
    );
  });

  it("ends a DEGRADED read that resolves successfully with an unavailable payload", () => {
    // The resolver converts a data-layer failure into a SUCCESSFUL empty read
    // (WI-6395), so `error` is falsy and only the payload says it failed. This
    // is the case that produced a permanent spinner before WI-6395; it must
    // still settle the perf measure.
    analyzeResult = {
      data: [
        {
          unavailable: true,
          unavailableKind: "read-failed",
          unavailableReason: "connection terminated unexpectedly",
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<AnalyzePanel />);
    expect(perfMarks.end).toHaveBeenCalledWith(
      PERF_INTERACTIONS.learningViewSwitch,
    );
  });
});
