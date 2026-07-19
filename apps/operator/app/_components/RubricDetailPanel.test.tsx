// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RubricDetailPanel from "./RubricDetailPanel";

vi.mock("@papercusp/sync", () => ({
  useSyncQuery: ({ queryName }: { queryName: string }) =>
    queryName === "rubrics.trend"
      ? {
          data: [
            {
              rubricRef: "rubric-quality",
              scorecardCount: 3,
              window: {},
              criteria: [
                {
                  criterion: "Stable evidence",
                  count: 3,
                  distribution: { pass: 3 },
                  idleCount: 0,
                  first: { rating: "pass", at: "2026-07-01" },
                  latest: { rating: "pass", at: "2026-07-03" },
                  direction: "stable",
                  mean10: 8,
                },
                {
                  criterion: "Improving clarity",
                  count: 3,
                  distribution: { pass: 2, partial: 1 },
                  idleCount: 0,
                  first: { rating: "partial", at: "2026-07-01" },
                  latest: { rating: "pass", at: "2026-07-03" },
                  direction: "improving",
                  mean10: 7,
                },
                {
                  criterion: "Regressing cost",
                  count: 3,
                  distribution: { fail: 2, partial: 1 },
                  idleCount: 0,
                  first: { rating: "pass", at: "2026-07-01" },
                  latest: { rating: "fail", at: "2026-07-03" },
                  direction: "regressing",
                  mean10: 3,
                  // WI-4607: per-criterion instrument binding parsed from the model token.
                  instrumentKey: "gate-red-count",
                },
              ],
              // WI-4607 governance provenance: author ≠ ratifier ⇒ the split badge (D-012).
              status: "active",
              proposedBy: "su-f69a7079-b041-49de-8468-b012df5abb2e",
              ratifiedBy: "su-eb9b7ae3-d528-4584-8379-e69f2b8fe7b9",
            },
          ],
          loading: false,
          error: null,
        }
      : {
          data: [
            {
              issueId: "scorecard-3",
              createdAt: "2026-07-03T00:00:00.000Z",
              createdBy: "owner",
              score10: 6,
              nKeys: 3,
              rubricResolved: true,
              missingKeys: [],
            },
          ],
          loading: false,
          error: null,
        },
}));

afterEach(cleanup);

describe("RubricDetailPanel focused evidence", () => {
  it("puts regressions before improvements and collapses stable criteria and history", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    expect(screen.getByLabelText("Rubric summary")).toBeTruthy();

    const changingTable = screen.getByRole("table", {
      name: "2 changing criteria, regressions first",
    });
    const changingRows = within(changingTable).getAllByRole("row");
    expect(changingRows[1]?.textContent).toContain("Regressing cost");
    expect(changingRows[2]?.textContent).toContain("Improving clarity");
    expect(
      within(changingTable).getByRole("img", {
        name: /2× fail, 1× partial; 3 rated/,
      }),
    ).toBeTruthy();
    expect(changingTable.textContent).not.toContain("Rated");
    expect(screen.queryByText("Stable evidence")).toBeNull();
    expect(screen.queryByText("scorecard-3")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Stable criteria/ }));
    expect(screen.getByText("Stable evidence")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Grading history/ }));
    expect(screen.getByText("scorecard-3")).toBeTruthy();
  });

  it("surfaces the governance provenance chain with the split badge (WI-4607, D-012)", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const gov = document.querySelector(".pc-rubric-detail__gov");
    expect(gov).not.toBeNull();
    // status prominence
    expect(gov?.querySelector(".pc-rubric-detail__gov-status")?.textContent).toBe(
      "Active",
    );
    // both identities in the chain, shortened
    expect(gov?.textContent).toContain("su-f69a7079");
    expect(gov?.textContent).toContain("su-eb9b7ae3");
    // author ≠ ratifier ⇒ split badge (the D-012 governance point)
    expect(gov?.querySelector(".pc-rubric-detail__gov-split")).not.toBeNull();
  });

  it("shows the per-criterion instrument binding badge (WI-4607)", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const instr = document.querySelector(".pc-rubric-trend__instr");
    expect(instr).not.toBeNull();
    expect(instr?.textContent).toBe("gate-red-count");
  });

  it("renders the Trend column as a colored icon, keeping the word in the aria-label + tooltip (WI-5415)", () => {
    render(<RubricDetailPanel rubricId="rubric-quality" />);
    const changingTable = screen.getByRole("table", {
      name: "2 changing criteria, regressions first",
    });
    // The "regressing" row gets a down-trend icon whose accessible name still
    // carries the word — prose is gone from the visible cell, not from a11y.
    const regressing = within(changingTable).getByRole("img", {
      name: "regressing",
    });
    expect(regressing.querySelector("svg")).not.toBeNull();
    expect(regressing.getAttribute("title")).toBe("regressing");
    expect(regressing.textContent).toBe(""); // no prose left in the visible cell

    fireEvent.click(screen.getByRole("button", { name: /Stable criteria/ }));
    expect(screen.getByRole("img", { name: "stable" })).toBeTruthy();
  });
});
