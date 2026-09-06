// @vitest-environment jsdom
/**
 * InboxBriefing — the aside's unselected state in split mode
 * (inbox-three-column-resolver-states-2026-09-06 P-005 / D-002).
 *
 * Rendered directly with run fixtures: `InboxPane.test.tsx` pins WHERE the
 * briefing mounts and what the pane hands it; this pins WHAT it says from the
 * run rows — the tiles, the readout line, the grouped disposition rows (an
 * umbrella plus typed subsets, deliberately non-summing) and the Review op.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import InboxBriefing, {
  briefingHeadline,
  deriveRunDispositionRows,
} from "./InboxBriefing";
import {
  deriveRunCounts,
  type BulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";

afterEach(cleanup);

function mkRun(over: Partial<BulkRun> = {}): BulkRun {
  return {
    runId: "run-1",
    phase: "review",
    totalItems: 6,
    autoResolved: 1,
    recommended: 3,
    skipped: 0,
    failed: 1,
    error: null,
    createdAt: "2026-09-06T00:00:00.000Z",
    startedAt: "2026-09-06T00:00:00.000Z",
    finishedAt: "2026-09-06T00:01:30.000Z",
    ...over,
  };
}

function mkRunItem(
  itemId: string,
  outcome: BulkRunItem["outcome"],
  over: Partial<BulkRunItem> = {},
): BulkRunItem {
  return {
    runId: "run-1",
    itemId,
    position: 0,
    kind: "coord-message",
    title: itemId,
    ref: {},
    ownerAgentId: null,
    outcome,
    actionId: null,
    rationale: null,
    draftAnswer: null,
    confidence: null,
    consulted: false,
    consultReply: null,
    error: null,
    decidedAt: null,
    ...over,
  };
}

const typed = (kind: "owner_action" | "cleanup_candidate") =>
  ({ kind, label: kind }) as BulkRunItem["recommendation"];

/** 1 auto-resolved · 3 recommended (owner action, cleanup, untyped) ·
 *  1 pending · 1 failed. */
const reviewItems: BulkRunItem[] = [
  mkRunItem("a", "auto_resolved"),
  mkRunItem("b", "recommended", { recommendation: typed("owner_action") }),
  mkRunItem("c", "recommended", {
    recommendation: typed("cleanup_candidate"),
  }),
  mkRunItem("d", "recommended"),
  mkRunItem("e", "pending"),
  mkRunItem("f", "failed"),
];

