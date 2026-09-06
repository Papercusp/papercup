// P-005 (plan gate-latency-selection-and-retry-policy-2026-09-06): the pure half of the
// setup-stretch instrumentation. The wiring in green-checkpoint.ts is exercised by the WI-7069
// tests in green-checkpoint.test.ts (which now also pin the dominant-phase clause).
import { describe, expect, it } from "vitest";

import {
  SETUP_STRETCH_OTHER_PHASE,
  createSetupStretchStamps,
  formatDominantPhaseClause,
  formatSetupSubPhaseLine,
  formatStretchDuration,
  summarizeSetupStretch,
} from "./setup-stretch-stamps";

const MIN = 60_000;

describe("createSetupStretchStamps", () => {
  it("records each phase's duration from its start instant, clamping nonsense to zero", () => {
    let t = 1_000;
    const stamps = createSetupStretchStamps(() => t);
    const start = t;
    t += 14 * MIN + 12_000;
    stamps.stamp("setup-tree", start);
    stamps.stamp("clock-went-backwards", t + 5_000);
    expect(stamps.stamps).toEqual([
      { phase: "setup-tree", ms: 14 * MIN + 12_000 },
      { phase: "clock-went-backwards", ms: 0 },
    ]);
  });
});

describe("formatStretchDuration", () => {
  it("renders seconds, minutes+seconds, and hours+minutes compactly", () => {
    expect(formatStretchDuration(48_400)).toBe("48s");
    expect(formatStretchDuration(14 * MIN + 12_000)).toBe("14m12s");
    expect(formatStretchDuration(20 * MIN)).toBe("20m");
    expect(formatStretchDuration(125 * MIN)).toBe("2h05m");
    expect(formatStretchDuration(Number.NaN)).toBe("?");
    expect(formatStretchDuration(-1)).toBe("?");
  });
});

describe("summarizeSetupStretch", () => {
  const stamps = [
    { phase: "migration-preflight:post-materialization-backstop", ms: 40_000 },
    { phase: "setup-tree", ms: 14 * MIN + 12_000 },
    { phase: "tree-drift-preflight", ms: 3_000 },
    { phase: "early-typecheck-preflight", ms: 3 * MIN + 1_000 },
  ];

  it("orders phases longest-first, attributes the remainder to `other`, and names the dominant phase", () => {
    const total = 20 * MIN;
    const s = summarizeSetupStretch(stamps, total);
    expect(s.phases.map((p) => p.phase)).toEqual([
      "setup-tree",
      "early-typecheck-preflight",
      SETUP_STRETCH_OTHER_PHASE,
      "migration-preflight:post-materialization-backstop",
      "tree-drift-preflight",
    ]);
    expect(s.otherMs).toBe(total - (14 * MIN + 12_000 + 40_000 + 3_000 + 3 * MIN + 1_000));
    expect(s.dominant).toMatchObject({ phase: "setup-tree", ms: 14 * MIN + 12_000 });
    expect(s.dominant?.share).toBeCloseTo((14 * MIN + 12_000) / total, 3);
    expect(s.breakdown).toBe(
      "phases: setup-tree 14m12s (71%), early-typecheck-preflight 3m01s (15%), other 2m04s (10%), " +
        "migration-preflight:post-materialization-backstop 40s (3%), tree-drift-preflight 3s (0%)",
    );
  });

  it("lets the UNSTAMPED remainder win dominance — a warning must not name the wrong culprit", () => {
    const s = summarizeSetupStretch([{ phase: "setup-tree", ms: 2 * MIN }], 25 * MIN);
    expect(s.dominant?.phase).toBe(SETUP_STRETCH_OTHER_PHASE);
    expect(formatDominantPhaseClause(s, 25 * MIN)).toBe(
      "dominant phase: an UNSTAMPED step — the stamped phases do not account for the gap (23m, 92% of the 25m stretch)",
    );
  });

  it("never reports a negative remainder when stamps overshoot the measured stretch", () => {
    const s = summarizeSetupStretch([{ phase: "setup-tree", ms: 5 * MIN }], 4 * MIN);
    expect(s.otherMs).toBe(0);
    expect(s.phases.map((p) => p.phase)).toEqual(["setup-tree"]);
    expect(s.dominant?.share).toBeCloseTo(1.25, 3);
  });

  it("degrades honestly with nothing stamped", () => {
    const empty = summarizeSetupStretch([], 0);
    expect(empty.dominant).toBeNull();
    expect(empty.breakdown).toBe("phases: none stamped");
    expect(formatDominantPhaseClause(empty, 0)).toBe("dominant phase: unknown (nothing stamped)");
    // A stretch with no stamps but real elapsed time is ALL `other`.
    const unstamped = summarizeSetupStretch([], 7 * MIN);
    expect(unstamped.dominant).toMatchObject({ phase: SETUP_STRETCH_OTHER_PHASE, ms: 7 * MIN, share: 1 });
  });

  it("renders the dominant-phase clause the WI-7069 warning appends", () => {
    const s = summarizeSetupStretch(stamps, 20 * MIN);
    expect(formatDominantPhaseClause(s, 20 * MIN)).toBe(
      "dominant phase: setup-tree (14m12s, 71% of the 20m stretch)",
    );
  });
});

describe("formatSetupSubPhaseLine", () => {
  it("renders one line per sub-phase, with an optional note", () => {
    expect(formatSetupSubPhaseLine("setup-tree", "materialization", 13 * MIN + 50_000)).toBe(
      "setup-tree phase: materialization 13m50s",
    );
    expect(
      formatSetupSubPhaseLine("setup-tree", "materialization", 13 * MIN + 50_000, "≈40s before first setup-release output"),
    ).toBe("setup-tree phase: materialization 13m50s (≈40s before first setup-release output)");
  });
});
