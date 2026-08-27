// @vitest-environment jsdom
//
// ReviewReportShell (cleanup-report-flows-2026-08-24 P-001): the shared
// grouped report-review surface — default selection covers every PENDING row,
// the group checkbox is tri-state (checked / indeterminate / unchecked) and
// toggles its pending rows as a block, applied rows render as done and are
// never selectable, Apply-selected emits the sorted selected ids, and busy
// freezes the whole surface. Row hover/focus-within owns the one active detail
// region; no explicit detail control is rendered. The shared summary is an
// exhaustive Ready / Handled / Manual / Not applied partition of Results.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReviewReportShell, {
  partitionReviewRows,
  REVIEW_DETAIL_EXIT_GRACE_MS,
  REVIEW_DETAIL_HOVER_INTENT_MS,
  type ReviewReportGroup,
  type ReviewReportRow,
} from "./ReviewReportShell";

const operatorRoot = existsSync(resolve(process.cwd(), "app/globals.css"))
  ? process.cwd()
  : resolve(process.cwd(), "apps/operator");
const REPORT_CSS = readFileSync(
  resolve(operatorRoot, "app/_components/review-report/review-report.css"),
  "utf8",
);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function groupsFixture(): ReviewReportGroup[] {
  return [
    {
      id: "flip-to-done",
      title: "Flip to done",
      description: "Open items whose linked work-item finished with evidence.",
      rows: [
        {
          id: "f1",
          title: "Index the finished work",
          sourceLabel: "my-plan",
          referenceLabel: "P-001",
          transition: { from: "wip", to: "done" },
          evidence: [
            "WI-100 done; completion recorded",
            "plan item linked by coverage",
          ],
          confidence: "provable",
          accounting: "ready",
          detail: (
            <button type="button" data-testid="consumer-detail-f1">
              Open plan
            </button>
          ),
        },
        {
          id: "f2",
          title: "my-plan#P-002 → done",
          evidence: ["WI-101 done; NO completion record"],
          confidence: "recommended",
          accounting: "ready",
        },
      ],
    },
    {
      id: "orphaned-claim",
      title: "Orphaned claims",
      rows: [
        {
          id: "o1",
          title: "my-plan#P-003 claim released",
          evidence: ["lease lapsed 42min ago; holder dead"],
          confidence: "provable",
          accounting: "handled",
          status: "applied",
        },
        {
          id: "o2",
          title: "other-plan#P-004 claim released",
          evidence: ["lease lapsed 12min ago; holder dead"],
          confidence: "provable",
          accounting: "ready",
        },
      ],
    },
  ];
}

function renderShell(
  over: Partial<Parameters<typeof ReviewReportShell>[0]> = {},
) {
  const onApply = vi.fn();
  const onDismiss = vi.fn();
  render(
    <ReviewReportShell
      title="Plan clean-up report"
      icon={<span>✦</span>}
      subtitle="run #7"
      groups={groupsFixture()}
      onApply={onApply}
      onDismiss={onDismiss}
      {...over}
    />,
  );
  return { onApply, onDismiss };
}

const applyBtn = () =>
  screen.getByTestId("review-report-apply") as HTMLButtonElement;
const groupCheck = (id: string) =>
  screen.getByTestId(`review-group-check-${id}`) as HTMLButtonElement;
const rowCheck = (id: string) =>
  screen.getByTestId(`review-row-check-${id}`) as HTMLButtonElement;

function focusBody(): void {
  document.body.tabIndex = -1;
  document.body.focus();
  document.body.removeAttribute("tabindex");
}

