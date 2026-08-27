// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PlanProvenanceBadge, {
  matchesPlanSource,
  resolvePlanSource,
} from "./PlanProvenanceBadge";

afterEach(cleanup);

describe("PlanProvenanceBadge", () => {
  it("renders the Blender class with the literal appliance glyph and text", () => {
    render(<PlanProvenanceBadge origin="scout" testId="source" />);
    const badge = screen.getByTestId("source");
    expect(badge.textContent).toBe("Blender");
    expect(badge.getAttribute("data-plan-provenance")).toBe("blender");
    expect(badge.getAttribute("aria-label")).toBe("Plan source: Blender");
    expect(badge.querySelectorAll("path")).toHaveLength(4);
  });

  it("uses the resolved plan-owner handle for a user-created plan", () => {
    render(
      <PlanProvenanceBadge
        origin={null}
        ownerIdentity={{ handle: "Avi" }}
        testId="source"
      />,
    );
    const badge = screen.getByTestId("source");
    expect(badge.textContent).toBe("Avi");
    expect(badge.getAttribute("data-plan-provenance")).toBe("user");
    expect(badge.getAttribute("aria-label")).toBe("Plan source: Avi (User)");
  });

  it.each([undefined, null] as const)(
    "falls back to User when no owner identity resolves (%s)",
    (origin) => {
      render(<PlanProvenanceBadge origin={origin} testId="source" />);
      const badge = screen.getByTestId("source");
      expect(badge.textContent).toBe("User");
      expect(badge.getAttribute("data-plan-provenance")).toBe("user");
      expect(badge.getAttribute("aria-label")).toBe("Plan source: User");
    },
  );

  it("shares the exact binary projection with source filtering", () => {
    const user = { origin: null, ownerIdentity: { handle: "Avi" } } as const;
    const blender = { origin: "scout" } as const;
    expect(resolvePlanSource(user).kind).toBe("user");
    expect(resolvePlanSource(blender).kind).toBe("blender");
    expect(matchesPlanSource(user, "user")).toBe(true);
    expect(matchesPlanSource(user, "blender")).toBe(false);
    expect(matchesPlanSource(blender, "blender")).toBe(true);
    expect(matchesPlanSource(blender, "all")).toBe(true);
  });
});
