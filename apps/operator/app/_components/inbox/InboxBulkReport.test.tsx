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
  default: ({ rec }: { rec: BulkRunItem }) => (
    <span data-testid={`recommendation-${rec.itemId}`}>recommendation</span>
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
});
