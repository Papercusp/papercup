// @vitest-environment jsdom
/** Grouped plan clean-up report behavior (cleanup-report-flows P-007). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const H = vi.hoisted(() => ({
  calls: [] as string[],
  setItemStatus: vi.fn(),
  setPlanArchived: vi.fn(),
  setPlanLifecycleStatus: vi.fn(),
  accept: vi.fn(),
  dismiss: vi.fn(),
  resume: vi.fn(),
  dismissFinding: vi.fn(),
  recheckFinding: vi.fn(),
}));

vi.mock("@/app/admin/plans/plans-api", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/app/admin/plans/plans-api")>();
  return {
    ...real,
    setItemStatus: (...args: unknown[]) => {
      H.calls.push("write:item");
      return H.setItemStatus(...args);
    },
    setPlanArchived: (...args: unknown[]) => {
      H.calls.push("write:archive");
      return H.setPlanArchived(...args);
    },
    setPlanLifecycleStatus: (...args: unknown[]) => {
      H.calls.push("write:plan");
      return H.setPlanLifecycleStatus(...args);
    },
  };
});

vi.mock("./use-plan-cleanup-run", async (importOriginal) => {
  const real = await importOriginal<typeof import("./use-plan-cleanup-run")>();
  return {
    ...real,
    usePlanCleanupOps: () => ({
      accept: (...args: unknown[]) => {
        H.calls.push("record:accept");
        return H.accept(...args);
      },
      dismiss: (...args: unknown[]) => H.dismiss(...args),
      resume: (...args: unknown[]) => H.resume(...args),
      dismissFinding: (...args: unknown[]) => H.dismissFinding(...args),
      recheckFinding: (...args: unknown[]) => H.recheckFinding(...args),
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
});

import PlanCleanupReport, {
  applyPlanCleanupFinding,
  buildPlanCleanupReviewGroups,
  planCleanupReviewConfidence,
} from "./PlanCleanupReport";
import {
  partitionReviewRows,
  reviewRowVerb,
} from "../review-report/ReviewReportShell";
import type {
  PlanCleanupFinding,
  PlanCleanupRun,
} from "./use-plan-cleanup-run";

function run(): PlanCleanupRun {
  return {
    runId: "run-7",
    phase: "review",
    runKind: "plan-cleanup",
    seedRefs: ["p-one"],
    totalItems: 1,
    autoResolved: 0,
    recommended: 1,
    skipped: 0,
    failed: 0,
    error: null,
    createdAt: "2026-08-24T12:00:00Z",
    startedAt: "2026-08-24T12:00:01Z",
    finishedAt: "2026-08-24T12:00:02Z",
  };
}

function finding(over: Partial<PlanCleanupFinding> = {}): PlanCleanupFinding {
  return {
    runId: "run-7",
    findingId: "flip:p-one#P-001",
    kind: "flip-to-done",
    planSlug: "p-one",
    harnessSlug: "papercusp",
    itemId: "P-001",
    target: "p-one#P-001",
    from: "todo",
    to: "done",
    confidence: "recommended",
    evidence: [
      { kind: "work-item", ref: "WI-1", note: "done with completion" },
    ],
    position: 0,
    outcome: "recommended",
    error: null,
    decidedAt: null,
    ...over,
  };
}

/** Canonical observed Plan run shape from the P-007 acceptance evidence:
 * 12 concrete hand edits plus 12 stale-Now findings requiring authored prose. */
function observedPlanFindings(): PlanCleanupFinding[] {
  return [
    ...Array.from({ length: 12 }, (_, index) =>
      finding({
        findingId: `ready-${index}`,
        kind: "flip-to-done",
        planSlug: `plan-${index}`,
        itemId: `P-${String(index + 1).padStart(3, "0")}`,
        target: `plan-${index}#P-${String(index + 1).padStart(3, "0")}`,
        position: index,
      }),
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      finding({
        findingId: `manual-${index}`,
        kind: "stale-now",
        planSlug: `plan-${index + 12}`,
        itemId: null,
        target: `plan-${index + 12} ## Now`,
        position: index + 12,
      }),
    ),
  ];
}

