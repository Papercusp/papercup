// @vitest-environment jsdom
//
// EI-19383745196363732 — does a CACHED revisit still emit a measure?
//
// A per-view experiment against the real desktop (EI-19375505819043214, run 3)
// switched pipeline(land) → improvements → pipeline → learnings → pipeline →
// observations. improvements (227ms), learnings (768ms) and observations
// (1401ms) each emitted exactly one measure; the pipeline view emitted NOTHING
// on EITHER revisit. Run 1 had measured that same view at 190ms on a FRESH
// load, so the difference is CACHE STATE: on a revisit the read is already
// resolved, so `settled` is true at the panel's FIRST render and its settle
// effect fires on MOUNT rather than on a loading→resolved transition.
//
// If the warm path is blind, the budget check passes by measuring zero — on
// exactly the interaction a real user performs most.
//
// This file uses the REAL perf-marks implementation, not a spy. The sibling
// AnalyzePanel.perf-settle.test.tsx already pins that the panel CALLS
// endInteraction; that is not the open question. The open question is whether
// the begin/end PAIR produces a `performance.measure` when the end arrives on
// mount, which a spy cannot answer.
//
// The two cases run through an IDENTICAL harness and differ only in cache
// state. The fresh case is a NEGATIVE CONTROL: without it, a jsdom that simply
// cannot measure would report the suspect case as "reproduced".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";

type SyncShape = {
  data: unknown;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  invalidate: () => void;
};

const RESOLVED: SyncShape = {
  data: [
    {
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
    },
  ],
  loading: false,
  fetching: false,
  error: null,
  invalidate: () => {},
};

const IN_FLIGHT: SyncShape = {
  data: undefined,
  loading: true,
  fetching: true,
  error: null,
  invalidate: () => {},
};

let analyzeResult: SyncShape = RESOLVED;
const cycleResult: SyncShape = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: () => {},
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

import { AnalyzePanel } from "./AnalyzePanel";
import {
  PERF_INTERACTIONS,
  beginInteraction,
} from "@/app/_components/perf/perf-marks";

const NAME = PERF_INTERACTIONS.learningViewSwitch;

function measureCount(): number {
  return performance.getEntriesByName(NAME, "measure").length;
}

/**
 * The exact shape LearningTab uses: a PARENT that begins the interaction in a
 * layout effect when the view changes, and a child panel that ends it in a
 * passive effect once its read has settled.
 */
function Harness({ view }: { view: string }) {
  const prev = useRef<string | null>(null);
  useLayoutEffect(() => {
    const p = prev.current;
    prev.current = view;
    if (p !== null && p !== view) beginInteraction(NAME);
  }, [view]);
  return view === "pipeline" ? <AnalyzePanel /> : <div>other view</div>;
}

beforeEach(() => {
  performance.clearMarks?.();
  performance.clearMeasures?.();
  analyzeResult = RESOLVED;
});
afterEach(() => cleanup());

describe("AnalyzePanel — learning-view-switch on a cached revisit", () => {
  it("emits a measure when the read resolves AFTER the switch (fresh load — negative control)", () => {
    analyzeResult = IN_FLIGHT;
    const { rerender } = render(<Harness view="other" />);
    expect(measureCount()).toBe(0);

    // Switch to the pipeline view while its read is still in flight.
    rerender(<Harness view="pipeline" />);
    expect(measureCount()).toBe(0); // still loading — must not settle yet

    // The read resolves.
    analyzeResult = RESOLVED;
    rerender(<Harness view="pipeline" />);
    expect(measureCount()).toBe(1);
  });

  it("emits a measure when the read is ALREADY resolved at the switch (cached revisit)", () => {
    analyzeResult = RESOLVED;
    const { rerender } = render(<Harness view="other" />);
    expect(measureCount()).toBe(0);

    // The revisit: the panel mounts with `settled` already true, so its settle
    // effect fires on MOUNT, in the same commit as the parent's begin.
    rerender(<Harness view="pipeline" />);
    expect(measureCount()).toBe(1);
  });
});
