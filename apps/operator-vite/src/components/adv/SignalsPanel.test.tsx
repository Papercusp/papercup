// @vitest-environment jsdom
//
// SignalsPanel render coverage (WI-5417 — colored vertical trigger-lane
// cards, the removed "recent cycles fed" disclosure, the browseable
// per-cycle digest history, and the grouped two-column lane taxonomy).
// `useSyncQuery` + `nuqs` mocked (the pinned sibling pattern — see
// AdvShell.test.tsx / EkgPanel.test.tsx): nuqs uses the shared complete
// parser mock (EI-8821) with assert-only setter spies (no write-back —
// tests assert what the setter was CALLED with, not a post-click rerender).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { nuqsParsers } from "@papercusp/test-config/nuqs-mock";

const nuqsState: Record<string, unknown> = {};
const nuqsSetters: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock("nuqs", () => ({
  ...nuqsParsers,
  useQueryState: (key: string) => {
    nuqsSetters[key] ??= vi.fn(async () => {});
    return [nuqsState[key] ?? null, nuqsSetters[key]];
  },
}));

let syncResult: Record<string, unknown> = {
  data: [],
  loading: false,
  fetching: false,
  error: null,
  invalidate: vi.fn(),
};
let lastQueryArgs: unknown;
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (opts: { args?: unknown }) => {
    lastQueryArgs = opts.args;
    return syncResult;
  },
}));

import { SignalsPanel } from "./SignalsPanel";

const snapshot = {
  totalRouted: 0,
  railCounts: [],
  recent: [],
  lastTick: null,
  ticks: [
    { at: "2026-07-18T03:00:00.000Z", status: "ran", stop: "completed", generated: 4, routed: 2, deduped: 1, spendUsd: 0.5, cycleId: "scout-3", lenses: {}, groundingLanes: { corpus: 5 } },
  ],
  health: { status: "good", markers: [] },
  lensWeights: null,
  groundingTitles: {},
  cadence: {
    lanes: [
      { lane: "scorecard-rating-changes", count: 3, weight: 1 },
      { lane: "observations", count: 0, weight: 0.5 },
      { lane: "captures", count: 2, weight: 0.5 },
      { lane: "reverts", count: 0, weight: 1.5 },
      { lane: "deferrals", count: 1, weight: 1 },
      { lane: "completions", count: 5, weight: 0.5 },
    ],
    score: 6.5,
    threshold: 10,
    minVolumeIntervalSec: 900,
    maxIntervalSec: 3600,
    watermarkAt: "2026-07-18T02:00:00.000Z",
  },
  drafts: [],
  digest: {
    cycleId: "scout-3",
    at: "2026-07-18T03:00:00.000Z",
    watermarkAt: "2026-07-18T02:00:00.000Z",
    totalEntries: 2,
    laneCounts: { "recurring-friction": 2 },
    newEntries: [
      { lane: "recurring-friction", summary: "agents keep re-deriving the same fix", ref: "wi:EI-900", weight: 0.9 },
    ],
    standingEntries: [
      { lane: "corpus", summary: "standing corpus pattern", ref: "wi:EI-800", weight: 0.4 },
    ],
    truncated: false,
  },
  digestHistory: [
    { cycleId: "scout-3", at: "2026-07-18T03:00:00.000Z", totalEntries: 2, newCount: 1, standingCount: 1 },
    { cycleId: "scout-2", at: "2026-07-18T02:00:00.000Z", totalEntries: 3, newCount: 0, standingCount: 3 },
  ],
};

afterEach(() => {
  cleanup();
  for (const k of Object.keys(nuqsState)) delete nuqsState[k];
  for (const k of Object.keys(nuqsSetters)) delete nuqsSetters[k];
  syncResult = {
    data: [],
    loading: false,
    fetching: false,
    error: null,
    invalidate: vi.fn(),
  };
  lastQueryArgs = undefined;
});

