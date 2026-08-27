// @vitest-environment jsdom
/** InboxBulkReportHost takeover phase wiring (cleanup-report-flows P-008). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

const H = vi.hoisted(() => ({
  enabled: { value: true },
  param: { value: "run-8" as string | null, close: vi.fn() },
  attentionReads: { value: 0 },
  reportProps: { value: null as Record<string, unknown> | null },
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
  useInboxAttention: () => {
    H.attentionReads.value += 1;
    return { items: [], loading: false, error: null, refresh: vi.fn() };
  },
}));
vi.mock("nuqs", () => ({
  parseAsString: {},
  useQueryState: () => [null, vi.fn()],
  useQueryStates: () => [{}, vi.fn()],
}));
vi.mock("@papercusp/operator-core/lib/lazy-with-retry", () => ({
  lazyWithRetry: () => (props: Record<string, unknown>) => {
    H.reportProps.value = props;
    return <div data-testid="inbox-report-mock" />;
  },
}));

import InboxBulkReportHost from "./InboxBulkReportHost";

afterEach(() => {
  cleanup();
  H.enabled.value = true;
  H.param.value = "run-8";
  H.state.value = { run: null, items: [] };
  H.attentionReads.value = 0;
  H.reportProps.value = null;
  H.param.close.mockClear();
});

describe("InboxBulkReportHost", () => {
  it("does not take over while the deep-linked run is still running", () => {
    H.state.value = { run: { runId: "run-8", phase: "running" }, items: [] };
    render(<InboxBulkReportHost />);
    expect(screen.queryByTestId("inbox-bulk-report-takeover")).toBeNull();
  });

  it("mounts the app-pane takeover exactly when the persisted run reaches review", () => {
    const items = [
      {
        runId: "run-8",
        itemId: "coord-message:m-8",
        kind: "coord-message",
        ref: { kind: "coord-message", msgId: "m-8" },
        ownerAgentId: "su-8",
      },
    ];
    H.state.value = { run: { runId: "run-8", phase: "review" }, items };
    render(<InboxBulkReportHost />);
    expect(screen.getByTestId("inbox-bulk-report-takeover")).toBeTruthy();
    expect(screen.getByTestId("inbox-report-mock")).toBeTruthy();
    expect(H.attentionReads.value).toBe(0);
    expect(H.reportProps.value?.runItems).toBe(items);
    expect("attentionItems" in (H.reportProps.value ?? {})).toBe(false);
  });

  it("stays absent when the kill switch is off even for a review run", () => {
    H.enabled.value = false;
    H.state.value = { run: { runId: "run-8", phase: "review" }, items: [] };
    render(<InboxBulkReportHost />);
    expect(screen.queryByTestId("inbox-bulk-report-takeover")).toBeNull();
  });
});
