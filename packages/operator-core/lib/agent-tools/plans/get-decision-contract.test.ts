import { describe, expect, it } from "vitest";
import tool from "./get";

describe("plans:get decision selection contract", () => {
  it("rejects a decisionId-only read with a plan-local identity explanation", () => {
    const result = tool.args.safeParse({ decisionId: "D-074", mode: "full" });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toContain("D-NNN ids are plan-local");
  });

  it("accepts decision selection when the owning plan slug is supplied", () => {
    expect(
      tool.args.safeParse({ slug: "example-plan", decisionId: "D-074", mode: "full" }).success,
    ).toBe(true);
  });
});
