// @vitest-environment jsdom
//
// BenchmarkTrend render + projection coverage (consume-edges P-033 / B-12).
// The trend is the Benchmark panel's "is it getting better" line: scored
// generations oldest→newest, unscored generations skipped, nothing rendered
// below two points (a single point is not a trend).

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  BenchmarkTrend,
  computeTrendPoints,
  type BenchmarkTrendInstance,
} from "./BenchmarkTrend";

afterEach(cleanup);

const gen = (
  over: Partial<BenchmarkTrendInstance>,
): BenchmarkTrendInstance => ({
  instanceId: `gen0-${over.codeSha ?? "sha"}-ws`,
  codeSha: "abcd1234",
  createdAt: new Date(1_000_000).toISOString(),
  totalRuns: 20,
  successfulRuns: 16,
  meanComposite: 0.7,
  ...over,
});

// Newest-first, like the learning.apiary read. Composites use the LIVE judge
// scale (0..10 — e.g. 4.06..5.95 on the real gen-0 rows), NOT the 0..1 the old
// LearningTab fixture suggested; the projection must stay scale-free.
const THREE_GENS: BenchmarkTrendInstance[] = [
  gen({
    codeSha: "ccc3333",
    createdAt: new Date(3_000_000).toISOString(),
    meanComposite: 5.95,
  }),
  gen({
    codeSha: "bbb2222",
    createdAt: new Date(2_000_000).toISOString(),
    meanComposite: 4.81,
  }),
  gen({
    codeSha: "aaa1111",
    createdAt: new Date(1_000_000).toISOString(),
    meanComposite: 4.06,
  }),
];

describe("computeTrendPoints", () => {
  it("projects scored generations oldest→newest with higher composite = higher on the plot", () => {
    const pts = computeTrendPoints(THREE_GENS);
    expect(pts.map((p) => p.inst.codeSha)).toEqual([
      "aaa1111",
      "bbb2222",
      "ccc3333",
    ]);
    expect(pts[0].x).toBeLessThan(pts[2].x);
    // SVG y grows downward: the newer, higher-composite generation sits at a smaller y.
    expect(pts[2].y).toBeLessThan(pts[0].y);
    // Live-scale (0..10) points must land inside the plot box — the regression that
    // a 0..1 domain ceiling produced off-box coordinates for real judge composites.
    for (const p of pts) {
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(132);
    }
  });

  it("skips unscored generations (dry-runs) instead of breaking the line", () => {
    const pts = computeTrendPoints([
      THREE_GENS[0],
      gen({ codeSha: "dry0000", meanComposite: null }),
      THREE_GENS[2],
    ]);
    expect(pts.map((p) => p.inst.codeSha)).toEqual(["aaa1111", "ccc3333"]);
  });

  it("returns no points below two scored generations", () => {
    expect(computeTrendPoints([])).toEqual([]);
    expect(computeTrendPoints([THREE_GENS[0]])).toEqual([]);
    expect(
      computeTrendPoints([THREE_GENS[0], gen({ meanComposite: null })]),
    ).toEqual([]);
  });
});

describe("<BenchmarkTrend />", () => {
  it("renders the line, one dot per generation, and per-point tooltips", () => {
    const { container } = render(<BenchmarkTrend instances={THREE_GENS} />);
    const figure = container.querySelector("figure.pc-benchtrend");
    expect(figure).not.toBeNull();
    expect(figure!.getAttribute("aria-label")).toMatch(/3 generations/);
    expect(container.querySelectorAll("polyline")).toHaveLength(1);
    const dots = container.querySelectorAll("circle");
    expect(dots).toHaveLength(3);
    const titles = [...container.querySelectorAll("circle title")].map(
      (t) => t.textContent ?? "",
    );
    expect(
      titles.some(
        (t) =>
          t.includes("ccc3333") &&
          t.includes("5.950") &&
          t.includes("16/20 solved"),
      ),
    ).toBe(true);
  });

  it("renders nothing below two scored generations — the parent owns the empty state", () => {
    const { container } = render(
      <BenchmarkTrend instances={[THREE_GENS[0]]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("collapses a flat series into a neutral baseline instead of drawing a chart", () => {
    const flat = THREE_GENS.map((instance) => ({
      ...instance,
      meanComposite: 5,
    }));
    const { container } = render(<BenchmarkTrend instances={flat} />);
    const figure = container.querySelector("figure.pc-benchtrend--flat");
    expect(figure).not.toBeNull();
    expect(figure?.getAttribute("aria-label")).toMatch(/unchanged at 5\.000/);
    expect(container.querySelector("svg")).toBeNull();
    expect(container.textContent).toContain("Composite unchanged");
  });
});