describe("rendering", () => {
  it("renders title, subtitle, groups, rows, evidence and confidence flags", () => {
    renderShell();
    const report = screen.getByTestId("review-report");
    const responsiveRow = screen.getByTestId("review-row-f1");
    expect(screen.getByText("Plan clean-up report")).toBeTruthy();
    expect(screen.queryByText("Resolution review")).toBeNull();
    const titleId = report.getAttribute("aria-labelledby");
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBe(
      "Plan clean-up report",
    );
    expect(screen.getByTestId("review-report-icon")).toBeTruthy();
    expect(screen.getByText("run #7")).toBeTruthy();
    expect(screen.getByText("Flip to done")).toBeTruthy();
    expect(screen.getByText("WI-100 done; completion recorded")).toBeTruthy();
    expect(screen.getByText("my-plan")).toBeTruthy();
    expect(screen.getByText("P-001")).toBeTruthy();
    expect(
      screen.getByTestId("review-row-transition-f1").textContent,
    ).toContain("wip→done");
    expect(applyBtn().className).toContain("pc-btn");
    expect(report.querySelector(".review-report__actions")).toBeTruthy();
    expect(
      responsiveRow.querySelector(".review-report__row-identity"),
    ).toBeTruthy();
    expect(
      responsiveRow.querySelector(".review-report__row-change"),
    ).toBeTruthy();
    expect(
      responsiveRow.querySelector(".review-report__row-evidence"),
    ).toBeTruthy();
    expect(
      responsiveRow.querySelector(".review-report__row-conf"),
    ).toBeTruthy();
    expect(screen.getByTestId("review-row-conf-f1").textContent).toBe(
      "provable",
    );
    expect(screen.getByTestId("review-row-conf-f2").textContent).toBe(
      "recommended",
    );
    expect(
      screen
        .getByTestId("review-group-toggle-flip-to-done")
        .querySelector(".review-report__group-toggle-inner"),
    ).toBeTruthy();
    expect(report.querySelector(".review-report__navigator")).toBeNull();
    expect(
      screen.queryByTestId("review-group-columns-flip-to-done"),
    ).toBeNull();
  });

  it("renders the exhaustive summary while omitting rejected extra chrome", () => {
    renderShell();
    const report = screen.getByTestId("review-report");
    expect(
      screen.getByRole("region", { name: "Report result accounting" }),
    ).toBe(screen.getByTestId("review-report-summary"));
    expect(screen.getByTestId("review-report-results-count").textContent).toBe(
      "4",
    );
    expect(screen.getByTestId("review-report-ready-count").textContent).toBe(
      "3",
    );
    expect(screen.getByTestId("review-report-handled-count").textContent).toBe(
      "1",
    );
    expect(screen.getByTestId("review-report-manual-count").textContent).toBe(
      "0",
    );
    expect(
      screen.getByTestId("review-report-not-applied-count").textContent,
    ).toBe("0");
    expect(
      screen.getByTestId("review-report-accounting-invariant").textContent,
    ).toContain(
      "4 results accounted for: 3 ready, 1 handled, 0 manual, and 0 not applied.",
    );
    expect(report.querySelector(".review-report__eyebrow")).toBeNull();
    expect(
      screen.queryByTestId("review-group-selection-flip-to-done"),
    ).toBeNull();
    expect(screen.queryByTestId("review-row-reason-f1")).toBeNull();
    expect(screen.queryByText("plan item linked by coverage")).toBeNull();
    fireEvent.click(rowCheck("f2"));
    expect(screen.getByTestId("review-report-status").textContent).toBe(
      "2 of 3 selectable recommendations selected.",
    );
  });

  it("partitions each rendered row exactly once across all four outcomes", () => {
    const partition = partitionReviewRows([
      {
        id: "accounting",
        title: "Accounting",
        rows: [
          {
            id: "ready-default",
            title: "Ready by default",
            evidence: [],
            confidence: "recommended",
            accounting: "ready",
          },
          {
            id: "ready-explicit",
            title: "Ready explicitly",
            evidence: [],
            confidence: "recommended",
            accounting: "ready",
            status: "pending",
            selectable: true,
          },
          {
            id: "handled",
            title: "Handled",
            evidence: [],
            confidence: "provable",
            accounting: "handled",
            status: "applied",
          },
          {
            id: "manual",
            title: "Manual",
            evidence: [],
            confidence: "recommended",
            accounting: "manual",
            status: "pending",
            selectable: false,
          },
          {
            id: "not-applied",
            title: "Not applied",
            evidence: [],
            confidence: "recommended",
            accounting: "not-applied",
            status: "dismissed",
          },
        ],
      },
    ]);

    expect(partition).toEqual({
      results: 5,
      ready: 2,
      handled: 1,
      manual: 1,
      notApplied: 1,
    });
    expect(partition.results).toBe(
      partition.ready +
        partition.handled +
        partition.manual +
        partition.notApplied,
    );
  });

  it("keeps the five metrics legible at tablet and narrow widths", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report__metrics\s*\{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/s,
    );
    expect(REPORT_CSS).toMatch(
      /@container \(max-width: 760px\)[\s\S]*?\.review-report__metrics\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(REPORT_CSS).toMatch(
      /@container \(max-width: 420px\)[\s\S]*?\.review-report__metrics\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\);/,
    );
  });

  it("shows complete evidence plus consumer detail for only the hovered row", () => {
    vi.useFakeTimers();
    renderShell();
    expect(screen.queryByText("plan item linked by coverage")).toBeNull();
    expect(screen.queryByTestId("consumer-detail-f1")).toBeNull();

    const rowF1 = screen.getByTestId("review-row-f1");
    fireEvent.pointerEnter(rowF1);
    expect(screen.queryByTestId("review-row-detail-f1")).toBeNull();
    act(() => vi.advanceTimersByTime(REVIEW_DETAIL_HOVER_INTENT_MS));
    const detail = screen.getByTestId("review-row-detail-f1");
    expect(detail.getAttribute("role")).toBe("region");
    expect(rowF1.getAttribute("aria-describedby")).toBe(detail.id);
    expect(detail.textContent).toContain("WI-100 done; completion recorded");
    expect(detail.textContent).toContain("plan item linked by coverage");
    expect(screen.getByTestId("consumer-detail-f1")).toBeTruthy();

    fireEvent.pointerEnter(screen.getByTestId("review-row-f2"));
    expect(screen.getByTestId("review-row-detail-f1")).toBeTruthy();
    expect(screen.queryByTestId("review-row-detail-f2")).toBeNull();
    act(() => vi.advanceTimersByTime(REVIEW_DETAIL_HOVER_INTENT_MS));
    expect(screen.queryByTestId("review-row-detail-f1")).toBeNull();
    expect(screen.getByTestId("review-row-detail-f2")).toBeTruthy();
    fireEvent.pointerLeave(screen.getByTestId("review-row-f2"));
    expect(screen.getByTestId("review-row-detail-f2")).toBeTruthy();
    act(() => vi.advanceTimersByTime(REVIEW_DETAIL_EXIT_GRACE_MS));
    expect(screen.queryByTestId("review-row-detail-f2")).toBeNull();
  });

  it("never opens rows crossed before hover intent settles", () => {
    vi.useFakeTimers();
    renderShell();
    const rowF1 = screen.getByTestId("review-row-f1");
    const rowF2 = screen.getByTestId("review-row-f2");

    fireEvent.pointerEnter(rowF1);
    act(() =>
      vi.advanceTimersByTime(Math.max(1, REVIEW_DETAIL_HOVER_INTENT_MS - 20)),
    );
    fireEvent.pointerLeave(rowF1);
    fireEvent.pointerEnter(rowF2);
    act(() => vi.advanceTimersByTime(19));

    expect(
      screen.queryAllByRole("region", { name: /^Details for / }),
    ).toHaveLength(0);
    act(() => vi.advanceTimersByTime(REVIEW_DETAIL_HOVER_INTENT_MS));
    expect(screen.getByTestId("review-row-detail-f2")).toBeTruthy();
  });

  it("keeps detail open while hover or focus remains, including focusable applied rows", () => {
    renderShell();
    const rowF1 = screen.getByTestId("review-row-f1");
    const checkF1 = rowCheck("f1");

    fireEvent.pointerEnter(rowF1);
    fireEvent.focus(checkF1);
    fireEvent.pointerLeave(rowF1);
    expect(screen.getByTestId("review-row-detail-f1")).toBeTruthy();

    const apply = applyBtn();
    fireEvent.blur(checkF1, { relatedTarget: apply });
    fireEvent.focus(apply, { relatedTarget: checkF1 });
    expect(screen.queryByTestId("review-row-detail-f1")).toBeNull();

    const appliedRow = screen.getByTestId("review-row-o1");
    expect(screen.queryByTestId("review-row-check-o1")).toBeNull();
    expect(appliedRow.getAttribute("tabindex")).toBe("0");
    fireEvent.focus(appliedRow);
    expect(screen.getByTestId("review-row-detail-o1").textContent).toContain(
      "lease lapsed 42min ago; holder dead",
    );
    fireEvent.blur(appliedRow, { relatedTarget: apply });
    expect(screen.queryByTestId("review-row-detail-o1")).toBeNull();
  });

  it("does not resurrect active detail after a live row leaves and returns", () => {
    vi.useFakeTimers();
    const props = {
      title: "Live report",
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    };
    const original = groupsFixture();
    const { rerender } = render(
      <ReviewReportShell {...props} groups={original} />,
    );
    fireEvent.pointerEnter(screen.getByTestId("review-row-f1"));
    act(() => vi.advanceTimersByTime(REVIEW_DETAIL_HOVER_INTENT_MS));
    expect(screen.getByTestId("review-row-detail-f1")).toBeTruthy();

    const withoutF1 = original.map((group) => ({
      ...group,
      rows: group.rows.filter((row) => row.id !== "f1"),
    }));
    rerender(<ReviewReportShell {...props} groups={withoutF1} />);
    expect(screen.queryByTestId("review-row-f1")).toBeNull();

    rerender(<ReviewReportShell {...props} groups={original} />);
    expect(
      screen.getByTestId("review-row-f1").getAttribute("aria-describedby"),
    ).toBeNull();
    expect(screen.queryByTestId("review-row-detail-f1")).toBeNull();
  });

  it("isolates active-detail changes from untouched rows in a 240-row report", () => {
    vi.useFakeTimers();
    let untouchedTitleReads = 0;
    const rows: ReviewReportRow[] = Array.from({ length: 240 }, (_, index) => ({
      id: `stress-${index}`,
      title: `Stress row ${index}`,
      evidence: [`Evidence ${index}`],
      confidence: "provable",
      accounting: "ready",
      detail: <span>Detail {index}</span>,
    }));
    Object.defineProperty(rows[239], "title", {
      configurable: true,
      enumerable: true,
      get() {
        untouchedTitleReads += 1;
        return "Untouched sentinel row";
      },
    });

    renderShell({
      groups: [
        {
          id: "stress",
          title: "Stress fixture",
          rows,
        },
      ],
    });
    const readsAfterInitialRender = untouchedTitleReads;
    expect(readsAfterInitialRender).toBeGreaterThan(0);

    fireEvent.pointerEnter(screen.getByTestId("review-row-stress-0"));
    act(() => vi.advanceTimersByTime(REVIEW_DETAIL_HOVER_INTENT_MS));
    expect(screen.getByTestId("review-row-detail-stress-0")).toBeTruthy();
    expect(untouchedTitleReads).toBe(readsAfterInitialRender);

    fireEvent.pointerEnter(screen.getByTestId("review-row-stress-1"));
    act(() => vi.advanceTimersByTime(REVIEW_DETAIL_HOVER_INTENT_MS));
    expect(screen.queryByTestId("review-row-detail-stress-0")).toBeNull();
    expect(screen.getByTestId("review-row-detail-stress-1")).toBeTruthy();
    expect(untouchedTitleReads).toBe(readsAfterInitialRender);
  });

  it("contains each row's layout and paint work", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report__row\s*\{[^}]*contain:\s*layout paint;/s,
    );
  });

  it("eases detail height and disables that motion for reduced-motion users", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report__row-detail-slot\s*\{[^}]*grid-template-rows: 0fr;[^}]*animation: review-report-detail-reveal/s,
    );
    expect(REPORT_CSS).toMatch(
      /@keyframes review-report-detail-reveal\s*\{[\s\S]*?grid-template-rows: 1fr;/,
    );
    expect(REPORT_CSS).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.review-report__row-detail-slot\s*\{[^}]*animation: none;/,
    );
  });

  it("gives both programmatic focus fallbacks an explicit visible ring", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report:focus-visible\s*\{[^}]*outline: 2px solid var\(--review-accent-strong\);[^}]*outline-offset: 2px;/s,
    );
    expect(REPORT_CSS).toMatch(
      /\.review-report__row:focus-visible\s*\{[^}]*outline: 2px solid var\(--review-accent-strong\);[^}]*outline-offset: -2px;/s,
    );
  });

  it("keeps WebKitGTK-safe group layout off the native button", () => {
    const buttonRule = REPORT_CSS.match(
      /\.review-report__group-toggle\s*\{[^}]*\}/s,
    )?.[0];
    expect(buttonRule).toContain("display: block");
    expect(buttonRule).not.toMatch(/display:\s*(?:inline-)?(?:flex|grid)/);
    expect(REPORT_CSS).toMatch(
      /\.review-report__group-toggle-inner\s*\{[^}]*display: flex;[^}]*width: 100%;/s,
    );
  });

  it("renders an applied row as done — status mark, no checkbox", () => {
    renderShell();
    expect(screen.getByTestId("review-row-mark-o1").textContent).toBe("✓");
    expect(screen.queryByTestId("review-row-check-o1")).toBeNull();
  });

  it("keeps a manual pending row visible but out of selection, and renders the flow footer", () => {
    renderShell({
      groups: [
        {
          id: "manual",
          title: "Refresh Now",
          rows: [
            {
              id: "m1",
              title: "rewrite Now",
              evidence: ["current Now is stale"],
              confidence: "recommended",
              accounting: "manual",
              selectable: false,
            },
          ],
        },
      ],
      footer: "Writes use the same hand-edit verbs.",
    });
    expect(screen.getByTestId("review-row-m1")).toBeTruthy();
    expect(screen.queryByTestId("review-row-check-m1")).toBeNull();
    expect(screen.getByTestId("review-row-mark-m1").textContent).toBe("↗");
    expect(applyBtn().disabled).toBe(true);
    expect(
      screen.getByText("Writes use the same hand-edit verbs."),
    ).toBeTruthy();
  });

  it("keeps a dynamic row failure visible while detail remains hover-only", () => {
    vi.useFakeTimers();
    renderShell({
      groups: [
        {
          id: "retry",
          title: "Retry",
          rows: [
            {
              id: "failed-row",
              title: "Retry this change",
              evidence: ["write attempted"],
              confidence: "recommended",
              accounting: "ready",
              detail: "Keep these decision controls available.",
              error: "The write was rejected; review the row and retry.",
            },
          ],
        },
      ],
    });

    expect(
      screen.queryByText("Keep these decision controls available."),
    ).toBeNull();
    const alert = screen.getByTestId("review-row-error-failed-row");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
    expect(alert.textContent).toContain("write was rejected");
    expect(rowCheck("failed-row")).toBeTruthy();
    fireEvent.pointerEnter(screen.getByTestId("review-row-failed-row"));
    act(() => vi.advanceTimersByTime(REVIEW_DETAIL_HOVER_INTENT_MS));
    expect(
      screen.getByText("Keep these decision controls available."),
    ).toBeTruthy();
    expect(screen.getByTestId("review-row-error-failed-row")).toBe(alert);
  });
});

