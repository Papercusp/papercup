// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
                },
              ],
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

    const changingTable = screen.getByRole("table", {
      name: "2 changing criteria, regressions first",
    });
    const changingRows = within(changingTable).getAllByRole("row");
    expect(changingRows[1]?.textContent).toContain("Regressing cost");
    expect(changingRows[2]?.textContent).toContain("Improving clarity");
    expect(screen.queryByText("Stable evidence")).toBeNull();
    expect(screen.queryByText("scorecard-3")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Stable criteria/ }));
    expect(screen.getByText("Stable evidence")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Grading history/ }));
    expect(screen.getByText("scorecard-3")).toBeTruthy();
  });
});
