// @vitest-environment jsdom
//
// ReviewReportShell (cleanup-report-flows-2026-08-24 P-001): the shared
// grouped report-review surface — default selection covers every PENDING row,
// the group checkbox is tri-state (checked / indeterminate / unchecked) and
// toggles its pending rows as a block, applied rows render as done and are
// never selectable, Apply-selected emits the sorted selected ids, and busy
// freezes the whole surface. Row detail is an explicit click/keyboard
// disclosure with a pointer affordance; hover and focus alone never open it.
// The shared summary is an exhaustive Ready / Handled / Manual / Not applied
// partition of Results.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReviewReportShell, {
  partitionReviewRows,
  REVIEW_ACTION_VOCABULARY,
  REVIEW_PARTITION_TILES,
  REVIEW_ROW_ACCOUNTING,
  REVIEW_ROW_CONTROLS,
  reviewCommitLabel,
  reviewRowControl,
  reviewRowVerb,
  type ReviewActionKey,
  type ReviewRowControlId,
  type ReviewReportGroup,
  type ReviewReportRow,
  type ReviewRowAccounting,
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
          confidence: "high",
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
          confidence: "medium",
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
          confidence: "high",
          accounting: "handled",
          status: "applied",
        },
        {
          id: "o2",
          title: "other-plan#P-004 claim released",
          evidence: ["lease lapsed 12min ago; holder dead"],
          confidence: "high",
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
    // D-001: the confidence cell is now a STATIC indicator (dot + word +
    // sr-only "confidence"), not a control. Its visible label is what matters.
    expect(
      screen.getByTestId("review-row-conf-f1").getAttribute("data-confidence"),
    ).toBe("high");
    expect(
      screen.getByTestId("review-row-conf-f2").getAttribute("data-confidence"),
    ).toBe("medium");
    expect(screen.getByTestId("review-row-conf-f1").textContent).toContain(
      "high",
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

  it("renders every canonical confidence level as an explicit disclosure state", () => {
    const levels = ["high", "medium", "low", "insufficient"] as const;
    renderShell({
      groups: [
        {
          id: "confidence",
          title: "Confidence",
          rows: levels.map((confidence) => ({
            id: confidence,
            title: `${confidence} recommendation`,
            evidence: [],
            confidence,
            accounting: "manual" as const,
            selectable: false,
          })),
        },
      ],
    });

    for (const confidence of levels) {
      const disclosure = screen.getByTestId(`review-row-conf-${confidence}`);
      expect(disclosure.textContent).toContain(confidence);
      expect(disclosure.getAttribute("data-confidence")).toBe(confidence);
      expect(disclosure.className).toContain(
        `review-report__row-conf--${confidence}`,
      );
      // D-001: confidence is not editable, so it is no longer a button and
      // carries no aria-label — the DISCLOSURE beside it owns that role.
      expect(disclosure.tagName).toBe("SPAN");
      expect(disclosure.getAttribute("aria-label")).toBeNull();
      expect(
        screen
          .getByTestId(`review-row-why-${confidence}`)
          .getAttribute("aria-label"),
      ).toContain(
        `${confidence} confidence`,
      );
    }
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
    // P-004: the fifth category. A row the resolver never reached is its own
    // outcome, not "manual" — the two need opposite actions.
    expect(
      screen.getByTestId("review-report-not-assessed-count").textContent,
    ).toBe("0");
    expect(
      screen.getByTestId("review-report-accounting-invariant").textContent,
    ).toContain(
      "4 results accounted for: 3 ready, 1 handled, 0 manual, 0 not assessed, and 0 not applied.",
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
            confidence: "medium",
            accounting: "ready",
          },
          {
            id: "ready-explicit",
            title: "Ready explicitly",
            evidence: [],
            confidence: "medium",
            accounting: "ready",
            status: "pending",
            selectable: true,
          },
          {
            id: "handled",
            title: "Handled",
            evidence: [],
            confidence: "high",
            accounting: "handled",
            status: "applied",
          },
          {
            id: "manual",
            title: "Manual",
            evidence: [],
            confidence: "medium",
            accounting: "manual",
            status: "pending",
            selectable: false,
          },
          {
            id: "not-applied",
            title: "Not applied",
            evidence: [],
            confidence: "medium",
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
      // P-004: an unassessed row is NOT manual — manual wants a human,
      // not-assessed wants the run resumed. Counting them together told the
      // owner to go do by hand what the resolver simply never reached.
      notAssessed: 0,
      notApplied: 1,
    });
    expect(partition.results).toBe(
      partition.ready +
        partition.handled +
        partition.manual +
        partition.notAssessed +
        partition.notApplied,
    );
  });

  /**
   * The acceptance drill for "the partition accounts for every row".
   *
   * The census is DERIVED from REVIEW_ROW_ACCOUNTING — the accounting type's
   * own runtime members — rather than from a fixture someone has to remember
   * to extend. An accounting value added later automatically gets a row here
   * and must land in exactly one tile, so the drill fails by construction
   * instead of silently under-counting.
   */
  const censusRows: ReviewReportRow[] = REVIEW_ROW_ACCOUNTING.map(
    (accounting) => ({
      id: accounting,
      title: `${accounting} row`,
      evidence: [],
      confidence: "medium" as const,
      accounting,
    }),
  );
  const censusGroups: ReviewReportGroup[] = [
    { id: "census", title: "Census", rows: censusRows },
  ];

  it("maps every accounting member to exactly one tile, in both directions", () => {
    // Guards the guard: an empty union would make every loop below vacuous.
    expect(REVIEW_ROW_ACCOUNTING.length).toBeGreaterThan(0);

    const tileIds = REVIEW_PARTITION_TILES.map((tile) => tile.id);
    // No duplicate tiles, and no tile for a value that is not an accounting
    // member — the reverse direction, which a "does each member have a tile"
    // check alone would miss.
    expect(new Set(tileIds).size).toBe(tileIds.length);
    expect([...tileIds].sort()).toEqual([...REVIEW_ROW_ACCOUNTING].sort());

    for (const accounting of REVIEW_ROW_ACCOUNTING) {
      expect(
        REVIEW_PARTITION_TILES.filter((tile) => tile.id === accounting),
      ).toHaveLength(1);
    }
  });

  it("renders tiles that sum to the rendered rows, not-assessed included", () => {
    renderShell({ groups: censusGroups });

    let summed = 0;
    for (const tile of REVIEW_PARTITION_TILES) {
      const count = Number(
        screen.getByTestId(`review-report-${tile.id}-count`).textContent,
      );
      expect(Number.isNaN(count)).toBe(false);
      summed += count;
    }

    expect(summed).toBe(censusRows.length);
    expect(
      Number(
        screen.getByTestId("review-report-not-assessed-count").textContent,
      ),
      // P-004: never-assessed is its own visible category. If this is ever 0
      // while a not-assessed row is rendered, it has folded back into another
      // bucket and the tiles no longer account for what is on screen.
    ).toBeGreaterThan(0);
  });

  it("narrows the rendered rows to the tile the owner activates, and back", async () => {
    const user = userEvent.setup();
    renderShell({ groups: censusGroups });

    // Everything is on screen before any tile is engaged.
    for (const accounting of REVIEW_ROW_ACCOUNTING) {
      expect(screen.queryByTestId(`review-row-${accounting}`)).not.toBeNull();
    }

    for (const target of REVIEW_ROW_ACCOUNTING) {
      const filter = screen.getByTestId(`review-report-${target}-filter`);
      await user.click(filter);
      expect(filter.getAttribute("aria-pressed")).toBe("true");

      for (const accounting of REVIEW_ROW_ACCOUNTING) {
        const row = screen.queryByTestId(`review-row-${accounting}`);
        if (accounting === target) expect(row).not.toBeNull();
        else expect(row).toBeNull();
      }

      // Activating the engaged tile again clears the filter rather than
      // trapping the owner in a narrowed report with no way back.
      await user.click(screen.getByTestId(`review-report-${target}-filter`));
      expect(
        screen
          .getByTestId(`review-report-${target}-filter`)
          .getAttribute("aria-pressed"),
      ).toBe("false");
      expect(screen.queryByTestId(`review-row-${target}`)).not.toBeNull();
    }
  });

  /**
   * The acceptance drill for "every row states its own consequence".
   *
   * The weak version of this test — assert both the verb and the button are
   * non-empty strings — passes happily on a row reading "Zap" under a button
   * reading "Apply 12 selected". The criterion explicitly rejects that. What
   * follows asserts the DISCRIMINATOR instead: both sides resolve from
   * REVIEW_ACTION_VOCABULARY, so their wording cannot be edited apart.
   */
  const ACTION_KEYS = Object.keys(
    REVIEW_ACTION_VOCABULARY,
  ) as ReviewActionKey[];

  it("resolves every declared verb from the shared vocabulary, never a literal", () => {
    expect(ACTION_KEYS.length).toBeGreaterThan(0);

    for (const key of ACTION_KEYS) {
      const entry = REVIEW_ACTION_VOCABULARY[key];
      // The row's words ARE the map's words. A hardcoded verb anywhere in the
      // render path would break this for that key.
      expect(reviewRowVerb({ key })).toBe(entry.verb);
      expect(reviewRowVerb({ key }).length).toBeGreaterThan(0);

      // …and so are the button's, for anything committable. Both sides are
      // expressed against the SAME entry, so the assertion cannot be satisfied
      // by two independently-maintained strings that happen to agree today.
      if ("commit" in entry) {
        expect(reviewCommitLabel([{ key }, { key }, { key }], "Apply")).toBe(
          entry.commit(3),
        );
      }
    }
  });

  it("refuses to name a single consequence for a mixed or custom selection", () => {
    // Mixed verbs: there is no one thing Apply will do, so it must not claim
    // one. This is the honest fallback, not a missing feature.
    expect(
      reviewCommitLabel(
        [{ key: "mark-done" }, { key: "archive-plan" }],
        "Apply selected",
      ),
    ).toBe("Apply selected (2)");

    // A data-driven verb never claims shared wording either.
    expect(
      reviewCommitLabel(
        [{ key: "custom", label: "Zap" }],
        "Apply selected",
      ),
    ).toBe("Apply selected (1)");

    // A terminal verb has no commit phrasing to borrow.
    expect(reviewCommitLabel([{ key: "skipped" }], "Apply selected")).toBe(
      "Apply selected (1)",
    );
  });

  it("renders the row verb and the commit button in the same words", () => {
    const rows: ReviewReportRow[] = ["a", "b"].map((id) => ({
      id,
      title: `row ${id}`,
      evidence: [],
      confidence: "high" as const,
      accounting: "ready" as const,
      status: "pending" as const,
      selectable: true,
      action: { key: "mark-done" as const },
    }));
    renderShell({
      groups: [{ id: "g", title: "G", rows }],
      applyLabel: "Apply selected",
    });

    for (const id of ["a", "b"]) {
      const verb = screen.getByTestId(`review-row-verb-${id}`);
      expect(verb.textContent).toContain(
        REVIEW_ACTION_VOCABULARY["mark-done"].verb,
      );
      expect(verb.getAttribute("data-verb-tone")).toBeTruthy();
    }
    // The button commits those two rows in their own verb — "Mark 2 done" —
    // rather than the neutral label the consumer passed.
    expect(applyBtn().textContent).toContain(
      REVIEW_ACTION_VOCABULARY["mark-done"].commit(2),
    );
  });

  /**
   * The acceptance drill for "one shared surface, two flows" — the row-control
   * half. The registry must be the ONLY place a control is defined, so the two
   * flows cannot drift into two vocabularies for the same recovery, and a
   * control added for one is immediately offerable by the other.
   */
  const CONTROL_IDS = Object.keys(
    REVIEW_ROW_CONTROLS,
  ) as ReviewRowControlId[];

  it("builds every row control from the registry, wording and tone included", () => {
    expect(CONTROL_IDS.length).toBeGreaterThan(0);

    for (const id of CONTROL_IDS) {
      const entry = REVIEW_ROW_CONTROLS[id];
      const built = reviewRowControl(id, { subject: "widget", run: () => {} });
      expect(built.id).toBe(id);
      expect(built.label).toBe(entry.label("widget"));
      expect(built.label.length).toBeGreaterThan(0);
      expect(built.tone).toBe("tone" in entry ? entry.tone : undefined);

      // A greyed control still owes an explanation — enforced where controls
      // are BUILT, so no call site can forget it.
      const disabled = reviewRowControl(id, { disabled: true, run: () => {} });
      expect(disabled.disabled).toBe(true);
      expect(disabled.disabledReason).toBeTruthy();
    }
  });

  it("keeps the registry the ONLY definition site — neither consumer rebuilds the set", () => {
    // A source-level check because that is what "only definition site" means:
    // a runtime assertion can only see the set a consumer chose to return, not
    // whether it was constructed a second time. The shell already reads its
    // own CSS from disk in this suite, so reading source here is in keeping.
    for (const relative of [
      "app/_components/plans/PlanCleanupReport.tsx",
      "app/_components/inbox/InboxBulkReport.tsx",
    ]) {
      const source = readFileSync(resolve(operatorRoot, relative), "utf8");

      // It resolves controls through the shared builder…
      expect(source).toContain("reviewRowControl");

      // …and does NOT hand-construct a control object. An inline `id: "open"`
      // beside a `run:` is exactly the second definition site this forbids.
      for (const id of CONTROL_IDS) {
        expect(
          source.includes(`id: "${id}"`),
          `${relative} constructs the "${id}" control inline instead of via reviewRowControl`,
        ).toBe(false);
      }
    }
  });

  it("keeps all five metrics compact at tablet and narrow widths", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report__metrics\s*\{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/s,
    );
    expect(REPORT_CSS).toMatch(
      /@container \(max-width: 760px\)[\s\S]*?\.review-report__metrics\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(REPORT_CSS).toMatch(
      /@container \(max-width: 420px\)[\s\S]*?\.review-report__metrics\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*gap: 6px;/,
    );
    expect(REPORT_CSS).toMatch(
      /@container \(max-width: 420px\)[\s\S]*?\.review-report__metric--results\s*\{[^}]*grid-column: 1 \/ -1;/,
    );
  });

  it("wraps full group identities inside constrained report panes", () => {
    expect(REPORT_CSS).toMatch(
      /@container \(max-width: 760px\)[\s\S]*?\.review-report__group-title\s*\{[^}]*flex: 1 1 160px;[^}]*min-width: 0;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/,
    );
  });

  it("gives row titles a constrained overflow box for real ellipsis", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report__row-title\s*\{[^}]*display: block;[^}]*min-width: 0;[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s,
    );
  });

  it("isolates the sticky header from scrolling report rows", () => {
    const headerRule = REPORT_CSS.match(
      /\.review-report__head\s*\{([\s\S]*?)\}/,
    )?.[1];

    expect(headerRule).toBeTruthy();
    expect(headerRule).toMatch(/position: sticky;/);
    expect(headerRule).toMatch(/background: var\(--bg\);/);
    expect(headerRule).not.toMatch(/background:[^;]*var\(--bg-2\)/);
    expect(headerRule).not.toMatch(/background:\s*transparent;/);
    expect(headerRule).toMatch(/border-bottom:/);
    expect(headerRule).toMatch(/box-shadow:/);
  });

  it("stacks header actions only below their side-by-side fit threshold", () => {
    expect(REPORT_CSS).toMatch(
      /@container \(max-width: 315px\)[\s\S]*?\.review-report__actions\s*\{[^}]*flex-direction: column;[^}]*align-items: stretch;/,
    );
    expect(REPORT_CSS).toMatch(
      /@container \(max-width: 315px\)[\s\S]*?\.review-report__apply\.pc-btn,\s*\.review-report__dismiss\.pc-btn\s*\{[^}]*width: 100%;[^}]*min-width: 0;/,
    );
  });

  it("shows complete evidence plus consumer detail for only the clicked row", () => {
    renderShell();
    expect(screen.queryByText("plan item linked by coverage")).toBeNull();
    expect(screen.queryByTestId("consumer-detail-f1")).toBeNull();

    const rowF1 = screen.getByTestId("review-row-f1");
    fireEvent.pointerEnter(rowF1);
    expect(screen.queryByTestId("review-row-detail-f1")).toBeNull();
    fireEvent.click(rowF1);
    const detail = screen.getByTestId("review-row-detail-f1");
    expect(detail.getAttribute("role")).toBe("region");
    expect(rowF1.getAttribute("aria-describedby")).toBe(detail.id);
    expect(detail.textContent).toContain("WI-100 done; completion recorded");
    expect(detail.textContent).toContain("plan item linked by coverage");
    expect(screen.getByTestId("consumer-detail-f1")).toBeTruthy();
    // D-001: the disclosure is its OWN control now. The confidence cell beside
    // it is a static indicator and carries no aria-expanded at all.
    const toggleF1 = screen.getByTestId("review-row-why-f1");
    expect(toggleF1.getAttribute("aria-expanded")).toBe("true");
    expect(toggleF1.getAttribute("aria-controls")).toBe(detail.id);
    expect(toggleF1.getAttribute("aria-label")).toBe(
      "Hide why: Index the finished work — high confidence",
    );
    expect(
      screen.getByTestId("review-row-conf-f1").getAttribute("aria-expanded"),
    ).toBeNull();

    const rowF2 = screen.getByTestId("review-row-f2");
    fireEvent.click(rowF2);
    expect(screen.queryByTestId("review-row-detail-f1")).toBeNull();
    expect(screen.getByTestId("review-row-detail-f2")).toBeTruthy();
    fireEvent.click(rowF2);
    expect(screen.queryByTestId("review-row-detail-f2")).toBeNull();
  });

  it("wraps long evidence tokens inside the expanded detail boundary", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report__detail-evidence li\s*\{[^}]*overflow-wrap:\s*anywhere;/s,
    );
  });

  it("never auto-opens from hover or focus", () => {
    renderShell();
    const rowF1 = screen.getByTestId("review-row-f1");
    const rowF2 = screen.getByTestId("review-row-f2");

    fireEvent.pointerEnter(rowF1);
    fireEvent.pointerLeave(rowF1);
    fireEvent.pointerEnter(rowF2);
    fireEvent.focus(rowCheck("f1"));

    expect(
      screen.queryAllByRole("region", { name: /^Details for / }),
    ).toHaveLength(0);
  });

  it("offers an explicit keyboard-operable details control for every row", async () => {
    const user = userEvent.setup();
    renderShell();
    const toggleF1 = screen.getByTestId("review-row-why-f1");
    toggleF1.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("review-row-detail-f1")).toBeTruthy();
    await user.keyboard(" ");
    expect(screen.queryByTestId("review-row-detail-f1")).toBeNull();

    expect(screen.queryByTestId("review-row-check-o1")).toBeNull();
    const appliedToggle = screen.getByTestId("review-row-why-o1");
    fireEvent.click(appliedToggle);
    expect(screen.getByTestId("review-row-detail-o1").textContent).toContain(
      "lease lapsed 42min ago; holder dead",
    );
  });

  it("does not resurrect active detail after a live row leaves and returns", () => {
    const props = {
      title: "Live report",
      onApply: vi.fn(),
      onDismiss: vi.fn(),
    };
    const original = groupsFixture();
    const { rerender } = render(
      <ReviewReportShell {...props} groups={original} />,
    );
    fireEvent.click(screen.getByTestId("review-row-f1"));
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
    let untouchedTitleReads = 0;
    const rows: ReviewReportRow[] = Array.from({ length: 240 }, (_, index) => ({
      id: `stress-${index}`,
      title: `Stress row ${index}`,
      evidence: [`Evidence ${index}`],
      confidence: "high",
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

    fireEvent.click(screen.getByTestId("review-row-stress-0"));
    expect(screen.getByTestId("review-row-detail-stress-0")).toBeTruthy();
    expect(untouchedTitleReads).toBe(readsAfterInitialRender);

    fireEvent.click(screen.getByTestId("review-row-stress-1"));
    expect(screen.queryByTestId("review-row-detail-stress-0")).toBeNull();
    expect(screen.getByTestId("review-row-detail-stress-1")).toBeTruthy();
    expect(untouchedTitleReads).toBe(readsAfterInitialRender);
  });

  it("contains each row's layout and paint work", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report__row\s*\{[^}]*contain:\s*layout paint;/s,
    );
  });

  it("gives expanded details the remaining row width in constrained layouts", () => {
    const constrainedStart = REPORT_CSS.indexOf(
      "@container (max-width: 760px)",
    );
    const phoneStart = REPORT_CSS.indexOf("@container (max-width: 420px)");
    expect(constrainedStart).toBeGreaterThan(-1);
    expect(phoneStart).toBeGreaterThan(constrainedStart);

    const constrainedCss = REPORT_CSS.slice(constrainedStart, phoneStart);
    expect(constrainedCss).toMatch(
      /\.review-report__row-detail-slot\s*\{[^}]*grid-column:\s*2 \/ -1;/s,
    );
    expect(constrainedCss).not.toMatch(
      /\.review-report__row-detail-slot,\s*\.review-report__row-error\s*\{[^}]*grid-column:\s*2 \/ 3;/s,
    );
  });

  it("keeps complete state transitions inside constrained rows", () => {
    const constrainedStart = REPORT_CSS.indexOf(
      "@container (max-width: 760px)",
    );
    const phoneStart = REPORT_CSS.indexOf("@container (max-width: 420px)");
    expect(constrainedStart).toBeGreaterThan(-1);
    expect(phoneStart).toBeGreaterThan(constrainedStart);

    const constrainedCss = REPORT_CSS.slice(constrainedStart, phoneStart);
    expect(constrainedCss).toMatch(
      /\.review-report__row-change,\s*\.review-report__row-detail-slot\s*\{[^}]*grid-column:\s*2 \/ -1;/s,
    );
    expect(constrainedCss).toMatch(
      /\.review-report__transition\s*\{[^}]*max-width:\s*100%;[^}]*flex-wrap:\s*wrap;[^}]*white-space:\s*normal;/s,
    );
    expect(constrainedCss).toMatch(
      /\.review-report__state\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s,
    );
  });

  it("uses pointer cursors for clickable rows and their details control", () => {
    expect(REPORT_CSS).toMatch(
      /\.review-report__row\s*\{[^}]*cursor: pointer;/s,
    );
    expect(REPORT_CSS).toMatch(
      /\.review-report__row--busy\s*\{[^}]*cursor: default;/s,
    );
    // D-001, the whole point: the confidence cell must NOT look clickable, and
    // the control that DOES disclose must. Asserting both directions is what
    // stops the pill quietly becoming a lying affordance again.
    const confRule = REPORT_CSS.match(
      /\.review-report__row-conf\s*\{[^}]*\}/s,
    )?.[0];
    expect(confRule).toBeTruthy();
    expect(confRule).not.toMatch(/cursor:\s*pointer/);
    expect(REPORT_CSS).toMatch(
      /\.review-report__row-detail-toggle\s*\{[^}]*cursor: pointer;/s,
    );
    expect(REPORT_CSS).toMatch(
      /\.review-report__row-detail-toggle-inner\s*\{[^}]*display: inline-flex;/s,
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
    expect(screen.getByTestId("review-row-status-o1").textContent).toBe(
      "Applied",
    );
    expect(screen.getByTestId("review-row-status-o1").className).toContain(
      "pc-sr-only",
    );
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
              confidence: "medium",
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
    expect(screen.getByTestId("review-row-status-m1").textContent).toBe(
      "Manual review required",
    );
    expect(applyBtn().disabled).toBe(true);
    expect(
      screen.getByText("Writes use the same hand-edit verbs."),
    ).toBeTruthy();
  });

  it("keeps a dynamic row failure visible while detail remains click-only", () => {
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
              confidence: "medium",
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
    fireEvent.click(screen.getByTestId("review-row-failed-row"));
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
              confidence: "high",
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