describe("selection + apply", () => {
  it("defaults to every PENDING row selected (applied rows excluded) and applies the sorted ids", () => {
    const { onApply } = renderShell();
    expect(applyBtn().textContent).toContain("(3)");
    fireEvent.click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(["f1", "f2", "o2"]);
  });

  it("unchecking a row removes it from the apply set", () => {
    const { onApply } = renderShell();
    const status = screen.getByTestId("review-report-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.textContent).toBe(
      "3 of 3 selectable recommendations selected.",
    );
    fireEvent.click(rowCheck("f2"));
    expect(applyBtn().textContent).toContain("(2)");
    expect(status.textContent).toBe(
      "2 of 3 selectable recommendations selected.",
    );
    fireEvent.click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(["f1", "o2"]);
  });

  it("defaultSelected 'none' starts empty with Apply disabled; an explicit id list is honored", () => {
    renderShell({ defaultSelected: "none" });
    expect(applyBtn().disabled).toBe(true);
    cleanup();
    const { onApply } = renderShell({ defaultSelected: ["f1"] });
    expect(applyBtn().textContent).toContain("(1)");
    fireEvent.click(applyBtn());
    expect(onApply).toHaveBeenCalledWith(["f1"]);
  });

  it("dismiss fires onDismiss; busy disables apply, dismiss and checkboxes", () => {
    const { onDismiss } = renderShell();
    fireEvent.click(screen.getByTestId("review-report-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    cleanup();
    renderShell({ busy: true });
    expect(screen.getByTestId("review-report").getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.getByTestId("review-report-status").textContent).toBe(
      "Updating report. Please wait.",
    );
    expect(applyBtn().disabled).toBe(true);
    expect(
      (screen.getByTestId("review-report-dismiss") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(rowCheck("f1").disabled).toBe(true);
    expect(
      (
        screen.getByTestId(
          "review-group-toggle-flip-to-done",
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByTestId("review-row-reason-f1")).toBeNull();
  });

  it("restores focus to Apply after busy settles with retryable selections", () => {
    const props = {
      title: "Retry report",
      groups: groupsFixture(),
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(<ReviewReportShell {...props} />);
    const apply = applyBtn();
    apply.focus();
    fireEvent.click(apply);

    rerender(<ReviewReportShell {...props} busy />);
    focusBody();
    expect(document.activeElement).toBe(document.body);
    rerender(<ReviewReportShell {...props} busy={false} />);

    expect(document.activeElement).toBe(apply);
    expect(apply.disabled).toBe(false);
  });

  it("moves focus to Dismiss after busy settles with no selectable rows", () => {
    const pending = groupsFixture();
    const applied = pending.map((group) => ({
      ...group,
      rows: group.rows.map((row) => ({
        ...row,
        status: "applied" as const,
        accounting: "handled" as const,
      })),
    }));
    const onApply = vi.fn();
    const onDismiss = vi.fn();
    const report = (groups: ReviewReportGroup[], busy = false) => (
      <ReviewReportShell
        title="Completed report"
        groups={groups}
        busy={busy}
        onApply={onApply}
        onDismiss={onDismiss}
      />
    );
    const { rerender } = render(report(pending));
    const apply = applyBtn();
    apply.focus();
    fireEvent.click(apply);

    rerender(report(pending, true));
    focusBody();
    expect(document.activeElement).toBe(document.body);
    rerender(report(applied));

    const dismiss = screen.getByTestId("review-report-dismiss");
    expect(document.activeElement).toBe(dismiss);
    expect(apply.disabled).toBe(true);
    expect(screen.getByTestId("review-report-status").textContent).toBe(
      "0 of 0 selectable recommendations selected.",
    );
  });

  it("moves focus to Dismiss when a passive live refresh disables focused Apply", () => {
    const pending = groupsFixture();
    const applied = pending.map((group) => ({
      ...group,
      rows: group.rows.map((row) => ({
        ...row,
        status: "applied" as const,
        accounting: "handled" as const,
      })),
    }));
    const props = {
      title: "Passively refreshed report",
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(
      <ReviewReportShell {...props} groups={pending} />,
    );
    const apply = applyBtn();
    apply.focus();

    // Chromium moves focus to BODY before React's layout effects run when the
    // live data disables Apply. jsdom does not perform that transition
    // reliably from blur(), so focus BODY explicitly before committing the
    // applied rows; the shell treats BODY as the implicit focusout target.
    focusBody();
    expect(document.activeElement).toBe(document.body);
    rerender(<ReviewReportShell {...props} groups={applied} />);

    expect(apply.isConnected).toBe(true);
    expect(apply.disabled).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByTestId("review-report-dismiss"),
    );

    // A concrete outside focus move is deliberate and must not be reclaimed.
    rerender(<ReviewReportShell {...props} groups={pending} />);
    const outside = document.createElement("button");
    document.body.append(outside);
    apply.focus();
    outside.focus();
    rerender(<ReviewReportShell {...props} groups={applied} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("restores focus to Dismiss when its busy action settles without unmounting", () => {
    const props = {
      title: "Dismiss failure report",
      groups: groupsFixture(),
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(<ReviewReportShell {...props} />);
    const dismiss = screen.getByTestId("review-report-dismiss");
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(props.onDismiss).toHaveBeenCalledTimes(1);

    rerender(<ReviewReportShell {...props} busy />);
    focusBody();
    expect(document.activeElement).toBe(document.body);
    rerender(<ReviewReportShell {...props} busy={false} />);

    expect(document.activeElement).toBe(dismiss);
    expect((dismiss as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("tri-state group checkbox", () => {
  it("reflects all → indeterminate → none, and toggles its pending rows as a block", () => {
    renderShell();
    const check = groupCheck("flip-to-done");
    expect(check.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(rowCheck("f2"));
    expect(groupCheck("flip-to-done").getAttribute("aria-checked")).toBe(
      "mixed",
    );

    // some → select ALL pending in the group
    fireEvent.click(groupCheck("flip-to-done"));
    expect(groupCheck("flip-to-done").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(applyBtn().textContent).toContain("(3)");

    // all → clear the group (other groups untouched)
    fireEvent.click(groupCheck("flip-to-done"));
    expect(groupCheck("flip-to-done").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(applyBtn().textContent).toContain("(1)");
    expect(rowCheck("o2").getAttribute("aria-checked")).toBe("true");
  });

  it("only counts pending rows — a group of applied rows renders its checkbox disabled", () => {
    renderShell({
      groups: [
        {
          id: "all-applied",
          title: "All applied",
          rows: [
            {
              id: "a1",
              title: "done already",
              evidence: [],
              confidence: "provable",
              accounting: "handled",
              status: "applied",
            },
          ],
        },
      ],
    });
    expect(groupCheck("all-applied").disabled).toBe(true);
  });

  it("moves focus to the group toggle when a live refresh disables its focused checkbox", () => {
    const pending = groupsFixture();
    const applied = pending.map((group) => ({
      ...group,
      rows: group.rows.map((row) => ({
        ...row,
        status: "applied" as const,
        accounting: "handled" as const,
      })),
    }));
    const props = {
      title: "Live plan cleanup report",
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(
      <ReviewReportShell {...props} groups={pending} />,
    );
    const check = groupCheck("flip-to-done");
    check.focus();

    // Chromium moves focus to BODY before React's layout effects run when a
    // focused native button becomes disabled. jsdom does not perform that
    // transition reliably from blur(), so focus BODY explicitly while
    // preserving the implicit focusout context the shell observes in Chromium.
    focusBody();
    expect(document.activeElement).toBe(document.body);
    rerender(<ReviewReportShell {...props} groups={applied} />);

    expect(check.isConnected).toBe(true);
    expect(check.disabled).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByTestId("review-group-toggle-flip-to-done"),
    );
  });
});

describe("collapse", () => {
  it("optionally starts groups without selectable actions collapsed and keeps them expandable", () => {
    const groups = groupsFixture().map((group) =>
      group.id === "orphaned-claim"
        ? {
            ...group,
            rows: group.rows.map((row) => ({
              ...row,
              selectable: false,
            })),
          }
        : group,
    );
    renderShell({ groups, collapseNonSelectableByDefault: true });

    const actionable = screen.getByTestId("review-group-toggle-flip-to-done");
    const historical = screen.getByTestId("review-group-toggle-orphaned-claim");
    expect(actionable.getAttribute("aria-expanded")).toBe("true");
    expect(historical.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("review-row-f1")).toBeTruthy();
    expect(screen.queryByTestId("review-row-o1")).toBeNull();
    expect(screen.queryByTestId("review-row-o2")).toBeNull();

    fireEvent.click(historical);
    expect(historical.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("review-row-o1")).toBeTruthy();
    expect(screen.getByTestId("review-row-o2")).toBeTruthy();
  });

  it("collapsing a group hides its rows (and description) without touching selection", () => {
    renderShell();
    expect(screen.getByTestId("review-row-f1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("review-group-toggle-flip-to-done"));
    expect(screen.queryByTestId("review-row-f1")).toBeNull();
    expect(applyBtn().textContent).toContain("(3)"); // selection preserved
    fireEvent.click(screen.getByTestId("review-group-toggle-flip-to-done"));
    expect(screen.getByTestId("review-row-f1")).toBeTruthy();
  });

  it("keeps selection and group collapse operable from the keyboard", async () => {
    const user = userEvent.setup();
    renderShell();

    const row = rowCheck("f2");
    row.focus();
    await user.keyboard(" ");
    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(applyBtn().textContent).toContain("(2)");

    const toggle = screen.getByTestId("review-group-toggle-flip-to-done");
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByTestId("review-row-f1")).toBeNull();
  });

  it("reveals a collapsed selected group when an apply error settles", () => {
    const groups = groupsFixture();
    const props = {
      title: "Collapsed failure report",
      groups,
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(<ReviewReportShell {...props} />);
    const toggle = screen.getByTestId("review-group-toggle-flip-to-done");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("review-row-f1")).toBeNull();
    expect(applyBtn().textContent).toContain("(3)");

    fireEvent.click(applyBtn());
    rerender(<ReviewReportShell {...props} busy />);
    const failedGroups = groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) =>
        row.id === "f1" ? { ...row, error: "The hidden write failed." } : row,
      ),
    }));
    rerender(
      <ReviewReportShell {...props} groups={failedGroups} busy={false} />,
    );

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const alert = screen.getByTestId("review-row-error-f1");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("The hidden write failed.");
    expect(rowCheck("f1").getAttribute("aria-checked")).toBe("true");
    expect(applyBtn().textContent).toContain("(3)");
  });
});