beforeEach(() => {
  H.calls.length = 0;
  H.setItemStatus.mockReset().mockResolvedValue({ ok: true });
  H.setPlanArchived.mockReset().mockResolvedValue({ ok: true });
  H.setPlanLifecycleStatus.mockReset().mockResolvedValue({ ok: true });
  H.accept.mockReset().mockResolvedValue({ ok: true, phase: "review" });
  H.dismiss.mockReset().mockResolvedValue(undefined);
  H.resume
    .mockReset()
    .mockResolvedValue({ ok: true, phase: "running", launched: true });
  H.dismissFinding.mockReset().mockResolvedValue({ ok: true, phase: "review" });
  H.recheckFinding
    .mockReset()
    .mockResolvedValue({ ok: true, resolved: true, phase: "review" });
});

afterEach(cleanup);

describe("buildPlanCleanupReviewGroups", () => {
  it("preserves canonical confidence and fails closed for unassessed operational rows", () => {
    for (const confidence of [
      "high",
      "medium",
      "low",
      "insufficient",
    ] as const) {
      expect(
        planCleanupReviewConfidence(
          finding({
            recommendation: {
              kind: "owner_action",
              label: "Review",
              rationale: "Recorded rationale",
              evidenceBasis: ["recorded evidence"],
              confidence,
              responsibility: "owner",
              actionId: null,
            },
            confidenceLevel: confidence === "low" ? "high" : null,
          }),
        ),
      ).toBe(confidence);
    }

    expect(
      planCleanupReviewConfidence(
        finding({ recommendation: null, confidenceLevel: "medium" }),
      ),
    ).toBe("medium");
    expect(
      planCleanupReviewConfidence(
        finding({
          outcome: "accepted",
          recommendation: null,
          confidenceLevel: null,
          confidence: "provable",
        }),
      ),
    ).toBe("high");
    expect(
      planCleanupReviewConfidence(
        finding({
          outcome: "recommended",
          recommendation: null,
          confidenceLevel: null,
          confidence: "recommended",
        }),
      ),
    ).toBe("medium");
    for (const outcome of ["pending", "failed"] as const) {
      expect(
        planCleanupReviewConfidence(
          finding({
            outcome,
            recommendation: null,
            confidenceLevel: null,
            confidence: "recommended",
          }),
        ),
      ).toBe("insufficient");
    }
  });

  it("groups the four review families and selects only concrete recommended hand edits", () => {
    const groups = buildPlanCleanupReviewGroups([
      finding({ findingId: "flip", kind: "flip-to-done" }),
      finding({ findingId: "blocker", kind: "cleared-blocker", to: "todo" }),
      finding({
        findingId: "archive",
        kind: "archive-candidate",
        itemId: null,
      }),
      finding({ findingId: "now", kind: "stale-now", itemId: null }),
      finding({
        findingId: "claim",
        kind: "orphaned-claim",
        outcome: "pending",
      }),
    ]);

    // P-004/P-009: a finding the resolver never reached leads the report in its
    // own group. It is unstarted work, not a fix kind — the only thing that
    // clears it is resuming the run, so it must not sit inside a kind group
    // captioned "Clear stale blockers".
    expect(groups.map((group) => group.id)).toEqual([
      "not-assessed",
      "flip-to-done",
      "clear-stale-blockers",
      "finish-or-archive",
      "refresh-now",
    ]);
    const rows = groups.flatMap((group) => group.rows);
    expect(rows.filter((row) => row.selectable).map((row) => row.id)).toEqual([
      "flip",
      "blocker",
      "archive",
    ]);
    expect(rows.find((row) => row.id === "flip")).toMatchObject({
      sourceLabel: "p-one",
      referenceLabel: "P-001",
      transition: { from: "todo", to: "done" },
      accounting: "ready",
    });
    expect(rows.find((row) => row.id === "now")).toMatchObject({
      selectable: false,
      accounting: "manual",
    });
    expect(rows.find((row) => row.id === "claim")).toMatchObject({
      selectable: false,
      // Was "not-applied", which read as "deliberately skipped" for a row the
      // resolver simply never got to (P-004).
      accounting: "not-assessed",
    });
    // The verb is now a KEY into the shared vocabulary rather than a literal
    // label, so the row and the commit button cannot word the same action
    // differently. Assert the key, and that it still resolves to "Assess".
    const claimAction = rows.find((row) => row.id === "claim")?.action;
    expect(claimAction).toMatchObject({ key: "assess" });
    expect(claimAction && reviewRowVerb(claimAction)).toBe("Assess");
  });

  it("matches the observed 24-row Plan partition and exposes every manual row", () => {
    const findings = observedPlanFindings();
    const groups = buildPlanCleanupReviewGroups(findings);

    expect(groups.flatMap((group) => group.rows)).toHaveLength(24);
    expect(partitionReviewRows(groups)).toEqual({
      results: 24,
      ready: 12,
      handled: 0,
      manual: 12,
      notAssessed: 0,
      notApplied: 0,
    });

    render(
      <PlanCleanupReport
        run={{ ...run(), totalItems: 24, recommended: 24 }}
        findings={findings}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("review-report-results-count").textContent).toBe(
      "24",
    );
    expect(screen.getByTestId("review-report-ready-count").textContent).toBe(
      "12",
    );
    expect(screen.getByTestId("review-report-handled-count").textContent).toBe(
      "0",
    );
    expect(screen.getByTestId("review-report-manual-count").textContent).toBe(
      "12",
    );
    expect(
      screen.getByTestId("review-report-not-applied-count").textContent,
    ).toBe("0");
    expect(document.querySelectorAll("[data-review-row-id]")).toHaveLength(24);
    expect(screen.getAllByText("Refresh Now")).toHaveLength(1);
  });
});

