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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { AttentionItem } from "@/app/admin/plans/plans-api";

const H = vi.hoisted(() => ({
  resolveAttentionAction: vi.fn(),
  replyToAttentionItem: vi.fn(),
  reclassify: vi.fn(),
  calls: [] as string[],
  resolverProfile: {
    model: "sonnet",
    effort: "high" as const,
    account: "auto",
    carry: "warm" as const,
  },
}));

vi.mock("../bulk-resolver/bulk-resolver-settings", () => ({
  loadResolverLaunchProfile: async () => H.resolverProfile,
  useBulkResolverSettings: () => ({
    profile: H.resolverProfile,
    loading: false,
    saving: false,
    error: null,
    validationError: null,
    ready: true,
    updateProfile: vi.fn(),
    retry: vi.fn(),
  }),
}));
vi.mock("../bulk-resolver/BulkResolverSettingsControl", () => ({
  default: ({ kind, effective }: { kind: string; effective?: unknown }) => (
    <div
      data-testid={`${kind}-settings-control`}
      data-effective={effective ? JSON.stringify(effective) : undefined}
    />
  ),
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
  isContinuableBulkRunItem,
  useBulkRunOps,
  type BulkRun,
  type BulkRunItem,
} from "./use-inbox-bulk-run";
import InboxBulkStrip, { formatRunElapsed, toBulkSeed } from "./InboxBulkStrip";
import {
  NAVIGATE_ACTION_IDS,
  attentionItemToCardSpec,
} from "@/app/admin/plans/attention-card";
import { PERF_INTERACTIONS } from "../perf/perf-marks";

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
    ref: { kind: "coord-escalation", msgId: "m-a" },
    ownerAgentId: "su-abc",
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
  performance.clearMarks?.();
  performance.clearMeasures?.();
});

