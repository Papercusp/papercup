// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactElement } from "react";
import type { WorkItemAdmissionSnapshot } from "@papercusp/operator-core/lib/work-items-admission-promoter";

let syncResult: {
  data: WorkItemAdmissionSnapshot[] | undefined;
  loading: boolean;
  error: Error | null;
};
let lastSyncOptions: {
  queryName: string;
  args?: Record<string, unknown>;
  staleTime?: number;
} | null;

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (options: {
    queryName: string;
    args?: Record<string, unknown>;
    staleTime?: number;
  }) => {
    lastSyncOptions = options;
    return { ...syncResult, fetching: false, invalidate: vi.fn() };
  },
}));

// Radix Select's portal/geometry is orthogonal here. Preserve the accessible
// label and selected value while keeping this render-tier test deterministic.
vi.mock("@/app/harness/Select", () => ({
  Select: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) => (
    <button type="button" aria-label={ariaLabel}>
      {value}
    </button>
  ),
}));

import AdmissionRunsClient from "./AdmissionRunsClient";

function payload(
  overrides: Partial<WorkItemAdmissionSnapshot> = {},
): WorkItemAdmissionSnapshot {
  return {
    runs: [
      {
        id: "run-1",
        harnessSlug: "papercusp",
        runKind: "promoter-tick",
        state: "complete",
        stateSource: "writer",
        startedAt: "2026-08-26T15:00:00.000Z",
        finishedAt: "2026-08-26T15:00:01.000Z",
        batchSize: 4,
        promoted: 2,
        merged: 1,
        held: 1,
        autoPromotedUnreviewed: 0,
        censusBefore: 7,
        censusAfter: 8,
        censusDelta: 1,
        modelId: "model-a",
        tokensIn: 100,
        tokensOut: 20,
        latencyMs: 1_000,
        outcome: {
          unit: "items",
          attempted: 4,
          successful: 3,
          rolledBack: 0,
          unchanged: 1,
          uniqueRowsChanged: 3,
          failureReason: null,
          blockedReason: null,
        },
        outcomeSource: "writer",
        detail: { status: "complete" },
      },
    ],
    censusTrend: [
      {
        runId: "run-0",
        harnessSlug: "papercusp",
        runKind: "census",
        startedAt: "2026-08-26T14:00:00.000Z",
        before: 10,
        after: 7,
        delta: -3,
      },
      {
        runId: "run-1",
        harnessSlug: "papercusp",
        runKind: "promoter-tick",
        startedAt: "2026-08-26T15:00:00.000Z",
        before: 7,
        after: 8,
        delta: 1,
      },
    ],
    summary: {
      pending: 9,
      unreviewed: 3,
      promotedToFirstClaim: { sampleSize: 5, p50Ms: 1_200, p95Ms: 9_400 },
      latestCensus: {
        runId: "run-1",
        harnessSlug: "papercusp",
        runKind: "promoter-tick",
        startedAt: "2026-08-26T15:00:00.000Z",
        before: 7,
        after: 8,
        delta: 1,
      },
      latestCensusRise: {
        runId: "run-1",
        harnessSlug: "papercusp",
        runKind: "promoter-tick",
        startedAt: "2026-08-26T15:00:00.000Z",
        before: 7,
        after: 8,
        delta: 1,
      },
      runCounts: {
        total: 1,
        running: 0,
        complete: 1,
        failed: 0,
        blocked: 0,
        attempted: 4,
        successful: 3,
        rolledBack: 0,
        unchanged: 1,
        uniqueRowsChanged: 3,
        byUnit: {
          items: {
            attempted: 4,
            successful: 3,
            rolledBack: 0,
            unchanged: 1,
            uniqueRowsChanged: 3,
            runs: 1,
          },
        },
      },
    },
    ...overrides,
  };
}

function renderClient(searchParams = ""): ReturnType<typeof render> {
  const ui: ReactElement = <AdmissionRunsClient />;
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>,
  );
}

beforeEach(() => {
  syncResult = { data: undefined, loading: false, error: null };
  lastSyncOptions = null;
});
afterEach(cleanup);

describe("AdmissionRunsClient", () => {
  it("renders a dedicated loading state", () => {
    syncResult = { data: undefined, loading: true, error: null };
    renderClient();
    expect(screen.getByText("Loading admission runs…")).toBeTruthy();
  });

  it("renders a dedicated error state", () => {
    syncResult = {
      data: undefined,
      loading: false,
      error: new Error("ledger offline"),
    };
    renderClient();
    expect(screen.getByRole("alert").textContent).toContain("ledger offline");
  });

  it("renders queue stats, latency, census trend, rise alarm, and the run table", () => {
    syncResult = { data: [payload()], loading: false, error: null };
    renderClient();

    expect(screen.getByText("Pending admission")).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();
    expect(screen.getByText("1.2s")).toBeTruthy();
    expect(screen.getByText("9.4s")).toBeTruthy();
    expect(screen.getByTestId("census-rise-alarm").textContent).toContain(
      "rose by 1",
    );
    expect(
      screen.getByRole("img", { name: /Unadjudicated census trend/ }),
    ).toBeTruthy();
    expect(screen.getByText("promoter-tick")).toBeTruthy();
    expect(screen.getByText("model-a · 120")).toBeTruthy();
    expect(screen.getByText("Run states (shown)")).toBeTruthy();
    expect(screen.getByText("1/1")).toBeTruthy();
    expect(screen.getByText(/3 unique row change/)).toBeTruthy();
  });

  it("passes URL-backed kind and run-state filters to the single sync query", () => {
    syncResult = { data: [payload()], loading: false, error: null };
    renderClient("?kind=promoter-tick&state=failed");
    expect(lastSyncOptions).toEqual({
      queryName: "workItemAdmission.runs",
      args: { kind: "promoter-tick", state: "failed", limit: 100 },
      staleTime: 30_000,
    });
  });

  it("renders the clean empty state without fabricating an alarm", () => {
    const empty = payload({
      runs: [],
      censusTrend: [],
      summary: {
        pending: 0,
        unreviewed: 0,
        promotedToFirstClaim: { sampleSize: 0, p50Ms: null, p95Ms: null },
        latestCensus: null,
        latestCensusRise: null,
        runCounts: {
          total: 0,
          running: 0,
          complete: 0,
          failed: 0,
          blocked: 0,
          attempted: 0,
          successful: 0,
          rolledBack: 0,
          unchanged: 0,
          uniqueRowsChanged: 0,
          byUnit: {},
        },
      },
    });
    syncResult = { data: [empty], loading: false, error: null };
    renderClient();
    expect(
      screen.getByText("No admission runs match these filters."),
    ).toBeTruthy();
    expect(screen.queryByTestId("census-rise-alarm")).toBeNull();
    expect(screen.getByText("Not enough census samples yet.")).toBeTruthy();
  });
});