describe("applyPlanCleanupFinding", () => {
  it("dispatches item, plan, and archive findings through their canonical client seams", async () => {
    await expect(applyPlanCleanupFinding(finding())).resolves.toEqual({
      ok: true,
    });
    // P-011: the recorded `from` rides along as a compare-and-set precondition,
    // so a report applied hours after its scan is REFUSED rather than writing
    // over whatever the item became in the meantime.
    expect(H.setItemStatus).toHaveBeenCalledWith({
      slug: "p-one",
      itemId: "P-001",
      status: "done",
      expectedStatus: "todo",
      harness: "papercusp",
    });

    await applyPlanCleanupFinding(
      finding({ kind: "finish-plan", itemId: null }),
    );
    expect(H.setPlanLifecycleStatus).toHaveBeenCalledWith(
      "p-one",
      "shipped",
      "papercusp",
    );

    await applyPlanCleanupFinding(
      finding({ kind: "archive-candidate", itemId: null }),
    );
    expect(H.setPlanArchived).toHaveBeenCalledWith({
      slug: "p-one",
      archived: true,
      harness: "papercusp",
    });
  });

  it("refuses a stale-Now recommendation because no replacement prose was authored", async () => {
    const result = await applyPlanCleanupFinding(
      finding({
        kind: "stale-now",
        itemId: null,
        to: "rewrite to reflect open work",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/author/i);
    expect(H.setItemStatus).not.toHaveBeenCalled();
  });
});

describe("PlanCleanupReport", () => {
  it("applies only selected actionable rows, then records acceptance second", async () => {
    const onClose = vi.fn();
    render(
      <PlanCleanupReport
        run={run()}
        findings={[finding()]}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("plans:set-status")).toBeTruthy();

    fireEvent.click(screen.getByTestId("review-report-apply"));
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(1));
    expect(H.calls).toEqual(["write:item", "record:accept"]);
    expect(H.accept).toHaveBeenCalledWith(
      "run-7",
      "flip:p-one#P-001",
      "Grouped report accepted: todo → done",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("announces a failed hand edit and takes the row OUT of the pending pool", async () => {
    H.setItemStatus.mockResolvedValue({
      ok: false,
      error: "The plan write was rejected.",
    });
    render(
      <PlanCleanupReport
        run={run()}
        findings={[finding()]}
        onClose={vi.fn()}
      />,
    );

    const apply = screen.getByTestId(
      "review-report-apply",
    ) as HTMLButtonElement;
    apply.focus();
    fireEvent.click(apply);

    const alert = await screen.findByTestId(
      "review-row-error-flip:p-one#P-001",
    );
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("plan write was rejected");
    expect(H.accept).not.toHaveBeenCalled();
    // P-010: focus lands on the FAILED ROW, not on the header buttons. The
    // failure empties the selection, and the old "nothing selected ⇒ focus
    // Dismiss" rule parked keyboard focus on CLOSE right after a failure —
    // inviting the owner to discard the only surface naming what did not land.
    expect(document.activeElement).toBe(
      screen.getByTestId("review-row-flip:p-one#P-001"),
    );

    // A failed row LEAVES the pending pool: pressing Apply again must
    // not blind-re-dispatch a write that just failed for an unknown reason.
    // It is hoisted into its own "Failed to apply" group, keeps its reason,
    // and carries a Retry verb — recovery becomes a deliberate act.
    expect(screen.getByTestId("review-group-apply-failed")).toBeTruthy();
    expect(
      screen.getByTestId("review-row-verb-flip:p-one#P-001").textContent,
    ).toContain("Retry");
    expect(
      screen.queryByTestId("review-row-check-flip:p-one#P-001"),
    ).toBeNull();
    expect(apply.textContent).toContain("(0)");

    // …and the retry path is the ROW's own menu, which re-dispatches exactly
    // that one finding rather than the whole previous selection.
    H.setItemStatus.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByTestId("review-row-menu-flip:p-one#P-001"));
    fireEvent.click(
      screen.getByTestId("review-row-menu-flip:p-one#P-001-apply-one"),
    );
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByTestId("review-row-error-flip:p-one#P-001"),
    ).toBeNull();
    expect(
      screen.getByTestId("review-row-mark-flip:p-one#P-001").textContent,
    ).toBe("✓");
  });

  it("renders stale Now as a visible manual row with no checkbox", () => {
    const stale = finding({
      findingId: "now",
      kind: "stale-now",
      itemId: null,
      target: "p-one ## Now",
    });
    const onOpenFinding = vi.fn();
    render(
      <PlanCleanupReport
        run={run()}
        findings={[stale]}
        onOpenFinding={onOpenFinding}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("review-row-now")).toBeTruthy();
    expect(screen.queryByTestId("review-row-check-now")).toBeNull();
    expect(screen.getByTestId("review-row-mark-now").textContent).toBe("↗");
    expect(
      (screen.getByTestId("review-report-apply") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("review-row-now"));
    expect(screen.getByTestId("plan-cleanup-recheck-now")).toBeTruthy();
    expect(screen.getByTestId("plan-cleanup-retry-now")).toBeTruthy();
    expect(screen.getByTestId("plan-cleanup-dismiss-now")).toBeTruthy();
    fireEvent.click(screen.getByTestId("plan-cleanup-open-now"));
    expect(onOpenFinding).toHaveBeenCalledWith(stale);
  });

  it("rechecks a manual edit, reconciles the row, and keeps the report open while work remains", async () => {
    const stale = finding({
      findingId: "now",
      kind: "stale-now",
      itemId: null,
      target: "p-one ## Now",
    });
    render(
      <PlanCleanupReport run={run()} findings={[stale]} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("review-row-now"));
    fireEvent.click(screen.getByTestId("plan-cleanup-recheck-now"));

    await waitFor(() =>
      expect(H.recheckFinding).toHaveBeenCalledWith("run-7", "now"),
    );
    expect(screen.getByTestId("review-row-mark-now").textContent).toBe("✓");
  });

  it("retries exactly the selected unresolved finding and returns to the running strip", async () => {
    const onClose = vi.fn();
    const failed = finding({
      findingId: "failed",
      kind: "stale-now",
      itemId: null,
      outcome: "failed",
      error: "resolver exited",
    });
    render(
      <PlanCleanupReport run={run()} findings={[failed]} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId("review-row-failed"));
    fireEvent.click(screen.getByTestId("plan-cleanup-retry-failed"));

    await waitFor(() =>
      expect(H.resume).toHaveBeenCalledWith("run-7", ["failed"]),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses only the chosen unresolved finding and never completes the rest implicitly", async () => {
    const onClose = vi.fn();
    const skipped = finding({
      findingId: "skipped",
      kind: "stale-now",
      itemId: null,
      outcome: "skipped",
    });
    render(
      <PlanCleanupReport run={run()} findings={[skipped]} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId("review-row-skipped"));
    fireEvent.click(screen.getByTestId("plan-cleanup-dismiss-skipped"));

    await waitFor(() =>
      expect(H.dismissFinding).toHaveBeenCalledWith(
        "run-7",
        "skipped",
        "Owner dismissed this finding from the grouped recovery report",
      ),
    );
    expect(screen.getByTestId("review-row-mark-skipped").textContent).toBe("—");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only the report view without mutating the run", () => {
    const onClose = vi.fn();
    render(
      <PlanCleanupReport
        run={run()}
        findings={[finding()]}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("review-report-dismiss"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(H.dismiss).not.toHaveBeenCalled();
  });
});
