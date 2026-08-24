// @vitest-environment jsdom
/** PlanCleanupReportHost takeover phase wiring (cleanup-report-flows P-007). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const H = vi.hoisted(() => ({
  enabled: { value: true },
  param: { value: "run-7" as string | null, close: vi.fn() },
  state: {
    value: {
      run: null as null | { runId: string; phase: string },
      findings: [] as unknown[],
    },
  },
}));

vi.mock("@/lib/flag-hooks", () => ({ useFlag: () => H.enabled.value }));
vi.mock("../review-report/ReportTakeover", () => ({
  useReportTakeoverParam: () => ({
    value: H.param.value,
    open: H.param.value !== null,
    show: vi.fn(),
    close: H.param.close,
  }),
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
  return { ...real, usePlanCleanupRun: () => H.state.value };
});
vi.mock("@papercusp/operator-core/lib/lazy-with-retry", () => ({
  lazyWithRetry: () => () => <div data-testid="cleanup-report-mock" />,
}));

import PlanCleanupReportHost from "./PlanCleanupReportHost";

afterEach(() => {
  cleanup();
  H.enabled.value = true;
  H.param.value = "run-7";
  H.state.value = { run: null, findings: [] };
  H.param.close.mockClear();
});

describe("PlanCleanupReportHost", () => {
  it("does not take over while the deep-linked run is still running", () => {
    H.state.value = { run: { runId: "run-7", phase: "running" }, findings: [] };
    render(<PlanCleanupReportHost />);
    expect(screen.queryByTestId("plan-cleanup-report-takeover")).toBeNull();
  });

  it("mounts the app-pane takeover exactly when the persisted run reaches review", () => {
    H.state.value = { run: { runId: "run-7", phase: "review" }, findings: [] };
    render(<PlanCleanupReportHost />);
    expect(screen.getByTestId("plan-cleanup-report-takeover")).toBeTruthy();
    expect(screen.getByTestId("cleanup-report-mock")).toBeTruthy();
  });

  it("stays absent when the kill switch is off even for a review run", () => {
    H.enabled.value = false;
    H.state.value = { run: { runId: "run-7", phase: "review" }, findings: [] };
    render(<PlanCleanupReportHost />);
    expect(screen.queryByTestId("plan-cleanup-report-takeover")).toBeNull();
  });
});
