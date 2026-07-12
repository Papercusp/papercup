// @vitest-environment jsdom
//
// EkgPanel render coverage (self-learning-frontier-2026-06-12 P-030 / FB-10):
// the Benchmark view's fleet behavioral heartbeat. Mounts against a realistic
// `learning.ekg` snapshot (useSyncQuery mocked, the pinned sibling pattern —
// see DemandPanel.test.tsx) and pins the populated shift list (severity chips,
// direction, attribution vs the unattributable alarm chip), the EKG waveform,
// the empty state, and the defensive fallback on a malformed snapshot.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let ekgResult: Record<string, unknown> = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: () => ekgResult,
}));

import { EkgPanel } from "./EkgPanel";

const snapshot = {
  shifts: [
    {
      id: 1,
      windowDate: "2026-06-12",
      feature: "errorRate",
      kind: "numeric",
      score: 0.412,
      severity: "major",
      direction: "up",
      baselineSummary: 0.05,
      windowSummary: 0.4,
      windowSessions: 12,
      baselineSessions: 88,
      attributed: false,
      ledgerCandidates: [],
      notifiedAt: "2026-06-12T11:00:00.000Z",
    },
    {
      id: 2,
      windowDate: "2026-06-12",
      feature: "toolMix",
      kind: "mix",
      score: 0.21,
      severity: "moderate",
      direction: null,
      baselineSummary: null,
      windowSummary: null,
      windowSessions: 12,
      baselineSessions: 88,
      attributed: true,
      ledgerCandidates: [
        {
          id: "chg-1",
          source: "gym:accept",
          mutationClass: "gym",
          target: "papercup/worker",
          recordedAt: "2026-06-12T08:00:00.000Z",
          summary: "champion accepted",
        },
      ],
      notifiedAt: null,
    },
  ],
  totalShifts: 2,
  unattributedShifts: 1,
  sessionsEmbedded: 512,
  sessions7d: 130,
  scannedAt: "2026-06-12T10:00:00.000Z",
};

afterEach(() => {
  cleanup();
  ekgResult = {
    data: [],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
});

describe("EkgPanel", () => {
  it("renders shifts with severity, direction, attribution and the alarm chip", () => {
    ekgResult = {
      data: [snapshot],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<EkgPanel />);
    expect(screen.getByText("Fleet EKG")).toBeTruthy();
    expect(screen.getByText("errorRate")).toBeTruthy();
    expect(screen.getByText("toolMix")).toBeTruthy();
    expect(screen.getByText("major")).toBeTruthy();
    expect(screen.getByText("moderate")).toBeTruthy();
    // The unattributable shift carries the alarm chip; the attributed one its cause count.
    expect(screen.getByText("unattributable")).toBeTruthy();
    expect(screen.getByText("1 cause")).toBeTruthy();
    expect(
      screen.getAllByText("Detected shifts").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Window")).toBeTruthy();
    expect(screen.getByText("All shifts")).toBeTruthy();
    expect(screen.getByText("5.0%")).toBeTruthy();
    expect(document.querySelector(".pc-ekg__wave")).toBeTruthy();
  });

  it("renders the nothing-scanned empty state on an empty store", () => {
    ekgResult = {
      data: [
        {
          shifts: [],
          totalShifts: 0,
          unattributedShifts: 0,
          sessionsEmbedded: 0,
          sessions7d: 0,
          scannedAt: null,
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<EkgPanel />);
    expect(screen.getByText("No behavioral shifts")).toBeTruthy();
  });

  it("keeps older shifts collapsed until requested", () => {
    const shifts = Array.from({ length: 10 }, (_, i) => ({
      ...snapshot.shifts[0],
      id: i + 1,
      feature: `signal-${i + 1}`,
    }));
    ekgResult = {
      data: [{ ...snapshot, shifts, totalShifts: shifts.length }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<EkgPanel />);
    expect(screen.getByText("signal-8")).toBeTruthy();
    expect(screen.queryByText("signal-9")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Earlier shifts/ }));
    expect(screen.getByText("signal-9")).toBeTruthy();
    expect(screen.getByText("signal-10")).toBeTruthy();
  });

  it("degrades to the empty state on a malformed snapshot (defensive shape guard)", () => {
    ekgResult = {
      data: [{ totally: "unexpected" }],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<EkgPanel />);
    expect(screen.getByText("No behavioral shifts")).toBeTruthy();
  });

  it("renders the empty state while loading with no data", () => {
    ekgResult = {
      data: undefined,
      loading: true,
      fetching: true,
      error: null,
      invalidate: vi.fn(),
    };
    render(<EkgPanel />);
    expect(screen.getByText("No behavioral shifts")).toBeTruthy();
  });

  it("renders a quiet retry state without exposing transport details", () => {
    const invalidate = vi.fn();
    ekgResult = {
      data: undefined,
      loading: false,
      fetching: false,
      error: new Error("socket secret"),
      invalidate,
    };
    render(<EkgPanel />);
    expect(screen.getByText("EKG unavailable")).toBeTruthy();
    expect(screen.queryByText("socket secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry EKG unavailable" }));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
