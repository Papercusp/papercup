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
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
});

import PlanCleanupReport, {
  applyPlanCleanupFinding,
  buildPlanCleanupReviewGroups,
} from "./PlanCleanupReport";
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

beforeEach(() => {
  H.calls.length = 0;
  H.setItemStatus.mockReset().mockResolvedValue({ ok: true });
  H.setPlanArchived.mockReset().mockResolvedValue({ ok: true });
  H.setPlanLifecycleStatus.mockReset().mockResolvedValue({ ok: true });
  H.accept.mockReset().mockResolvedValue({ ok: true, phase: "review" });
  H.dismiss.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("buildPlanCleanupReviewGroups", () => {
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

    expect(groups.map((group) => group.id)).toEqual([
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
    });
    expect(rows.find((row) => row.id === "now")?.selectable).toBe(false);
    expect(rows.find((row) => row.id === "claim")?.selectable).toBe(false);
  });
});

describe("applyPlanCleanupFinding", () => {
  it("dispatches item, plan, and archive findings through their canonical client seams", async () => {
    await expect(applyPlanCleanupFinding(finding())).resolves.toEqual({
      ok: true,
    });
    expect(H.setItemStatus).toHaveBeenCalledWith({
      slug: "p-one",
      itemId: "P-001",
      status: "done",
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

  it("announces a failed hand edit and keeps the row selected for retry", async () => {
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
    expect(document.activeElement).toBe(apply);
    expect(apply.disabled).toBe(false);
    expect(apply.textContent).toContain("(1)");
    expect(screen.getByTestId("review-report-status").textContent).toBe(
      "1 of 1 selectable recommendation selected.",
    );

    H.setItemStatus.mockResolvedValueOnce({ ok: true });
    fireEvent.click(apply);
    await waitFor(() => expect(H.accept).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByTestId("review-row-error-flip:p-one#P-001"),
    ).toBeNull();
    expect(
      screen.getByTestId("review-row-mark-flip:p-one#P-001").textContent,
    ).toBe("✓");
    expect(apply.disabled).toBe(true);
    expect(apply.textContent).toContain("(0)");
    expect(screen.getByTestId("review-report-status").textContent).toBe(
      "0 of 0 selectable recommendations selected.",
    );
  });

  it("renders stale Now as a visible manual row with no checkbox", () => {
    const stale = finding({
      findingId: "now",
      kind: "stale-now",
      itemId: null,
      target: "p-one ## Now",
    });
    render(
      <PlanCleanupReport run={run()} findings={[stale]} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId("review-row-now")).toBeTruthy();
    expect(screen.queryByTestId("review-row-check-now")).toBeNull();
    expect(screen.getByTestId("review-row-mark-now").textContent).toBe("↗");
    expect(
      (screen.getByTestId("review-report-apply") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("closes the takeover only after the run dismiss succeeds", async () => {
    const onClose = vi.fn();
    render(
      <PlanCleanupReport
        run={run()}
        findings={[finding()]}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("review-report-dismiss"));
    await waitFor(() => expect(H.dismiss).toHaveBeenCalledWith("run-7"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
