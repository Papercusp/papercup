// @vitest-environment jsdom
/** Grouped Inbox bulk-resolve report coverage (cleanup-report-flows P-008/P-011). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  detail: vi.fn(),
  details: new Map<string, AttentionItem>(),
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
  return {
    ...real,
    usePlanAttentionItem: (id: string | null) => H.detail(id),
  };
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
    onDiscuss,
  }: {
    rec: BulkRunItem;
    onAccept: (draftOverride: string | null) => Promise<{ ok: boolean }>;
    onDiscuss?: () => void;
  }) => (
    <span>
      <button
        type="button"
        data-testid={`recommendation-${rec.itemId}`}
        onClick={() => void onAccept(null)}
      >
        recommendation
      </button>
      {onDiscuss ? (
        <button
          type="button"
          data-testid={`discuss-${rec.itemId}`}
          onClick={onDiscuss}
        >
          discuss
        </button>
      ) : null}
    </span>
  ),
}));

import InboxBulkReport, {
  buildInboxBulkReviewGroups,
  bulkRunItemToAttentionSnapshot,
} from "./InboxBulkReport";

function attention(
  id: string,
  kind: AttentionItem["kind"] = "coord-message",
  over: Partial<AttentionItem> = {},
): AttentionItem {
  return {
    id,
    kind,
    source: "coord",
    harnessSlug: "papercusp",
    title: `Live title ${id}`,
    body: `Body ${id}`,
    status: "open",
    importance: "normal",
    tier: "decision",
    needsHuman: true,
    ownerAgentId: "su-live",
    triageState: "untriaged",
    actions: [
      { id: "ack", label: "Acknowledge" },
      { id: "drop", label: "Drop" },
    ],
    ref: { kind, msgId: `m-${id}` },
    ...over,
  };
}

function runItem(over: Partial<BulkRunItem> = {}): BulkRunItem {
  return {
    runId: "run-8",
    itemId: "a",
    position: 0,
    kind: "coord-message",
    title: "Snapshot title a",
    ref: { kind: "coord-message", msgId: "m-a" },
    ownerAgentId: "su-snapshot",
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
  harnessSlug: "papercusp",
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

beforeEach(() => {
  H.details.clear();
  H.details.set("a", attention("a"));
  H.details.set("b", attention("b"));
  H.detail.mockImplementation((id: string | null) => ({
    data: id ? (H.details.get(id) ?? null) : null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("bulkRunItemToAttentionSnapshot", () => {
  it("rebuilds terminal dispatch coordinates from the persisted run row only", () => {
    const snapshot = bulkRunItemToAttentionSnapshot(runItem(), run);
    expect(snapshot).toMatchObject({
      id: "a",
      kind: "coord-message",
      source: "bulk-run-snapshot",
      harnessSlug: "papercusp",
      title: "Snapshot title a",
      ownerAgentId: "su-snapshot",
      ref: { kind: "coord-message", msgId: "m-a" },
    });
    expect(snapshot?.actions).toBeUndefined();
  });

  it("fails closed when the persisted kind and ref discriminant disagree", () => {
    expect(
      bulkRunItemToAttentionSnapshot(
        runItem({ ref: { kind: "coord-escalation", msgId: "m-a" } }),
        run,
      ),
    ).toBeNull();
  });
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
          kind: "coord-escalation",
          ref: { kind: "coord-escalation", msgId: "m-c" },
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
    ).toMatchObject({ status: "dismissed", selectable: false });
  });

  it("keeps only a non-empty drafted Answer selectable among navigate actions", () => {
    const items = new Map([["a", attention("a")]]);
    const drafted = buildInboxBulkReviewGroups(
      [runItem({ actionId: "answer", draftAnswer: "Use the dev key." })],
      items,
    );
    const empty = buildInboxBulkReviewGroups(
      [runItem({ actionId: "answer", draftAnswer: "   " })],
      items,
    );
    expect(drafted[0]?.rows[0]?.selectable).toBe(true);
    expect(empty[0]?.rows[0]?.selectable).toBe(false);
  });
});

describe("<InboxBulkReport>", () => {
  it("applies selected persisted snapshots in run order and closes on completion", async () => {
    H.accept
      .mockResolvedValueOnce({ ok: true, phase: "review" })
      .mockResolvedValueOnce({ ok: true, phase: "complete" });
    const onClose = vi.fn();
    render(
      <InboxBulkReport
        run={{ ...run, totalItems: 2, recommended: 2, autoResolved: 0 }}
        runItems={[
          runItem({ itemId: "a", position: 1 }),
          runItem({
            itemId: "b",
            position: 0,
            actionId: "drop",
            ref: { kind: "coord-message", msgId: "m-b" },
          }),
        ]}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("review-report-apply"));
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(2));
    expect(H.accept.mock.calls.map((call) => call[1].id)).toEqual(["b", "a"]);
    expect(H.accept.mock.calls[0]?.[1]).toMatchObject({
      source: "bulk-run-snapshot",
      ref: { msgId: "m-b" },
    });
    expect(H.detail).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps a stale-target failure visible and unrecorded for retry", async () => {
    H.accept
      .mockResolvedValueOnce({ ok: true, phase: "review" })
      .mockResolvedValueOnce({
        ok: false,
        phase: "review",
        error: "The Inbox action was rejected as stale.",
      });
    render(
      <InboxBulkReport
        run={{ ...run, totalItems: 2, recommended: 2, autoResolved: 0 }}
        runItems={[
          runItem({ itemId: "a", position: 0 }),
          runItem({
            itemId: "b",
            position: 1,
            ref: { kind: "coord-message", msgId: "m-b" },
          }),
        ]}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("review-report-apply"));
    const alert = await screen.findByTestId("review-row-error-b");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("rejected as stale");
    expect(screen.getByTestId("review-row-mark-a").textContent).toBe("✓");
    expect(screen.getByTestId("review-report-apply").textContent).toContain(
      "(1)",
    );
  });

  it("hydrates only the one active hover/focus detail", () => {
    render(
      <InboxBulkReport
        run={{ ...run, totalItems: 2, recommended: 2, autoResolved: 0 }}
        runItems={[
          runItem(),
          runItem({
            itemId: "b",
            position: 1,
            ref: { kind: "coord-message", msgId: "m-b" },
          }),
        ]}
        onClose={vi.fn()}
      />,
    );

    expect(H.detail).not.toHaveBeenCalled();
    const rowA = screen.getByTestId("review-row-a");
    fireEvent.pointerEnter(rowA);
    expect(screen.getByTestId("review-row-detail-a")).toBeTruthy();
    expect(screen.getByTestId("recommendation-a")).toBeTruthy();
    expect(H.detail).toHaveBeenLastCalledWith("a");

    fireEvent.pointerLeave(rowA);
    fireEvent.focus(screen.getByTestId("review-row-check-b"));
    expect(screen.queryByTestId("review-row-detail-a")).toBeNull();
    expect(screen.getByTestId("review-row-detail-b")).toBeTruthy();
    expect(screen.getByTestId("recommendation-b")).toBeTruthy();
    expect(H.detail).toHaveBeenLastCalledWith("b");
  });

  it("shows a terminal stale-item message instead of an endless loading state", () => {
    H.details.delete("a");
    render(
      <InboxBulkReport run={run} runItems={[runItem()]} onClose={vi.fn()} />,
    );

    fireEvent.pointerEnter(screen.getByTestId("review-row-a"));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(
      "no longer available in the live Inbox",
    );
    expect(screen.queryByTestId("recommendation-a")).toBeNull();
  });

  it("routes inline accept and Discuss through the hydrated current item", async () => {
    const live = attention("a", "coord-message", {
      ownerAgentId: "su-current",
      harnessSlug: "current-harness",
      ref: { kind: "coord-message", msgId: "m-current" },
    });
    H.details.set("a", live);
    H.accept.mockResolvedValue({ ok: true, phase: "review" });
    const onOpenThread = vi.fn();
    render(
      <InboxBulkReport
        run={run}
        runItems={[runItem()]}
        onOpenThread={onOpenThread}
        onClose={vi.fn()}
      />,
    );

    fireEvent.pointerEnter(screen.getByTestId("review-row-a"));
    fireEvent.click(screen.getByTestId("discuss-a"));
    expect(onOpenThread).toHaveBeenCalledWith(live);

    fireEvent.click(screen.getByTestId("recommendation-a"));
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(1));
    expect(H.accept.mock.calls[0]?.[1]).toMatchObject({
      ownerAgentId: "su-current",
      harnessSlug: "current-harness",
      ref: { msgId: "m-current" },
    });
  });
});
