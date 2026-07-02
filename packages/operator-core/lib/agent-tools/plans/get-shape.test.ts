/**
 * get-shape.test.ts — plans:get payload-tier shapers
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * Contract: prose/section bodies capped with a heading-narrowing pointer, item
 * text capped (rawLine dropped), decisions capped to the newest few, trimmed
 * drops the UI decoration maps LOUDLY (trimmedOmitted). Errors + junk pass
 * through untouched.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/get-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { shapePlansGet } from "./get-shape";

function envelope() {
  return {
    ok: true,
    counts: { ok: 1, failed: 1 },
    results: [
      {
        ok: true,
        slug: "big-plan",
        frontmatter: { slug: "big-plan", title: "Big" },
        now: { state: "s", next: "n" },
        sectionIndex: [{ heading: "Now", level: 2, chars: 100 }],
        prose: "p".repeat(30_000),
        items: Array.from({ length: 12 }, (_, i) => ({
          id: `P-00${i}`,
          text: `item ${i} ${"x".repeat(500)}`,
          storedStatus: "todo",
          effectiveStatus: "todo",
          rawLine: `- [ ] P-00${i} raw ${"y".repeat(500)}`,
        })),
        decisions: Array.from({ length: 12 }, (_, i) => ({
          id: `D-00${i}`,
          title: `d${i}`,
          body: `body ${i} ${"z".repeat(800)}`,
        })),
        linkedFeatures: { "P-001": { featureId: "F-1", status: "todo", harnessSlug: "h" } },
        planItemTests: { "P-001": { covered: 1 } },
        blockingIssues: { "P-002": ["EI-9"] },
      },
      { ok: false, slug: "missing", error: "not_found" },
    ],
  };
}

describe("shapePlansGet trimmed", () => {
  const out = shapePlansGet(envelope(), "trimmed") as {
    payloadTier: string;
    results: Array<Record<string, unknown>>;
  };
  const r = out.results[0]!;

  it("caps prose with a loud heading-narrowing pointer", () => {
    expect((r.prose as string).length).toBeLessThanOrEqual(6_000);
    expect(r.prose_truncated).toBe(true);
    expect(r.prose_full_chars).toBe(30_000);
    expect(String(r.prose_hint)).toContain("heading");
    expect(out.payloadTier).toBe("trimmed");
  });

  it("caps item text and drops rawLine", () => {
    const items = r.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(12); // structure kept — never drops items
    expect(items[0]!.rawLine).toBeUndefined();
    expect((items[0]!.text as string).length).toBeLessThanOrEqual(200);
    expect(items[0]!.text_truncated).toBe(true);
  });

  it("keeps the NEWEST decisions with a truncation marker", () => {
    const decisions = r.decisions as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(8);
    expect(decisions[7]!.id).toBe("D-0011"); // tail kept, head cut
    expect((decisions[0]!.body as string).length).toBeLessThanOrEqual(240);
    expect(r.decisionsTruncated).toMatchObject({ total: 12, shown: 8 });
  });

  it("drops UI decoration maps loudly, keeps blockingIssues", () => {
    expect(r.linkedFeatures).toBeUndefined();
    expect(r.planItemTests).toBeUndefined();
    expect(r.trimmedOmitted).toMatchObject({
      fields: ["linkedFeatures", "planItemTests"],
    });
    expect(r.blockingIssues).toEqual({ "P-002": ["EI-9"] });
  });

  it("passes error results + junk through untouched", () => {
    expect(out.results[1]).toEqual({ ok: false, slug: "missing", error: "not_found" });
    expect(shapePlansGet(null, "trimmed")).toBeNull();
    expect(shapePlansGet({ no: "results" }, "trimmed")).toEqual({ no: "results" });
  });
});

describe("shapePlansGet standard", () => {
  it("is a looser projection that keeps the decoration maps", () => {
    const out = shapePlansGet(envelope(), "standard") as {
      results: Array<Record<string, unknown>>;
    };
    const r = out.results[0]!;
    expect((r.prose as string).length).toBeLessThanOrEqual(20_000);
    expect(r.linkedFeatures).toBeDefined();
    expect(r.trimmedOmitted).toBeUndefined();
    expect((r.decisions as unknown[]).length).toBe(12); // under the 20 cap
    expect(r.decisionsTruncated).toBeUndefined();
  });

  it("caps a heading-narrowed section body", () => {
    const env = {
      ok: true,
      results: [
        { ok: true, slug: "s", heading: "Now", section: { heading: "Now", level: 2, body: "b".repeat(30_000) } },
      ],
    };
    const out = shapePlansGet(env, "standard") as { results: Array<Record<string, unknown>> };
    const sec = out.results[0]!.section as Record<string, unknown>;
    expect((sec.body as string).length).toBeLessThanOrEqual(20_000);
    expect(sec.body_truncated).toBe(true);
    expect(sec.body_full_chars).toBe(30_000);
  });
});
