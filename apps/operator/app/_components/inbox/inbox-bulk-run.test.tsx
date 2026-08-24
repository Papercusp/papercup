// @vitest-environment jsdom
/**
 * BULK RESOLVE client-seam coverage (inbox-bulk-resolve-2026-08-23, P-007).
 *
 * What these pin, and why each one is a real defect rather than a restatement
 * of the implementation:
 *
 *   - deriveRunCounts reads the ITEM ROWS and the run's `totalItems`, so the
 *     progress bar cannot slide backwards while rows arrive, and cannot
 *     disagree with the list beneath it.
 *   - recommendationValidity is pinned to `attentionItemToCardSpec` — the same
 *     projection the hand-resolve card renders — so a recommendation naming an
 *     id the item no longer offers is caught at render instead of failing on
 *     click. This is the LOCKSTEP test: it drives the real card spec, not a
 *     hand-written option list that could agree with a broken projection.
 *   - a NAVIGATE-only action is never acceptable. `discuss` missing from
 *     NAVIGATE_ACTION_IDS is what once let Discuss silently resolve real owner
 *     gates (EI-13037); this asserts every id in that set is refused, so the
 *     two files cannot drift apart.
 *   - accept RESOLVES FIRST and RECORDS SECOND, and a failed resolve records
 *     NOTHING — a recorded acceptance whose resolve failed is a lie about
 *     something done on the owner's behalf (D-003).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";

const H = vi.hoisted(() => ({
  resolveAttentionAction: vi.fn(),
  replyToAttentionItem: vi.fn(),
  calls: [] as string[],
}));

// The client resolve helpers are the SEAM under test: we assert they are
// called, never re-implement them. Everything else in attention-card (the card
// spec projection, NAVIGATE_ACTION_IDS) is the REAL module on purpose — the
// lockstep assertions below are worthless against a stub.
vi.mock("@/app/admin/plans/attention-card", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/app/admin/plans/attention-card")>();
  return {
    ...real,
    resolveAttentionAction: (...args: unknown[]) => {
      H.calls.push("resolve");
      return H.resolveAttentionAction(...args);
    },
    replyToAttentionItem: (...args: unknown[]) => {
      H.calls.push("reply");
      return H.replyToAttentionItem(...args);
    },
  };
});

import InboxBulkRecommendation, {
  recommendationValidity,
} from "./InboxBulkRecommendation";
import {
  deriveRunCounts,
  isActivePhase,
  useBulkRunOps,
  type BulkRunItem,
} from "./use-inbox-bulk-run";
import { formatRunElapsed, toBulkSeed } from "./InboxBulkStrip";
import {
  NAVIGATE_ACTION_IDS,
  attentionItemToCardSpec,
} from "@/app/admin/plans/attention-card";

function mkItem(id: string, over: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: "coord-escalation",
    source: "coord",
    harnessSlug: "papercusp",
    planSlug: null,
    itemRef: null,
    title: `Title of ${id}`,
    body: `Body of ${id}`,
    status: "open",
    importance: "normal",
    tier: "decision",
    needsHuman: true,
    ownerAgentId: "su-abc",
    ownerLabel: "su · su-abc",
    triageState: "untriaged",
    triageNote: null,
    triagedBy: null,
    triagedAt: null,
    actions: [
      { id: "ack", label: "Acknowledge", primary: true },
      { id: "drop", label: "Drop" },
      { id: "chat", label: "Chat" },
    ],
    ref: { kind: "coord-escalation", msgId: `m-${id}` },
    ...over,
  } as AttentionItem;
}

function mkRec(over: Partial<BulkRunItem> = {}): BulkRunItem {
  return {
    runId: "run-1",
    itemId: "a",
    position: 0,
    kind: "coord-escalation",
    title: "Title of a",
    outcome: "recommended",
    actionId: "ack",
    rationale: "Blocker already cleared.",
    draftAnswer: null,
    confidence: "high",
    consulted: false,
    consultReply: null,
    error: null,
    decidedAt: null,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  H.calls.length = 0;
});

describe("deriveRunCounts", () => {
  const run = { runId: "r", phase: "running", totalItems: 10 } as never;

  it("counts from the ITEM ROWS, not the run’s denormalized counters", () => {
    // The run row deliberately carries counters that DISAGREE with the rows —
    // they are recomputed asynchronously after each report, so during a run they
    // legitimately trail. The rows are what the pane is rendering, so the rows win.
    const stale = {
      ...(run as object),
      autoResolved: 99,
      recommended: 99,
    } as never;
    const c = deriveRunCounts(
      [
        mkRec({ itemId: "1", outcome: "auto_resolved" }),
        mkRec({ itemId: "2", outcome: "recommended" }),
        mkRec({ itemId: "3", outcome: "skipped" }),
        mkRec({ itemId: "4", outcome: "failed" }),
      ],
      stale,
    );
    expect(c.resolved).toBe(1);
    expect(c.forReview).toBe(1);
    expect(c.skipped).toBe(1);
    expect(c.failed).toBe(1);
  });

  it("divides by the run’s totalItems so the bar cannot slide BACKWARD", () => {
    // Two rows in, of ten. Dividing by rows-received-so-far would read 100%.
    const c = deriveRunCounts(
      [
        mkRec({ itemId: "1", outcome: "auto_resolved" }),
        mkRec({ itemId: "2", outcome: "recommended" }),
      ],
      run,
    );
    expect(c.total).toBe(10);
    expect(c.decided).toBe(2);
    expect(c.left).toBe(8);
    expect(c.percent).toBe(20);
  });

  it("treats a pending row as UNDECIDED — an unreached item is not progress", () => {
    const c = deriveRunCounts(
      [mkRec({ itemId: "1", outcome: "pending" })],
      run,
    );
    expect(c.decided).toBe(0);
    expect(c.percent).toBe(0);
  });

  it("never divides by zero on an empty run", () => {
    expect(deriveRunCounts([], null).percent).toBe(0);
  });
});

describe("isActivePhase", () => {
  it("admits exactly the non-terminal phases", () => {
    expect(
      ["pending", "running", "review"].every((p) => isActivePhase(p as never)),
    ).toBe(true);
    expect(["complete", "failed"].some((p) => isActivePhase(p as never))).toBe(
      false,
    );
    expect(isActivePhase(null)).toBe(false);
  });
});

describe("formatRunElapsed", () => {
  it("renders sub-minute and minute+second runs", () => {
    const t0 = "2026-08-23T12:00:00.000Z";
    expect(formatRunElapsed(t0, "2026-08-23T12:00:18.000Z")).toBe("18s");
    expect(formatRunElapsed(t0, "2026-08-23T12:02:40.000Z")).toBe("2m 40s");
  });

  it("returns null rather than a fake zero when the run never started", () => {
    expect(formatRunElapsed(null, null)).toBeNull();
    expect(formatRunElapsed("not-a-date", null)).toBeNull();
  });
});

describe("toBulkSeed", () => {
  it("posts the pane’s OWN snapshot of each row — ids, not filters", () => {
    const seed = toBulkSeed([mkItem("a"), mkItem("b")]);
    expect(seed.map((s) => s.itemId)).toEqual(["a", "b"]);
    expect(seed[0]).toMatchObject({
      kind: "coord-escalation",
      ownerAgentId: "su-abc",
    });
  });
});

describe("recommendationValidity — LOCKSTEP with attentionItemToCardSpec", () => {
  it("accepts an id the item actually offers", () => {
    const item = mkItem("a");
    // Corroborate against the real projection rather than trusting the fixture.
    expect(
      attentionItemToCardSpec(item).options?.some((o) => o.id === "ack"),
    ).toBe(true);
    expect(recommendationValidity(item, "ack")).toEqual({ valid: true });
  });

  it("REFUSES an id the item no longer offers", () => {
    const item = mkItem("a", { actions: [{ id: "drop", label: "Drop" }] });
    const v = recommendationValidity(item, "ack");
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/no longer offered/);
  });

  it("REFUSES every NAVIGATE-only action, for the whole set — no drift", () => {
    // Drives NAVIGATE_ACTION_IDS itself, so adding an id there without teaching
    // this path about it cannot pass. `discuss` slipping out of that set is what
    // once let Discuss silently resolve owner gates (EI-13037).
    expect(NAVIGATE_ACTION_IDS.size).toBeGreaterThan(0);
    for (const id of NAVIGATE_ACTION_IDS) {
      const item = mkItem("a", { actions: [{ id, label: id }] });
      const v = recommendationValidity(item, id);
      expect(v.valid, `${id} must not be acceptable`).toBe(false);
      expect(v.reason).toMatch(/resolves nothing/);
    }
  });

  it('reports NOT-YET-KNOWN, not "no longer offered", before the detail fetch lands', () => {
    // The LIST feed drops `actions`; they arrive with the per-item detail. Calling
    // that "no longer offered" would flash a false warning on every first paint.
    const v = recommendationValidity(
      mkItem("a", { actions: undefined }),
      "ack",
    );
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/loading/i);
  });

  it("refuses a recommendation naming no action at all", () => {
    expect(recommendationValidity(mkItem("a"), null).valid).toBe(false);
  });
});

describe("InboxBulkRecommendation render", () => {
  it("marks the pre-picked option and shows the rationale", () => {
    render(
      <InboxBulkRecommendation
        item={mkItem("a")}
        rec={mkRec()}
        onAccept={async () => ({ ok: true })}
      />,
    );
    expect(screen.getByTestId("inbox-bulk-pill-a-ack").className).toMatch(
      /is-selected/,
    );
    expect(screen.getByTestId("inbox-bulk-pill-a-drop").className).not.toMatch(
      /is-selected/,
    );
    expect(screen.getByText("Blocker already cleared.")).toBeTruthy();
  });

  it("DISABLES accept when the recommended option is no longer offered", () => {
    const item = mkItem("a", { actions: [{ id: "drop", label: "Drop" }] });
    render(
      <InboxBulkRecommendation
        item={item}
        rec={mkRec()}
        onAccept={async () => ({ ok: true })}
      />,
    );
    expect(
      (screen.getByTestId("inbox-bulk-accept-a") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/no longer offered/);
  });

  it("flags a LOW-confidence recommendation as an inference, not evidence", () => {
    render(
      <InboxBulkRecommendation
        item={mkItem("a")}
        rec={mkRec({ confidence: "low", consulted: true, consultReply: null })}
        onAccept={async () => ({ ok: true })}
      />,
    );
    expect(screen.getByText("low confidence")).toBeTruthy();
    expect(screen.getByText("asker did not reply")).toBeTruthy();
  });
});

describe("acceptRecommendation — resolve FIRST, record SECOND", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
  });

  /** Drive the hook through a throwaway component (hooks need a render). */
  function useOps() {
    let ops: ReturnType<typeof useBulkRunOps> | null = null;
    function Probe() {
      ops = useBulkRunOps();
      return null;
    }
    render(<Probe />);
    return () => ops!;
  }

  it("dispatches resolveAttentionAction, THEN records the acceptance", async () => {
    H.resolveAttentionAction.mockResolvedValue({ resolved: true });
    const ops = useOps();
    const res = await ops().acceptRecommendation("run-1", mkItem("a"), mkRec());

    expect(res.ok).toBe(true);
    expect(H.resolveAttentionAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "ack",
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({
      op: "accept",
      runId: "run-1",
      itemId: "a",
      actionId: "ack",
    });
    // Ordering is the point: the resolve must have happened before the record.
    expect(H.calls).toEqual(["resolve"]);
  });

  it("returns the resulting run phase so the grouped report can close on the last accept", async () => {
    H.resolveAttentionAction.mockResolvedValue({ resolved: true });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, phase: "complete" }),
    });
    const ops = useOps();

    await expect(
      ops().acceptRecommendation("run-1", mkItem("a"), mkRec()),
    ).resolves.toMatchObject({ ok: true, phase: "complete" });
  });

  it("DELIVERS the drafted reply when the item’s path takes free text", async () => {
    H.replyToAttentionItem.mockResolvedValue({
      resolved: true,
      live: true,
      woken: 1,
    });
    const ops = useOps();
    await ops().acceptRecommendation(
      "run-1",
      mkItem("a"),
      mkRec({ draftAnswer: "Use the dev key." }),
    );

    expect(H.replyToAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "Use the dev key.",
    );
    expect(H.resolveAttentionAction).not.toHaveBeenCalled();
  });

  it("records NOTHING when the resolve did not take", async () => {
    H.resolveAttentionAction.mockResolvedValue({ resolved: false });
    const ops = useOps();
    const res = await ops().acceptRecommendation("run-1", mkItem("a"), mkRec());

    expect(res.ok).toBe(false);
    // The failure this guards: an accepted-looking record for a resolution that
    // never happened, on the owner's behalf.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a NAVIGATE action before touching the network", async () => {
    const ops = useOps();
    const res = await ops().acceptRecommendation(
      "run-1",
      mkItem("a"),
      mkRec({ actionId: "chat" }),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/resolves nothing/);
    expect(H.resolveAttentionAction).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
