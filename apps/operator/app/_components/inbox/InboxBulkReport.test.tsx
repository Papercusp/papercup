// @vitest-environment jsdom
/** Grouped Inbox bulk-resolve report coverage (cleanup-report-flows P-008). */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";
import type { BulkRun, BulkRunItem } from "./use-inbox-bulk-run";

const H = vi.hoisted(() => ({
  accept: vi.fn(),
  dismiss: vi.fn(),
  hydrate: vi.fn((item: AttentionItem) => ({ item, hydrated: true })),
}));

vi.mock("./use-inbox-bulk-run", async (importOriginal) => {
  const real = await importOriginal<typeof import("./use-inbox-bulk-run")>();
  return {
    ...real,
    useBulkRunOps: () => ({
      acceptRecommendation: H.accept,
      dismiss: H.dismiss,
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
});

vi.mock("@/app/admin/plans/plans-api", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/app/admin/plans/plans-api")>();
  return { ...real, useHydratedAttentionItem: H.hydrate };
});

vi.mock("@/app/admin/plans/PlanOtherList", () => ({
  KIND_LABEL: {
    "coord-message": "Message",
    "coord-escalation": "Escalation",
  },
}));

vi.mock("./InboxBulkRecommendation", () => ({
  default: ({
    rec,
    onAccept,
  }: {
    rec: BulkRunItem;
    onAccept: (draftOverride: string | null) => Promise<{ ok: boolean }>;
  }) => (
    <button
      type="button"
      data-testid={`recommendation-${rec.itemId}`}
      onClick={() => void onAccept(null)}
    >
      recommendation
    </button>
  ),
}));

import InboxBulkReport, { buildInboxBulkReviewGroups } from "./InboxBulkReport";

function attention(
  id: string,
  kind: AttentionItem["kind"] = "coord-message",
): AttentionItem {
  return {
    id,
    kind,
    source: "coord",
    title: `Title ${id}`,
    body: `Body ${id}`,
    status: "open",
    importance: "normal",
    tier: "decision",
    needsHuman: true,
    triageState: "untriaged",
    actions: [
      { id: "ack", label: "Acknowledge" },
      { id: "drop", label: "Drop" },
    ],
    ref: { kind },
  };
}

function runItem(over: Partial<BulkRunItem> = {}): BulkRunItem {
  return {
    runId: "run-8",
    itemId: "a",
    position: 0,
    kind: "coord-message",
    title: "Title a",
    outcome: "recommended",
    actionId: "ack",
    rationale: "The request is satisfied.",
    draftAnswer: null,
    confidence: "high",
    consulted: false,
    consultReply: null,
    error: null,
    decidedAt: null,
    ...over,
  };
}

const run: BulkRun = {
  runId: "run-8",
  phase: "review",
  totalItems: 3,
  autoResolved: 1,
  recommended: 2,
  skipped: 0,
  failed: 0,
  error: null,
  createdAt: null,
  startedAt: null,
  finishedAt: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("buildInboxBulkReviewGroups", () => {
  it("groups by recommended action + kind and preserves report statuses", () => {
    const items = new Map([
      ["a", attention("a")],
      ["b", attention("b")],
      ["c", attention("c", "coord-escalation")],
    ]);
    const groups = buildInboxBulkReviewGroups(
      [
        runItem({ itemId: "a", position: 0 }),
        runItem({ itemId: "b", position: 1, outcome: "auto_resolved" }),
        runItem({
          itemId: "c",
          position: 2,
          outcome: "skipped",
          actionId: null,
        }),
      ],
      items,
    );

    const ack = groups.find((group) => group.title === "Acknowledge · Message");
    expect(ack?.rows).toHaveLength(2);
    expect(ack?.rows.find((row) => row.id === "a")).toMatchObject({
      status: "pending",
      selectable: true,
      confidence: "recommended",
      sourceLabel: "Message",
      referenceLabel: "Acknowledge",
    });
    expect(ack?.rows.find((row) => row.id === "b")).toMatchObject({
      status: "applied",
      selectable: false,
      confidence: "provable",
    });
    expect(
      groups.find((group) => group.title === "Skipped · Escalation")?.rows[0],
    ).toMatchObject({
      status: "dismissed",
      selectable: false,
    });
  });
});

describe("<InboxBulkReport>", () => {
  it("applies selected rows in run order and closes when the last accept completes the run", async () => {
    H.accept
      .mockResolvedValueOnce({ ok: true, phase: "review" })
      .mockResolvedValueOnce({ ok: true, phase: "complete" });
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    render(
      <InboxBulkReport
        run={run}
        runItems={[
          runItem({ itemId: "a", position: 1 }),
          runItem({ itemId: "b", position: 0, actionId: "drop" }),
        ]}
        attentionItems={[attention("a"), attention("b")]}
        onRefresh={onRefresh}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("review-report-apply"));
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(2));
    expect(H.accept.mock.calls.map((call) => call[1].id)).toEqual(["b", "a"]);
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("announces a partial apply failure, keeps its decision desk, and leaves the failed row focused for retry", async () => {
    H.accept
      .mockResolvedValueOnce({ ok: true, phase: "review" })
      .mockResolvedValueOnce({
        ok: false,
        phase: "review",
        error: "The Inbox action was rejected.",
      });
    const onClose = vi.fn();
    render(
      <InboxBulkReport
        run={{ ...run, totalItems: 2, recommended: 2, autoResolved: 0 }}
        runItems={[
          runItem({ itemId: "a", position: 0 }),
          runItem({ itemId: "b", position: 1 }),
        ]}
        attentionItems={[attention("a"), attention("b")]}
        onClose={onClose}
      />,
    );

    const apply = screen.getByTestId(
      "review-report-apply",
    ) as HTMLButtonElement;
    apply.focus();
    fireEvent.click(apply);

    const alert = await screen.findByTestId("review-row-error-b");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Inbox action was rejected");
    expect(screen.getByTestId("inbox-bulk-drill-b")).toBeTruthy();
    expect(screen.getByTestId("review-row-mark-a").textContent).toBe("✓");
    expect(document.activeElement).toBe(apply);
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toContain("(1)");
    expect(screen.getByTestId("review-report-status").textContent).toBe(
      "1 of 1 selectable recommendation selected.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("hydrates only the active focused decision desk and closes the previous desk", () => {
    render(
      <InboxBulkReport
        run={{ ...run, totalItems: 2, recommended: 2, autoResolved: 0 }}
        runItems={[runItem(), runItem({ itemId: "b", position: 1 })]}
        attentionItems={[attention("a"), attention("b")]}
        onClose={vi.fn()}
      />,
    );

    expect(H.hydrate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("inbox-bulk-drill-a"));
    expect(screen.getByTestId("inbox-bulk-decision-desk-a")).toBeTruthy();
    expect(screen.getByTestId("recommendation-a")).toBeTruthy();
    expect(H.hydrate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("inbox-bulk-drill-b"));
    expect(screen.queryByTestId("inbox-bulk-decision-desk-a")).toBeNull();
    expect(screen.getByTestId("inbox-bulk-decision-desk-b")).toBeTruthy();
    expect(screen.getByTestId("recommendation-b")).toBeTruthy();
    expect(
      screen.getByTestId("inbox-bulk-drill-a").getAttribute("aria-expanded"),
    ).toBe("false");
    expect(H.hydrate).toHaveBeenCalledTimes(2);
  });

  it("closes a decision desk on Escape and returns focus to its toggle", () => {
    render(
      <InboxBulkReport
        run={run}
        runItems={[runItem()]}
        attentionItems={[attention("a")]}
        onClose={vi.fn()}
      />,
    );

    const toggle = screen.getByTestId("inbox-bulk-drill-a");
    fireEvent.click(toggle);
    const recommendation = screen.getByTestId("recommendation-a");
    recommendation.focus();
    fireEvent.keyDown(recommendation, { key: "Escape" });

    expect(screen.queryByTestId("inbox-bulk-decision-desk-a")).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("restores focus to the surviving toggle after an inline accept closes the desk", async () => {
    H.accept.mockResolvedValue({ ok: true, phase: "review" });
    render(
      <InboxBulkReport
        run={run}
        runItems={[runItem()]}
        attentionItems={[attention("a")]}
        onClose={vi.fn()}
      />,
    );

    const toggle = screen.getByTestId("inbox-bulk-drill-a");
    fireEvent.click(toggle);
    const accept = screen.getByTestId("recommendation-a");
    accept.focus();
    fireEvent.click(accept);

    await waitFor(() =>
      expect(screen.queryByTestId("inbox-bulk-decision-desk-a")).toBeNull(),
    );
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps focus in the report when live props remove the active desk and then its row", () => {
    const onClose = vi.fn();
    const report = (runItems: BulkRunItem[], attentionItems: AttentionItem[]) => (
      <InboxBulkReport
        run={run}
        runItems={runItems}
        attentionItems={attentionItems}
        onClose={onClose}
      />
    );
    const item = runItem();
    const { rerender } = render(report([item], [attention("a")]));

    fireEvent.click(screen.getByTestId("inbox-bulk-drill-a"));
    const recommendation = screen.getByTestId("recommendation-a");
    recommendation.focus();

    // The attention feed is live: resolving the item elsewhere removes the
    // desk/toggle while its persisted run row can still remain in the report.
    rerender(report([item], []));
    const survivingRow = screen.getByTestId("review-row-a");
    expect(screen.queryByTestId("inbox-bulk-drill-a")).toBeNull();
    expect(document.activeElement).toBe(survivingRow);

    // A later run refresh may remove the row too. Dismiss is the nearest
    // stable report action after both the row and its group disappear.
    rerender(report([], []));
    expect(screen.queryByTestId("review-row-a")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByTestId("review-report-dismiss"),
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
