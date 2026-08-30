// @vitest-environment jsdom
/** PlanCleanupReportHost takeover phase wiring (cleanup-report-flows P-007). */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const H = vi.hoisted(() => ({
  enabled: { value: true },
  param: {
    value: "run-7" as string | null,
    foreground: true,
    close: vi.fn(),
  },
  setDashboardPlan: vi.fn(),
  queryOptions: { value: null as null | { enabled: boolean } },
  releaseAvailability: {
    value: null as null | {
      enabled: boolean;
      loading: boolean;
      available: boolean;
    },
  },
  state: {
    value: {
      run: null as null | { runId: string; phase: string },
      findings: [] as unknown[],
      loading: true as boolean | undefined,
    },
  },
}));

vi.mock("nuqs", () => ({
  parseAsString: {},
  useQueryState: () => [null, H.setDashboardPlan],
}));

vi.mock("@/lib/flag-hooks", () => ({ useFlag: () => H.enabled.value }));
vi.mock("../review-report/ReportTakeover", () => ({
  useReportTakeoverParam: () => ({
    value: H.param.value,
    open: H.param.value !== null,
    foreground: H.param.foreground,
    show: vi.fn(),
    close: H.param.close,
  }),
  useReleaseMissingReportTakeover: (
    _report: unknown,
    availability: {
      enabled: boolean;
      loading: boolean;
      available: boolean;
    },
  ) => {
    H.releaseAvailability.value = availability;
  },
  ReportTakeoverLayer: ({
    children,
    testId,
  }: {
    children: React.ReactNode;
    testId: string;
  }) => <div data-testid={testId}>{children}</div>,
}));
vi.mock("./use-plan-cleanup-run", async (importOriginal) => {
  const real = await importOriginal<typeof import("./use-plan-cleanup-run")>();
  return {
    ...real,
    usePlanCleanupRun: (
      _runRef: string | null,
      options: { enabled: boolean },
    ) => {
      H.queryOptions.value = options;
      return H.state.value;
    },
  };
});
vi.mock("@papercusp/operator-core/lib/lazy-with-retry", () => ({
  lazyWithRetry:
    () =>
    ({ onOpenFinding }: { onOpenFinding: (finding: unknown) => void }) => (
      <button
        type="button"
        data-testid="cleanup-report-mock"
        onClick={() =>
          onOpenFinding({ planSlug: "p-one", harnessSlug: "papercusp" })
        }
      >
        report
      </button>
    ),
}));

import PlanCleanupReportHost from "./PlanCleanupReportHost";

afterEach(() => {
  cleanup();
  H.enabled.value = true;
  H.param.value = "run-7";
  H.param.foreground = true;
  H.state.value = { run: null, findings: [], loading: true };
  H.queryOptions.value = null;
  H.releaseAvailability.value = null;
  H.param.close.mockClear();
  H.setDashboardPlan.mockClear();
});

describe("PlanCleanupReportHost", () => {
  it("does not take over while the deep-linked run is still running", () => {
    H.state.value = {
      run: { runId: "run-7", phase: "running" },
      findings: [],
      loading: false,
    };
    render(<PlanCleanupReportHost />);
    expect(screen.queryByTestId("plan-cleanup-report-takeover")).toBeNull();
    expect(H.releaseAvailability.value).toEqual({
      enabled: true,
      loading: false,
      available: true,
    });
  });

  it("reports a settled missing run to the shared owner-release hook", () => {
    H.state.value = { run: null, findings: [], loading: false };
    render(<PlanCleanupReportHost />);
    expect(H.releaseAvailability.value).toEqual({
      enabled: true,
      loading: false,
      available: false,
    });
  });

  it("mounts the app-pane takeover exactly when the persisted run reaches review", () => {
    H.state.value = {
      run: { runId: "run-7", phase: "review" },
      findings: [],
      loading: false,
    };
    render(<PlanCleanupReportHost />);
    expect(screen.getByTestId("plan-cleanup-report-takeover")).toBeTruthy();
    expect(screen.getByTestId("cleanup-report-mock")).toBeTruthy();
    expect(H.queryOptions.value).toEqual({ enabled: true });
  });

  it("does not hydrate or mount while another report owns foreground", () => {
    H.param.foreground = false;
    H.state.value = {
      run: { runId: "run-7", phase: "review" },
      findings: [],
      loading: false,
    };
    render(<PlanCleanupReportHost />);

    expect(H.queryOptions.value).toEqual({ enabled: false });
    expect(screen.queryByTestId("plan-cleanup-report-takeover")).toBeNull();
  });

  it("stays absent when the kill switch is off even for a review run", () => {
    H.enabled.value = false;
    H.state.value = {
      run: { runId: "run-7", phase: "review" },
      findings: [],
      loading: false,
    };
    render(<PlanCleanupReportHost />);
    expect(screen.queryByTestId("plan-cleanup-report-takeover")).toBeNull();
  });

  it("opens the finding's scoped plan only after closing the report takeover", async () => {
    H.state.value = {
      run: { runId: "run-7", phase: "review" },
      findings: [],
      loading: false,
    };
    H.param.close.mockResolvedValue(undefined);
    render(<PlanCleanupReportHost />);

    fireEvent.click(screen.getByTestId("cleanup-report-mock"));
    await waitFor(() => expect(H.setDashboardPlan).toHaveBeenCalled());
    expect(H.param.close).toHaveBeenCalledTimes(1);
    expect(H.setDashboardPlan).toHaveBeenCalledWith("papercusp::p-one");
    expect(H.param.close.mock.invocationCallOrder[0]).toBeLessThan(
      H.setDashboardPlan.mock.invocationCallOrder[0]!,
    );
  });
});
