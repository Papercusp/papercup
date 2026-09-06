// @vitest-environment jsdom
/**
 * InboxBriefing — the aside's unselected state in split mode
 * (inbox-three-column-resolver-states-2026-09-06 P-005 / P-006 / D-002).
 *
 * Rendered directly with run fixtures: `InboxPane.test.tsx` pins WHERE the
 * briefing mounts and what the pane hands it; this pins WHAT it says from the
 * run rows — the tiles, the readout line, the grouped disposition rows (an
 * umbrella plus typed subsets, deliberately non-summing), the Review op, and
 * the LIVE view: progress, the three counts, the launch receipt, Stop and
 * Restart. The gestures go through the REAL `useBulkRunActions` with `fetch`
 * stubbed, so the assertion is on the op posted — the same op the rail card
 * posts — not on a mocked handler.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import InboxBriefing, {
  REVIEW_HEADLINE,
  RUNNING_HEADLINE,
  briefingHeadline,
  deriveRunDispositionRows,
  resumeScopeCopy,
} from "./InboxBriefing";
import {
  deriveRunCounts,
  isContinuableBulkRunItem,
  type BulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";
import { formatResolverLaunchReceipt } from "../bulk-resolver/BulkResolverSettingsControl";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A `fetch` that answers every bulk-resolve op with `json`. */
function stubOps(json: Record<string, unknown> = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => json,
  });
  vi.stubGlobal("fetch", fetchMock);
  const postedBody = (n = 0) =>
    JSON.parse(fetchMock.mock.calls[n]![1].body as string) as Record<
      string,
      unknown
    >;
  return { fetchMock, postedBody };
}

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
    // A persisted `review` phase IS the review state (P-007): the headline
    // names it, and the lead points at the groups.
    expect(screen.getByTestId("inbox-briefing-headline").textContent).toBe(
      REVIEW_HEADLINE,
    );
    expect(screen.getByTestId("inbox-briefing").textContent).toContain(
      "open the review to work a group",
    );
    // No `unreached` handed in → no resume control, no scope statement.
    expect(screen.queryByTestId("inbox-briefing-resume")).toBeNull();
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

  it("live run (P-006): the headline flips to the run; the card carries progress, the three counts and the launch receipt; Stop posts the rail card's op", async () => {
    const { fetchMock, postedBody } = stubOps();
    const run = mkRun({
      phase: "running",
      finishedAt: null,
      launchSnapshot: {
        model: "sonnet",
        effort: "high",
        account: "auto",
        carry: "warm",
      },
    });
    const counts = deriveRunCounts(reviewItems, run);
    const onKeepWorking = vi.fn();
    render(
      <InboxBriefing
        needs={3}
        tracked={40}
        run={run}
        runItems={reviewItems}
        isRunning
        onReview={vi.fn()}
        onKeepWorking={onKeepWorking}
        feed={<div data-testid="feed" />}
      />,
    );
    const briefing = screen.getByTestId("inbox-briefing");
    expect(briefing.getAttribute("data-briefing-state")).toBe("running");
    expect(screen.getByTestId("inbox-briefing-headline").textContent).toBe(
      RUNNING_HEADLINE,
    );
    // The glance grid yields to the run; the last-run readout is not shown
    // either — one run card, in one state.
    expect(screen.queryByTestId("inbox-briefing-grid")).toBeNull();
    expect(screen.queryByTestId("inbox-briefing-run")).toBeNull();
    const card = screen.getByTestId("inbox-briefing-running");
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(
      screen.getByTestId("inbox-briefing-running-decided").textContent,
    ).toBe(`${counts.decided} / ${counts.total}`);
    const bar = card.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe(String(counts.percent));
    // The three counts read the rows through deriveRunCounts — the strip's
    // numbers, in tiles.
    expect(screen.getByTestId("inbox-briefing-tile-resolved").textContent).toBe(
      `${counts.resolved}Resolved`,
    );
    expect(
      screen.getByTestId("inbox-briefing-tile-for-review").textContent,
    ).toBe(`${counts.forReview}For review`);
    expect(screen.getByTestId("inbox-briefing-tile-left").textContent).toBe(
      `${counts.left}Left`,
    );
    // The receipt is the control's own formatter over the click-time snapshot.
    expect(
      screen.getByTestId("inbox-briefing-launch-receipt").textContent,
    ).toBe(formatResolverLaunchReceipt(run.launchSnapshot));
    expect(screen.queryByTestId("inbox-briefing-resolver-stale")).toBeNull();
    // The feed still rides last.
    expect(briefing.lastElementChild).toBe(screen.getByTestId("feed"));
    fireEvent.click(screen.getByTestId("inbox-briefing-keep-working"));
    expect(onKeepWorking).toHaveBeenCalledTimes(1);
    // Stop → the SAME op the rail card fires (D-002), on this exact run.
    fireEvent.click(screen.getByTestId("inbox-briefing-stop"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedBody()).toEqual({ op: "stop", runId: "run-1" });
  });

  it("live run: a stale resolver is called out, and Restart posts the restart op then reports the preserved outcomes", async () => {
    const { fetchMock, postedBody } = stubOps({
      launched: true,
      preservedOutcomes: 2,
    });
    const run = mkRun({
      phase: "running",
      finishedAt: null,
      liveness: { state: "stale", ageMs: 120_000, measuredFrom: "heartbeat" },
    });
    render(
      <InboxBriefing
        needs={0}
        tracked={1}
        run={run}
        runItems={reviewItems}
        isRunning
        onReview={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("inbox-briefing-resolver-stale").textContent,
    ).toContain("Resolver stopped reporting");
    // No onKeepWorking → no button; the aside is not pretending it can act.
    expect(screen.queryByTestId("inbox-briefing-keep-working")).toBeNull();
    fireEvent.click(screen.getByTestId("inbox-briefing-restart"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedBody()).toEqual({ op: "restart", runId: "run-1" });
    await waitFor(() =>
      expect(screen.getByTestId("inbox-briefing-notice").textContent).toBe(
        "Resolver restarted · 2 completed outcomes preserved",
      ),
    );
  });

  it("review run with unreached rows (P-007): the scope is stated beside Continue, which posts the resume op with exactly those ids and reports what was preserved", async () => {
    const { fetchMock, postedBody } = stubOps({
      launched: true,
      preservedOutcomes: 3,
    });
    const run = mkRun();
    // e (pending) + f (failed) are continuable; a/b/c/d are not.
    const unreached = reviewItems.filter(isContinuableBulkRunItem);
    expect(unreached.map((i) => i.itemId)).toEqual(["e", "f"]);
    render(
      <InboxBriefing
        needs={0}
        tracked={40}
        run={run}
        runItems={reviewItems}
        unreached={unreached}
        isRunning={false}
        onReview={vi.fn()}
      />,
    );
    // Retry needed stays a grouped row AND the resume block names its scope.
    expect(
      screen.getByTestId("inbox-briefing-row-retry-needed"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("inbox-briefing-resume-scope").textContent,
    ).toBe(resumeScopeCopy(2));
    expect(resumeScopeCopy(2)).toContain("2 rows were never reached");
    expect(resumeScopeCopy(1)).toContain("1 row was never reached");
    const cont = screen.getByTestId("inbox-briefing-continue");
    expect(cont.textContent).toContain("Continue 2 retryable");
    fireEvent.click(cont);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(postedBody()).toEqual({
      op: "resume",
      runId: "run-1",
      itemIds: ["e", "f"],
    });
    await waitFor(() =>
      expect(screen.getByTestId("inbox-briefing-notice").textContent).toBe(
        "Continuing 2 remaining · 3 prior outcomes preserved",
      ),
    );
  });

  it("a fully resolved run disables Review rather than hiding it, and offers nothing to continue", () => {
    const run = mkRun({ totalItems: 1 });
    render(
      <InboxBriefing
        needs={0}
        tracked={1}
        run={run}
        runItems={[mkRunItem("a", "auto_resolved")]}
        unreached={[]}
        isRunning={false}
        onReview={vi.fn()}
      />,
    );
    const review = screen.getByTestId("inbox-briefing-review");
    expect(review.hasAttribute("disabled")).toBe(true);
    expect(review.textContent).toContain("Review 0 unresolved");
    expect(screen.queryByTestId("inbox-briefing-resume")).toBeNull();
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
