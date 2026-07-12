// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RubricsPanel from "./RubricsPanel";

const useSyncQuery = vi.fn();
vi.mock("@papercusp/sync", () => ({
  useSyncQuery: (...args: unknown[]) => useSyncQuery(...args),
}));

const rows = [
  {
    rubricId: "rubric-quality",
    characteristic: "quality",
    title: "Outcome quality",
    status: "ratified",
    criteriaCount: 5,
    ratingScale: ["fail", "partial", "pass"],
    methodRef: null,
    updatedAt: "2026-07-10T00:00:00.000Z",
    scorecardCount: 4,
    latestScorecardAt: new Date().toISOString(),
    latestScore10: 9,
    avgScore10: 8,
  },
  {
    rubricId: "rubric-cost",
    characteristic: "efficiency",
    title: "Cost efficiency",
    status: "draft",
    criteriaCount: 3,
    ratingScale: ["fail", "pass"],
    methodRef: null,
    updatedAt: "2026-07-10T00:00:00.000Z",
    scorecardCount: 0,
    latestScorecardAt: null,
    latestScore10: null,
    avgScore10: null,
  },
];

afterEach(cleanup);

describe("RubricsPanel visual coverage matrix", () => {
  beforeEach(() => {
    useSyncQuery.mockReturnValue({ data: rows, error: null, loading: false });
  });

  it("renders the dominant score, coverage ring, evidence matrix, and freshness cells", () => {
    render(<RubricsPanel />);
    expect(screen.getByText("Average")).toBeTruthy();
    expect(screen.getAllByText("8.0").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Coverage" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Score" })).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: "Freshness" }),
    ).toBeTruthy();
    expect(document.querySelector(".pc-rubrics__pulse")).not.toBeNull();
  });

  it("keeps the rubric matrix selectable for the evidence drawer", () => {
    const onSelect = vi.fn();
    render(<RubricsPanel onSelect={onSelect} />);
    fireEvent.click(screen.getByText("Outcome quality"));
    expect(onSelect).toHaveBeenCalledWith("rubric-quality");
  });

  it("becomes a focused selected rail beside the evidence detail", () => {
    render(<RubricsPanel compact selectedId="rubric-quality" />);
    expect(document.querySelector(".pc-rubrics.is-compact")).not.toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Domain" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Coverage" })).toBeNull();
    expect(
      screen
        .getByText("Outcome quality")
        .closest("tr")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
  });
});
