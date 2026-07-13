// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
    // WI-4506 split-provenance: author ≠ ratifier (the D-012 governance story).
    proposedBy: "su-f69a7079-b041-49de-8468-b012df5abb2e",
    ratifiedBy: "su-eb9b7ae3-d528-4584-8379-e69f2b8fe7b9",
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
    proposedBy: "su-f69a7079-b041-49de-8468-b012df5abb2e",
    ratifiedBy: null,
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
    render(
      <RubricsPanel compact collapseUnscored selectedId="rubric-quality" />,
    );
    expect(document.querySelector(".pc-rubrics.is-compact")).not.toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Domain" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Coverage" })).toBeNull();
    expect(
      screen
        .getByText("Outcome quality")
        .closest("tr")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByText("Cost efficiency")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Unscored rubrics/ }));
    expect(screen.getByText("Cost efficiency")).toBeTruthy();
  });

  it("reports a data-backed live status to the Learning navigation", async () => {
    const onStatus = vi.fn();
    render(<RubricsPanel onStatus={onStatus} />);
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith("good"));
  });

  // ── WI-4506: governance visibility (proposed-vs-active prominence + provenance) ──
  it("hoists a rubric awaiting ratification into a prominent banner", () => {
    render(<RubricsPanel />);
    const banner = screen.getByRole("status", {
      name: /awaiting ratification/i,
    });
    expect(banner).toBeTruthy();
    // the draft rubric is named in the banner as a governance action item
    expect(banner.textContent).toContain("Cost efficiency");
    // the count is surfaced
    expect(banner.querySelector("strong")?.textContent).toBe("1");
  });

  it("clicking a banner item drills into that rubric (the ratifier's entry point)", () => {
    const onSelect = vi.fn();
    render(<RubricsPanel onSelect={onSelect} />);
    const banner = screen.getByRole("status", {
      name: /awaiting ratification/i,
    });
    fireEvent.click(
      banner.querySelector(".pc-rubrics__awaiting-item") as HTMLElement,
    );
    expect(onSelect).toHaveBeenCalledWith("rubric-cost");
  });

  it("surfaces proposer/ratifier provenance and flags an independent (split) ratifier", () => {
    render(<RubricsPanel />);
    expect(
      screen.getByRole("columnheader", { name: "Governance" }),
    ).toBeTruthy();
    // the active rubric shows both identities...
    const govCells = document.querySelectorAll(".pc-rubrics__gov");
    const active = Array.from(govCells).find((c) =>
      c.className.includes("--active"),
    );
    expect(active?.textContent).toContain("su-f69a7079");
    expect(active?.textContent).toContain("su-eb9b7ae3");
    // ...and, because author ≠ ratifier, the split-provenance badge (D-012)
    expect(active?.querySelector(".pc-rubrics__gov-split")).not.toBeNull();
  });

  it("does NOT flag a split when the same actor proposed and ratified", () => {
    const same = "su-single-0000-0000-0000-000000000000";
    useSyncQuery.mockReturnValue({
      data: [{ ...rows[0], proposedBy: same, ratifiedBy: same }],
      error: null,
      loading: false,
    });
    render(<RubricsPanel />);
    expect(
      document.querySelector(".pc-rubrics__gov-split"),
    ).toBeNull();
  });

  it("omits the awaiting banner in the compact selected rail", () => {
    render(
      <RubricsPanel compact collapseUnscored selectedId="rubric-quality" />,
    );
    expect(screen.queryByRole("status", { name: /awaiting ratification/i })).toBeNull();
  });
});