describe("SignalsPanel", () => {
  it("renders the trigger lanes as cards (count + label) and never the retired 'recent cycles fed' disclosure", () => {
    syncResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    const { container } = render(<SignalsPanel />);
    expect(screen.getByText("Will it fire?")).toBeTruthy();
    expect(screen.getByText("scorecard rating changes")).toBeTruthy();
    expect(screen.getByText("observations")).toBeTruthy();
    expect(screen.getByText("completions")).toBeTruthy();
    // Each trigger card pairs its count with its lane label.
    const cards = Array.from(
      container.querySelectorAll(".pc-signals__triggercard"),
    ).map((el) => el.textContent);
    expect(cards).toEqual([
      "3scorecard rating changes",
      "0observations",
      "2captures",
      "0reverts",
      "1deferrals",
      "5completions",
    ]);
    // A live (count > 0) lane gets the is-live modifier; a zero lane doesn't.
    expect(
      container.querySelector(".pc-signals__triggercard.is-live strong")
        ?.textContent,
    ).toBe("3");
    // WI-5417 item 2: the disclosure is REMOVED entirely, not just collapsed.
    expect(screen.queryByText("What recent cycles were fed")).toBeNull();
  });

  it("renders the browseable digest-history strip and asks for the clicked cycle via nuqs + query args", () => {
    syncResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<SignalsPanel />);
    expect(screen.getByText("What will it read?")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: /Digest history/ })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    // The newest cycle (index 0) is selected by default (matches digest.cycleId).
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[1].getAttribute("aria-selected")).toBe("false");
    // Clicking the OLDER cycle asks nuqs to select it by cycleId.
    fireEvent.click(tabs[1]);
    expect(nuqsSetters.sdig).toHaveBeenCalledWith("scout-2");
    // Clicking the NEWEST cycle clears the selection (null) rather than
    // round-tripping its own id — keeps the URL clean at the default view.
    fireEvent.click(tabs[0]);
    expect(nuqsSetters.sdig).toHaveBeenCalledWith(null);
  });

  it("threads the nuqs-selected cycle id through to the sync query args", () => {
    nuqsState.sdig = "scout-2";
    syncResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<SignalsPanel />);
    expect(lastQueryArgs).toEqual({ cycleId: "scout-2" });
  });

  it("shows the selected cycle's new-vs-standing digest entries", () => {
    syncResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<SignalsPanel />);
    expect(screen.getByText("agents keep re-deriving the same fix")).toBeTruthy();
    // CARDS (owner ask 2026-07-19) split the old combined "new · <lane>" chip
    // into a lane chip plus a separate NEW flag — assert both parts rather than
    // the concatenated string the row layout used to produce.
    expect(screen.getAllByText("recurring friction").length).toBeGreaterThan(0);
    expect(screen.getAllByText("new").length).toBeGreaterThan(0);
    // Standing corpus lives behind its own disclosure trigger.
    expect(screen.getByText("Standing corpus")).toBeTruthy();
  });

  it("groups the lane taxonomy into Trigger lanes / Fed lanes, each lane carrying a categorical color", () => {
    syncResult = { data: [snapshot], loading: false, fetching: false, error: null, invalidate: vi.fn() };
    render(<SignalsPanel />);
    // The taxonomy is reference material behind the header "?" popover (owner
    // ask 2026-07-19) — closed by default, so open it first.
    fireEvent.click(screen.getByRole("button", { name: /Explain all input lanes/ }));
    expect(screen.getByText("Trigger lanes — what fires a cycle")).toBeTruthy();
    expect(screen.getByText("Fed lanes — what the digest reads")).toBeTruthy();
    // "captures" appears both as a trigger card label and a taxonomy lane. The
    // lane's categorical color is still carried inline — but as of the card
    // layout (owner ask 2026-07-19) the CARD declares `--lane-color` (it paints
    // the left edge) and the chip inherits it, so assert on whichever ancestor
    // actually declares the var rather than pinning one element.
    const colored = screen
      .getAllByText("captures")
      .map((el) => el.closest<HTMLElement>("[style*='--lane-color']"))
      .find((el): el is HTMLElement => el !== null);
    expect(colored).toBeTruthy();
    expect(colored!.style.getPropertyValue("--lane-color")).toBeTruthy();
  });

  it("renders the empty state when no signal data has ever been recorded", () => {
    syncResult = {
      data: [
        {
          totalRouted: 0,
          railCounts: [],
          recent: [],
          lastTick: null,
          ticks: [],
          health: { status: "neutral", markers: [] },
          lensWeights: null,
          groundingTitles: {},
          cadence: null,
          drafts: [],
          digest: null,
          digestHistory: [],
        },
      ],
      loading: false,
      fetching: false,
      error: null,
      invalidate: vi.fn(),
    };
    render(<SignalsPanel />);
    expect(
      screen.getByText(/No signal state recorded yet/),
    ).toBeTruthy();
  });
});
