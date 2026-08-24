// @vitest-environment jsdom
/** Plans clean-up strip + client seam coverage (cleanup-report-flows P-006). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

const H = vi.hoisted(() => ({
  syncArgs: [] as Array<Record<string, unknown>>,
  syncData: { value: undefined as unknown },
  fetch: vi.fn(),
}));

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (args: Record<string, unknown>) => {
    H.syncArgs.push(args);
    return {
      data: H.syncData.value,
      loading: false,
      error: null,
      invalidate: vi.fn(),
    };
  },
}));

import PlansCleanupStrip, {
  type PlansCleanupStripProps,
} from "./PlansCleanupStrip";
import {
  derivePlanCleanupCounts,
  snapshotPlanSlugs,
  usePlanCleanupOps,
  usePlanCleanupRun,
  type PlanCleanupFinding,
  type PlanCleanupRun,
} from "./use-plan-cleanup-run";

function run(over: Partial<PlanCleanupRun> = {}): PlanCleanupRun {
  return {
    runId: "run-1",
    phase: "running",
    runKind: "plan-cleanup",
    seedRefs: ["p-one", "p-two"],
    totalItems: 2,
    autoResolved: 0,
    recommended: 0,
    skipped: 0,
    failed: 0,
    error: null,
    createdAt: "2026-08-24T12:00:00.000Z",
    startedAt: "2026-08-24T12:00:10.000Z",
    finishedAt: null,
    ...over,
  };
}

function finding(over: Partial<PlanCleanupFinding> = {}): PlanCleanupFinding {
  return {
    runId: "run-1",
    findingId: "flip-to-done:papercusp/p-one#P-001",
    kind: "flip-to-done",
    planSlug: "p-one",
    harnessSlug: "papercusp",
    itemId: "P-001",
    target: "P-001",
    from: "todo",
    to: "done",
    confidence: "provable",
    evidence: [],
    position: 0,
    outcome: "pending",
    error: null,
    decidedAt: null,
    ...over,
  };
}

function props(
  over: Partial<PlansCleanupStripProps> = {},
): PlansCleanupStripProps {
  return {
    planSlugs: ["p-one", "p-two"],
    filterSnapshot: { query: null, shownCount: 2 },
    run: null,
    findings: [],
    recommendations: [],
    pending: [],
    isRunning: false,
    isReview: false,
    onRunStarted: vi.fn(),
    onReview: vi.fn(),
    onRunCleared: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  H.syncArgs.length = 0;
  H.syncData.value = undefined;
  H.fetch.mockReset();
  H.fetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
  vi.stubGlobal("fetch", H.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("plan clean-up derivation", () => {
  it("snapshots the pane order while trimming and deduping slugs", () => {
    expect(snapshotPlanSlugs([" p-two ", "p-one", "p-two", "", "  "])).toEqual([
      "p-two",
      "p-one",
    ]);
  });

  it("derives progress from finding rows, including owner-accepted as applied", () => {
    const counts = derivePlanCleanupCounts([
      finding({ findingId: "a", outcome: "auto_applied" }),
      finding({ findingId: "b", outcome: "accepted" }),
      finding({ findingId: "c", outcome: "recommended" }),
      finding({ findingId: "d", outcome: "skipped" }),
      finding({ findingId: "e", outcome: "failed" }),
      finding({ findingId: "f", outcome: "pending" }),
    ]);
    expect(counts).toMatchObject({
      total: 6,
      applied: 2,
      forReview: 1,
      skipped: 1,
      failed: 1,
      pending: 1,
      decided: 5,
      percent: 83,
    });
  });
});

describe("usePlanCleanupRun", () => {
  it("subscribes to plans.cleanupRun by deep-linked run id and derives phase lists", () => {
    const recommended = finding({ findingId: "rec", outcome: "recommended" });
    const pending = finding({ findingId: "pending", outcome: "pending" });
    H.syncData.value = [
      { run: run({ phase: "review" }), findings: [recommended, pending] },
    ];

    const { result } = renderHook(() =>
      usePlanCleanupRun("run-1", { enabled: true }),
    );
    expect(H.syncArgs.at(-1)).toMatchObject({
      queryName: "plans.cleanupRun",
      args: { runId: "run-1" },
      enabled: true,
    });
    expect(result.current.isReview).toBe(true);
    expect(result.current.recommendations.map((row) => row.findingId)).toEqual([
      "rec",
    ]);
    expect(result.current.pending.map((row) => row.findingId)).toEqual([
      "pending",
    ]);
  });

  it("holds no live subscription when the feature flag is off", () => {
    renderHook(() => usePlanCleanupRun(null, { enabled: false }));
    expect(H.syncArgs.at(-1)).toMatchObject({
      queryName: "plans.cleanupRun",
      args: {},
      enabled: false,
    });
  });
});

describe("usePlanCleanupOps", () => {
  it("records one owner acceptance through the plan-cleanup route", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, phase: "complete", accepted: true }),
    });
    const { result } = renderHook(() => usePlanCleanupOps());
    const accepted = await result.current.accept(
      "run-1",
      "finding-1",
      "owner checked it",
    );
    expect(accepted).toEqual({ ok: true, phase: "complete" });
    expect(JSON.parse(H.fetch.mock.calls[0]![1].body as string)).toEqual({
      op: "accept",
      runId: "run-1",
      findingId: "finding-1",
      note: "owner checked it",
    });
  });
});

describe("PlansCleanupStrip", () => {
  it("starts from the exact shown-plan snapshot and returns the durable run id", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, runId: "run-new", launched: true }),
    });
    const p = props({ planSlugs: [" p-two ", "p-one", "p-two"] });
    render(<PlansCleanupStrip {...p} />);

    fireEvent.click(screen.getByTestId("plans-cleanup-start"));
    await waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = H.fetch.mock.calls[0]!;
    expect(url).toBe("/api/admin/plan-cleanup");
    expect(JSON.parse(init.body as string)).toEqual({
      op: "start",
      planSlugs: ["p-two", "p-one"],
      filter: { query: null, shownCount: 2 },
    });
    expect(p.onRunStarted).toHaveBeenCalledWith("run-new");
  });

  it("shows a persisted launch failure instead of pretending the run is live", async () => {
    H.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        runId: "run-failed",
        launched: false,
        launchError: "no headless slot",
      }),
    });
    render(<PlansCleanupStrip {...props()} />);
    fireEvent.click(screen.getByTestId("plans-cleanup-start"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "resolver could not start: no headless slot",
    );
  });

  it("renders finding progress and lets Stop revoke the current run", async () => {
    const findings = [
      finding({ findingId: "done", outcome: "auto_applied" }),
      finding({ findingId: "review", outcome: "recommended" }),
      finding({ findingId: "left", outcome: "pending" }),
    ];
    render(
      <PlansCleanupStrip
        {...props({ run: run(), findings, isRunning: true })}
      />,
    );
    expect(screen.getByTestId("plans-cleanup-counts").textContent).toContain(
      "1 tidied",
    );
    expect(screen.getByTestId("plans-cleanup-counts").textContent).toContain(
      "1 for review",
    );
    expect(screen.getByTestId("plans-cleanup-counts").textContent).toContain(
      "1 left",
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "67",
    );

    fireEvent.click(screen.getByTestId("plans-cleanup-stop"));
    await waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(H.fetch.mock.calls[0]![1].body as string)).toEqual({
      op: "stop",
      runId: "run-1",
    });
  });

  it("hands review to ?opcln and clears it only after a successful dismiss", async () => {
    const recommendation = finding({ outcome: "recommended" });
    const p = props({
      run: run({ phase: "review", finishedAt: "2026-08-24T12:00:40.000Z" }),
      findings: [recommendation],
      recommendations: [recommendation],
      isReview: true,
    });
    render(<PlansCleanupStrip {...p} />);
    expect(
      screen.getByTestId("plans-cleanup-review-headline").textContent,
    ).toContain("1 fix need your call");

    fireEvent.click(screen.getByTestId("plans-cleanup-open-review"));
    expect(p.onReview).toHaveBeenCalledWith("run-1");

    fireEvent.click(screen.getByTestId("plans-cleanup-dismiss"));
    await waitFor(() => expect(H.fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(H.fetch.mock.calls[0]![1].body as string)).toEqual({
      op: "dismiss",
      runId: "run-1",
    });
    expect(p.onRunCleared).toHaveBeenCalledTimes(1);
  });
});