describe("InboxBriefing", () => {
  it("no run: the headline reads the scope count, run-derived tiles show —, no readout, the feed is last", () => {
    render(
      <InboxBriefing
        needs={2}
        tracked={180}
        run={null}
        runItems={[]}
        isRunning={false}
        onReview={vi.fn()}
        feed={<div data-testid="feed" />}
      />,
    );
    const briefing = screen.getByTestId("inbox-briefing");
    expect(screen.getByTestId("inbox-briefing-headline").textContent).toBe(
      "2 items are waiting on you",
    );
    expect(screen.getByTestId("inbox-briefing-tile-need-you").textContent).toBe(
      "2Need you",
    );
    expect(
      screen.getByTestId("inbox-briefing-tile-still-open").textContent,
    ).toBe("—Still open");
    expect(
      screen.getByTestId("inbox-briefing-tile-auto-resolved").textContent,
    ).toBe("—Auto-resolved");
    expect(screen.getByTestId("inbox-briefing-tile-tracked").textContent).toBe(
      "180Tracked",
    );
    expect(screen.queryByTestId("inbox-briefing-run")).toBeNull();
    expect(briefing.lastElementChild).toBe(screen.getByTestId("feed"));
    expect(briefing.textContent).toContain("the queue at a glance");
  });

  it("review run: readout line, umbrella + typed rows from deriveRunCounts, and Review opens the report", () => {
    const run = mkRun();
    const counts = deriveRunCounts(reviewItems, run);
    const onReview = vi.fn();
    render(
      <InboxBriefing
        needs={0}
        tracked={40}
        run={run}
        runItems={reviewItems}
        isRunning={false}
        onReview={onReview}
      />,
    );
    expect(screen.getByTestId("inbox-briefing-headline").textContent).toBe(
      "Nothing is waiting on you",
    );
    // The tiles read the run rows, never the run's denormalized counters.
    expect(
      screen.getByTestId("inbox-briefing-tile-still-open").textContent,
    ).toBe(`${counts.unresolved}Still open`);
    expect(
      screen.getByTestId("inbox-briefing-tile-auto-resolved").textContent,
    ).toBe("1Auto-resolved");
    const card = screen.getByTestId("inbox-briefing-run");
    expect(card.getAttribute("aria-label")).toBe("Last resolver run");
    expect(card.textContent).toContain("review");
    expect(card.textContent).toContain("1m 30s");
    expect(screen.getByTestId("inbox-briefing-run-line").textContent).toBe(
      `6 assessed · 1 auto-resolved · ${counts.unresolved} still open`,
    );
    // Grouped rows: the umbrella always, typed rows only when non-zero.
    const rowIds = Array.from(
      screen.getByTestId("inbox-briefing-rows").children,
    ).map((li) => li.getAttribute("data-testid"));
    expect(rowIds).toEqual([
      "inbox-briefing-row-recommendations",
      "inbox-briefing-row-owner-action",
      "inbox-briefing-row-cleanup-candidate",
      "inbox-briefing-row-retry-needed",
      "inbox-briefing-row-failed",
    ]);
    const count = (id: string) =>
      screen
        .getByTestId(`inbox-briefing-row-${id}`)
        .querySelector(".op-inbox__briefing-row-count")?.textContent;
    expect(count("recommendations")).toBe("3");
    expect(count("owner-action")).toBe("1");
    expect(count("cleanup-candidate")).toBe("1");
    expect(count("retry-needed")).toBe("1");
    expect(count("failed")).toBe("1");
    expect(
      screen
        .getByTestId("inbox-briefing-row-recommendations")
        .className.includes("is-umbrella"),
    ).toBe(true);
    const review = screen.getByTestId("inbox-briefing-review");
    expect(review.textContent).toContain(`Review ${counts.unresolved} unresolved`);
    expect(review.hasAttribute("disabled")).toBe(false);
    fireEvent.click(review);
    expect(onReview).toHaveBeenCalledWith("run-1");
  });

  it("live run: the tiles read the rows but the readout is omitted — that view is P-006's", () => {
    const run = mkRun({ phase: "running", finishedAt: null });
    render(
      <InboxBriefing
        needs={3}
        tracked={40}
        run={run}
        runItems={reviewItems}
        isRunning
        onReview={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("inbox-briefing-run")).toBeNull();
    expect(
      screen.getByTestId("inbox-briefing-tile-auto-resolved").textContent,
    ).toBe("1Auto-resolved");
  });

  it("a fully resolved run disables Review rather than hiding it", () => {
    const run = mkRun({ totalItems: 1 });
    render(
      <InboxBriefing
        needs={0}
        tracked={1}
        run={run}
        runItems={[mkRunItem("a", "auto_resolved")]}
        isRunning={false}
        onReview={vi.fn()}
      />,
    );
    const review = screen.getByTestId("inbox-briefing-review");
    expect(review.hasAttribute("disabled")).toBe(true);
    expect(review.textContent).toContain("Review 0 unresolved");
  });

  it("briefingHeadline grammar", () => {
    expect(briefingHeadline(0)).toBe("Nothing is waiting on you");
    expect(briefingHeadline(1)).toBe("1 item is waiting on you");
    expect(briefingHeadline(12)).toBe("12 items are waiting on you");
  });

  it("deriveRunDispositionRows keeps the umbrella at zero and drops empty typed rows", () => {
    const rows = deriveRunDispositionRows(deriveRunCounts([], mkRun()));
    expect(rows.map((r) => r.id)).toEqual(["recommendations"]);
    expect(rows[0]?.count).toBe(0);
    expect(rows[0]?.umbrella).toBe(true);
  });
});
