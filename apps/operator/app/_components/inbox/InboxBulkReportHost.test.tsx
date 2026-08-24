// @vitest-environment jsdom
/** InboxBulkReportHost takeover phase wiring (cleanup-report-flows P-008). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const H = vi.hoisted(() => ({
  enabled: { value: true },
  param: { value: "run-8" as string | null, close: vi.fn() },
  state: {
    value: {
      run: null as null | { runId: string; phase: string },
      items: [] as unknown[],
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
    children: ReactNode;
    testId: string;
  }) => <div data-testid={testId}>{children}</div>,
}));
vi.mock("./use-inbox-bulk-run", async (importOriginal) => {
  const real = await importOriginal<typeof import("./use-inbox-bulk-run")>();
  return { ...real, useInboxBulkRun: () => H.state.value };
});
vi.mock("./use-inbox-pending", () => ({
  useInboxAttention: () => ({
    items: [],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("nuqs", () => ({
  parseAsString: {},
  useQueryState: () => [null, vi.fn()],
  useQueryStates: () => [{}, vi.fn()],
}));
vi.mock("@papercusp/operator-core/lib/lazy-with-retry", () => ({
  lazyWithRetry: () => () => <div data-testid="inbox-report-mock" />,
}));

import InboxBulkReportHost from "./InboxBulkReportHost";

afterEach(() => {
  cleanup();
  H.enabled.value = true;
  H.param.value = "run-8";
  H.state.value = { run: null, items: [] };
  H.param.close.mockClear();
});

describe("InboxBulkReportHost", () => {
  it("does not take over while the deep-linked run is still running", () => {
    H.state.value = { run: { runId: "run-8", phase: "running" }, items: [] };
    render(<InboxBulkReportHost />);
    expect(screen.queryByTestId("inbox-bulk-report-takeover")).toBeNull();
  });

  it("mounts the app-pane takeover exactly when the persisted run reaches review", () => {
    H.state.value = { run: { runId: "run-8", phase: "review" }, items: [] };
    render(<InboxBulkReportHost />);
    expect(screen.getByTestId("inbox-bulk-report-takeover")).toBeTruthy();
    expect(screen.getByTestId("inbox-report-mock")).toBeTruthy();
  });

  it("stays absent when the kill switch is off even for a review run", () => {
    H.enabled.value = false;
    H.state.value = { run: { runId: "run-8", phase: "review" }, items: [] };
    render(<InboxBulkReportHost />);
    expect(screen.queryByTestId("inbox-bulk-report-takeover")).toBeNull();
  });
});