describe("deriveRunCounts", () => {
  const run: BulkRun = {
    runId: "r",
    phase: "running",
    totalItems: 10,
    autoResolved: 0,
    recommended: 0,
    skipped: 0,
    failed: 0,
    error: null,
    createdAt: null,
    startedAt: null,
    finishedAt: null,
  };

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

  it("counts pending separately so the review strip can account for every outcome", () => {
    const c = deriveRunCounts(
      [
        mkRec({ itemId: "pending", outcome: "pending" }),
        mkRec({ itemId: "skipped", outcome: "skipped" }),
        mkRec({ itemId: "failed", outcome: "failed" }),
      ],
      { ...run, totalItems: 3 },
    );
    expect(c.pending).toBe(1);
    expect(c.skipped).toBe(1);
    expect(c.failed).toBe(1);
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

describe("isContinuableBulkRunItem", () => {
  it("includes unresolved resolver outcomes but preserves recommendations and terminal rows", () => {
    const outcomes: BulkRunItem["outcome"][] = [
      "pending",
      "skipped",
      "failed",
      "recommended",
      "auto_resolved",
      "dismissed",
    ];
    expect(
      outcomes.filter((outcome) =>
        isContinuableBulkRunItem(mkRec({ outcome })),
      ),
    ).toEqual(["pending", "skipped", "failed"]);
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

describe("InboxBulkStrip review handoff", () => {
  it("opens the grouped report with the exact persisted run instead of applying from the strip", () => {
    const onReview = vi.fn();
    const recommendations = [
      mkRec({ itemId: "a" }),
      mkRec({ itemId: "b", position: 1 }),
    ];
    render(
      <InboxBulkStrip
        visible={[]}
        filterSnapshot={{}}
        run={{
          runId: "run-latest-without-param",
          phase: "review",
          totalItems: 2,
          autoResolved: 0,
          recommended: 2,
          skipped: 0,
          failed: 0,
          error: null,
          createdAt: "2026-08-25T00:00:00.000Z",
          startedAt: "2026-08-25T00:00:00.000Z",
          finishedAt: "2026-08-25T00:00:10.000Z",
        }}
        items={recommendations}
        recommendations={recommendations}
        unreached={[]}
        isRunning={false}
        isReview
        onRunStarted={vi.fn()}
        onReview={onReview}
      />,
    );

    const review = screen.getByTestId("inbox-bulk-review-decisions");
    expect(review.textContent).toContain("Review 2 unresolved");
    expect(screen.queryByTestId("inbox-bulk-accept-all")).toBeNull();
    fireEvent.click(review);
    expect(onReview).toHaveBeenCalledWith("run-latest-without-param");
    expect(
      performance.getEntriesByName(
        `${PERF_INTERACTIONS.inboxBulkReportOpen}:start`,
        "mark",
      ),
    ).toHaveLength(1);
  });

  it("continues all 105 untouched rows from a 127-item prior run while preserving its 22 outcomes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        phase: "running",
        launched: true,
        preservedOutcomes: 22,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const recommendations = Array.from({ length: 9 }, (_, position) =>
      mkRec({ itemId: `review-${position}`, position }),
    );
    const resolved = Array.from({ length: 13 }, (_, index) =>
      mkRec({
        itemId: `resolved-${index}`,
        position: recommendations.length + index,
        outcome: "auto_resolved",
      }),
    );
    const unreached = Array.from({ length: 105 }, (_, index) =>
      mkRec({
        itemId: `remaining-${index}`,
        position: recommendations.length + resolved.length + index,
        outcome: "pending",
        actionId: null,
      }),
    );

    render(
      <InboxBulkStrip
        visible={[]}
        filterSnapshot={{ tier: "decision" }}
        run={{
          runId: "run-partial-127",
          phase: "review",
          totalItems: 127,
          autoResolved: 13,
          recommended: 9,
          skipped: 0,
          failed: 0,
          error: null,
          createdAt: "2026-08-25T00:00:00.000Z",
          startedAt: "2026-08-25T00:00:00.000Z",
          finishedAt: "2026-08-25T00:05:00.000Z",
        }}
        items={[...recommendations, ...resolved, ...unreached]}
        recommendations={recommendations}
        unreached={unreached}
        isRunning={false}
        isReview
        onRunStarted={vi.fn()}
        onReview={vi.fn()}
      />,
    );

    expect(screen.getByTestId("inbox-bulk-review-headline").textContent).toContain(
      "127 assessed · 13 auto-resolved · 114 still open",
    );
    const continueButton = screen.getByTestId("inbox-bulk-continue");
    expect(continueButton.textContent).toContain("Continue 105 retryable");
    fireEvent.click(continueButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({
      op: "resume",
      runId: "run-partial-127",
      itemIds: unreached.map((item) => item.itemId),
    });
  });

  it("surfaces and retries skipped rows in the observed 158-item partition", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        phase: "running",
        launched: true,
        preservedOutcomes: 22,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const recommendations = Array.from({ length: 9 }, (_, position) =>
      mkRec({ itemId: `review-${position}`, position }),
    );
    const resolved = Array.from({ length: 13 }, (_, index) =>
      mkRec({
        itemId: `resolved-${index}`,
        position: recommendations.length + index,
        outcome: "auto_resolved",
      }),
    );
    const skipped = Array.from({ length: 136 }, (_, index) =>
      mkRec({
        itemId: `skipped-${index}`,
        position: recommendations.length + resolved.length + index,
        outcome: "skipped",
        actionId: null,
      }),
    );
    const items = [...recommendations, ...resolved, ...skipped];
    const continuable = items.filter(isContinuableBulkRunItem);
    expect(items).toHaveLength(158);
    expect(continuable).toHaveLength(136);

    render(
      <InboxBulkStrip
        visible={[]}
        filterSnapshot={{ tier: "decision" }}
        run={{
          runId: "run-partial-158",
          phase: "review",
          totalItems: 158,
          autoResolved: 13,
          recommended: 9,
          skipped: 136,
          failed: 0,
          error: null,
          createdAt: "2026-08-25T00:00:00.000Z",
          startedAt: "2026-08-25T00:00:00.000Z",
          finishedAt: "2026-08-25T00:05:00.000Z",
        }}
        items={items}
        recommendations={recommendations}
        unreached={continuable}
        isRunning={false}
        isReview
        onRunStarted={vi.fn()}
        onReview={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("inbox-bulk-review-headline").textContent,
    ).toContain("158 assessed · 13 auto-resolved · 145 still open");
    expect(screen.getByTestId("inbox-bulk-continue").textContent).toContain(
      "Continue 136 retryable",
    );
    fireEvent.click(screen.getByTestId("inbox-bulk-continue"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({
      op: "resume",
      runId: "run-partial-158",
      itemIds: skipped.map((item) => item.itemId),
    });
  });

  it("surfaces the classified 158-item partition with a truthful unresolved total", () => {
    const recommendations = Array.from({ length: 9 }, (_, position) =>
      mkRec({ itemId: `typed-review-${position}`, position }),
    );
    const resolved = Array.from({ length: 13 }, (_, index) =>
      mkRec({
        itemId: `typed-resolved-${index}`,
        position: recommendations.length + index,
        outcome: "auto_resolved",
      }),
    );
    const makeLegacy = (
      index: number,
      disposition: "owner_action" | "cleanup_candidate" | "retry_needed" | "routed" | "investigate",
      error: string,
    ) =>
      mkRec({
        itemId: `typed-skipped-${index}`,
        position: recommendations.length + resolved.length + index,
        outcome: "skipped",
        disposition,
        legacyDisposition: "legacy_skipped",
        recommendationKind: disposition,
        recommendationLabel: disposition.replace(/_/g, " "),
        recommendationRationale: error,
        evidenceBasis: [error],
        responsibility: disposition === "routed" ? "engineering" : "owner",
        confidenceLevel: disposition === "retry_needed" || disposition === "investigate" ? "insufficient" : "high",
        error,
        actionId: null,
      });
    const skipped = [
      ...Array.from({ length: 21 }, (_, i) => makeLegacy(i, "owner_action", "owner authority")),
      ...Array.from({ length: 24 }, (_, i) => makeLegacy(i + 21, "owner_action", "owner-attended dependency")),
      ...Array.from({ length: 15 }, (_, i) => makeLegacy(i + 45, "cleanup_candidate", "Moot: stale duplicate")),
      ...Array.from({ length: 3 }, (_, i) => makeLegacy(i + 60, "retry_needed", "detail not loaded")),
      makeLegacy(63, "routed", "real defect report; engineering work"),
      ...Array.from({ length: 72 }, (_, i) => makeLegacy(i + 64, "investigate", "No terminal option offered")),
    ];
    const items = [...recommendations, ...resolved, ...skipped];
    expect(items).toHaveLength(158);
    render(
      <InboxBulkStrip
        visible={[]}
        filterSnapshot={{ tier: "decision" }}
        run={{
          runId: "run-typed-158",
          phase: "review",
          totalItems: 158,
          autoResolved: 13,
          recommended: 9,
          skipped: 136,
          failed: 0,
          error: null,
          createdAt: null,
          startedAt: null,
          finishedAt: null,
        }}
        items={items}
        recommendations={recommendations}
        unreached={skipped.filter((item) => item.disposition === "retry_needed")}
        isRunning={false}
        isReview
        onRunStarted={vi.fn()}
        onReview={vi.fn()}
      />,
    );
    expect(screen.getByTestId("inbox-bulk-review-headline").textContent).toContain(
      "158 assessed · 13 auto-resolved · 145 still open",
    );
    const accounting = screen.getByTestId("inbox-bulk-accounting").textContent;
    expect(accounting).toContain("9 recommendations");
    expect(accounting).toContain("45 owner actions");
    expect(accounting).toContain("15 cleanup candidates");
    expect(accounting).toContain("3 retry needed");
    expect(accounting).toContain("1 routed");
    expect(accounting).toContain("72 investigate");
    expect(accounting).toContain("136 legacy skips classified above");
    expect(screen.getByTestId("inbox-bulk-continue").textContent).toContain(
      "Continue 3 retryable",
    );
    expect(screen.getByTestId("inbox-bulk-classify").textContent).toContain(
      "Classify 136 legacy skips",
    );
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

  it("allows ONLY the real answer + non-empty draft combination through the navigation rail", () => {
    const item = mkItem("a", { actions: [{ id: "answer", label: "Answer" }] });
    expect(NAVIGATE_ACTION_IDS.has("answer")).toBe(true);
    expect(
      attentionItemToCardSpec(item).options?.some((o) => o.id === "answer"),
    ).toBe(true);

    expect(recommendationValidity(item, "answer").valid).toBe(false);
    expect(recommendationValidity(item, "answer", "   ").valid).toBe(false);
    expect(recommendationValidity(item, "answer", "Use the dev key.")).toEqual({
      valid: true,
    });
    expect(recommendationValidity(item, "chat", "Use the dev key.").valid).toBe(
      false,
    );
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

  it("enables the drafted Answer exception and passes the non-empty draft to acceptance", async () => {
    const onAccept = vi.fn().mockResolvedValue({ ok: true });
    const item = mkItem("a", { actions: [{ id: "answer", label: "Answer" }] });
    render(
      <InboxBulkRecommendation
        item={item}
        rec={mkRec({ actionId: "answer", draftAnswer: "Use the dev key." })}
        onAccept={onAccept}
      />,
    );

    const accept = screen.getByTestId(
      "inbox-bulk-accept-a",
    ) as HTMLButtonElement;
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);
    await waitFor(() =>
      expect(onAccept).toHaveBeenCalledWith("Use the dev key."),
    );
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

  it("disables Accept, draft editing, and Discuss together while the report is busy", () => {
    const onDiscuss = vi.fn();
    const props = {
      item: mkItem("a"),
      rec: mkRec({ draftAnswer: "Draft answer" }),
      onAccept: async () => ({ ok: true }),
      onDiscuss,
    };
    const { rerender } = render(<InboxBulkRecommendation {...props} />);
    fireEvent.click(screen.getByTestId("inbox-bulk-edit-a"));
    expect(screen.getByTestId("inbox-bulk-draft-a")).toBeTruthy();

    rerender(<InboxBulkRecommendation {...props} busy />);

    expect(
      (screen.getByTestId("inbox-bulk-accept-a") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("inbox-bulk-edit-a") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("inbox-bulk-discuss-a") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("inbox-bulk-draft-a") as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("inbox-bulk-discuss-a"));
    expect(onDiscuss).not.toHaveBeenCalled();
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

  it("posts the pane’s click-time resolver profile with the start snapshot", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, runId: "run-new", launched: true }),
    });
    const ops = useOps();
    await ops().start(
      [
        {
          itemId: "a",
          kind: "coord-escalation",
          title: "A",
          ref: {},
          ownerAgentId: null,
        },
      ],
      { tier: "decision" },
      null,
      H.resolverProfile,
    );
    expect(
      JSON.parse(fetchMock.mock.calls[0]![1].body as string),
    ).toMatchObject({
      items: [{ itemId: "a" }],
      filter: { tier: "decision" },
      launch: H.resolverProfile,
    });
  });

  it("routes selected retry, per-row dismissal, and source reconciliation through the owner endpoint", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          phase: "running",
          launched: true,
          preservedOutcomes: 13,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, phase: "review", dismissed: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, phase: "complete", reconciled: true }),
      });
    const ops = useOps();

    await expect(
      ops().resume("run-1", [" item-a ", "item-a"]),
    ).resolves.toMatchObject({
      ok: true,
      phase: "running",
      launched: true,
      preservedOutcomes: 13,
    });
    await expect(
      ops().dismissItem("run-1", "item-b", "Owner declined it"),
    ).resolves.toEqual({ ok: true, phase: "review" });
    await expect(ops().reconcileItem("run-1", "item-c")).resolves.toEqual({
      ok: true,
      phase: "complete",
    });

    expect(
      fetchMock.mock.calls
        .slice(-3)
        .map((call) => JSON.parse(call[1].body as string)),
    ).toEqual([
      { op: "resume", runId: "run-1", itemIds: ["item-a"] },
      {
        op: "dismiss-item",
        runId: "run-1",
        itemId: "item-b",
        note: "Owner declined it",
      },
      { op: "reconcile-item", runId: "run-1", itemId: "item-c" },
    ]);
  });

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

  it("DELIVERS a drafted Answer, THEN records the acceptance", async () => {
    H.replyToAttentionItem.mockResolvedValue({
      resolved: true,
      live: true,
      woken: 1,
    });
    const ops = useOps();
    const item = mkItem("a", { actions: [{ id: "answer", label: "Answer" }] });
    const result = await ops().acceptRecommendation(
      "run-1",
      item,
      mkRec({ actionId: "answer", draftAnswer: "Use the dev key." }),
    );

    expect(result.ok).toBe(true);
    expect(H.replyToAttentionItem).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "Use the dev key.",
    );
    expect(H.resolveAttentionAction).not.toHaveBeenCalled();
    expect(H.calls).toEqual(["reply"]);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({
      op: "accept",
      runId: "run-1",
      itemId: "a",
      actionId: "answer",
    });
  });

  it("does not let stray draft text change a non-answer action’s dispatch path", async () => {
    H.resolveAttentionAction.mockResolvedValue({ resolved: true });
    const ops = useOps();

    await ops().acceptRecommendation(
      "run-1",
      mkItem("a"),
      mkRec({
        actionId: "ack",
        draftAnswer: "This must not be sent as a reply.",
      }),
    );

    expect(H.resolveAttentionAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a" }),
      "ack",
    );
    expect(H.replyToAttentionItem).not.toHaveBeenCalled();
  });

  it("refuses Answer with an empty draft before dispatch or bookkeeping", async () => {
    const ops = useOps();
    const item = mkItem("a", { actions: [{ id: "answer", label: "Answer" }] });
    const result = await ops().acceptRecommendation(
      "run-1",
      item,
      mkRec({ actionId: "answer", draftAnswer: "   " }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/resolves nothing/);
    expect(H.resolveAttentionAction).not.toHaveBeenCalled();
    expect(H.replyToAttentionItem).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
