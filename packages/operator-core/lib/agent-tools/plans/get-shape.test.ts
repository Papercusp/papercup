/**
 * get-shape.test.ts — plans:get payload-tier shapers
 * (context-trimming-tiers-2026-07-01 P-012).
 *
 * Contract: prose/section bodies capped with a heading-narrowing pointer,
 * browse-read item text capped (rawLine dropped), decisions capped to the
 * newest few, trimmed drops the UI decoration maps LOUDLY (trimmedOmitted).
 * Explicit item/heading detail reads preserve the selected text. Errors + junk
 * pass through untouched.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/plans/get-shape.test.ts
 */
import { describe, expect, it, vi } from "vitest";
import { applyPayloadTier, PAYLOAD_TIER_HARD_CEILING_CHARS } from "@papercusp/tooldef";
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
    expect(String(r.prose_hint)).toContain("tools:invoke { name:'plans:get'");
    expect(out.payloadTier).toBe("trimmed");
  });

  it("caps item text and drops rawLine", () => {
    const items = r.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(12); // structure kept — never drops items
    expect(items[0]!.rawLine).toBeUndefined();
    expect((items[0]!.text as string).length).toBeLessThanOrEqual(200);
    expect(items[0]!.text_truncated).toBe(true);
  });

  it("preserves complete text for an explicit item selection while dropping rawLine", () => {
    const text = "selected item detail ".repeat(180);
    const out = shapePlansGet(
      {
        ok: true,
        results: [
          {
            ok: true,
            slug: "big-plan",
            itemSelection: { requested: ["P-019"], matched: ["P-019"], missing: [] },
            items: [{ id: "P-019", text, rawLine: "- [ ] P-019 duplicate" }],
          },
        ],
      },
      "trimmed",
    ) as { results: Array<Record<string, unknown>> };
    const item = (out.results[0]!.items as Array<Record<string, unknown>>)[0]!;

    expect(item.text).toBe(text);
    expect(item.text_truncated).toBeUndefined();
    expect(item.rawLine).toBeUndefined();
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

  it("preserves the complete body for a heading-narrowed read", () => {
    const env = {
      ok: true,
      results: [
        { ok: true, slug: "s", heading: "Now", section: { heading: "Now", level: 2, body: "b".repeat(30_000) } },
      ],
    };
    const out = shapePlansGet(env, "standard") as { results: Array<Record<string, unknown>> };
    const sec = out.results[0]!.section as Record<string, unknown>;
    expect(sec.body).toBe("b".repeat(30_000));
    expect(sec.body_truncated).toBeUndefined();
    expect(sec.body_full_chars).toBeUndefined();
  });

  it('keeps a 51-decision `heading: "Decisions"` read intact for the MCP result-door', () => {
    const body = Array.from({ length: 51 }, (_, i) =>
      `### D-${String(i + 1).padStart(3, "0")} Decision ${i + 1}\n\n${"decision-body-".repeat(55)}`,
    ).join("\n\n");
    const data = {
      ok: true,
      results: [
        {
          ok: true,
          slug: "plan-with-51-decisions",
          heading: "Decisions",
          section: { heading: "Decisions", level: 2, body },
        },
      ],
    };
    const shape = {
      trimmed: (value: unknown) => shapePlansGet(value, "trimmed"),
      standard: (value: unknown) => shapePlansGet(value, "standard"),
    };
    const out = applyPayloadTier({
      toolName: "plans:get",
      shape,
      response: { data },
      tier: "full",
      args: { slug: "plan-with-51-decisions", heading: "Decisions" },
      deferHardCeilingToResultDoor: true,
      log: vi.fn(),
    });

    expect(JSON.stringify(data).length).toBeGreaterThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    expect((out.data as typeof data).results[0]!.section.body).toBe(body);
    expect(out.payloadProjection).toBeUndefined();
  });

  it("still caps an unmarked section body", () => {
    const env = {
      ok: true,
      results: [
        { ok: true, slug: "s", section: { heading: "Now", level: 2, body: "b".repeat(30_000) } },
      ],
    };
    const out = shapePlansGet(env, "standard") as { results: Array<Record<string, unknown>> };
    const sec = out.results[0]!.section as Record<string, unknown>;
    expect((sec.body as string).length).toBeLessThanOrEqual(20_000);
    expect(sec.body_truncated).toBe(true);
    expect(sec.body_full_chars).toBe(30_000);
  });
});

/**
 * EI-21573289806322713 — a NARROWED decision read is exempt from both cuts.
 *
 * `plans:get { decisions:[ids] }` routes through `narrowDecisionPayload`
 * (./get.ts), which documents itself as existing "specifically to recover a
 * governing ruling whose complete body did not fit in a plan read" and whose
 * arg is published as returning those ids "with complete bodies". Applying the
 * newest-N slice or the body clip there truncates the escape hatch that exists
 * BECAUSE of truncation — and does it while `decisionSelection.missing` still
 * reads `[]`, the field that is "deliberately in-band so a missing id cannot be
 * mistaken for a complete read".
 *
 * Measured before the fix: 5 explicitly-requested ids returned matched:5 /
 * missing:[] with every body clipped, one at 186 of 4,782 chars.
 *
 * `narrowedEnvelope` mirrors what narrowDecisionPayload actually emits —
 * identity/CAS fields + decisions + decisionSelection, and deliberately NO
 * prose/items/decorations, since stripping those is how that selector already
 * pays its own budget.
 */
function narrowedEnvelope(opts: { withSelection: boolean; count?: number }) {
  const count = opts.count ?? 12;
  const ids = Array.from({ length: count }, (_, i) => `D-${String(i).padStart(3, "0")}`);
  return {
    ok: true,
    counts: { ok: 1, failed: 0 },
    results: [
      {
        ok: true,
        slug: "big-plan",
        frontmatter: { slug: "big-plan", title: "Big" },
        contentHash: "abc123",
        version: 30,
        counts: { items: 7, decisions: count, sections: 10 },
        decisions: ids.map((id, i) => ({
          id,
          title: `d${i}`,
          // Comfortably past both decisionBody caps (trimmed 240, standard 600).
          body: `body ${i} ${"z".repeat(4_000)}`,
        })),
        ...(opts.withSelection
          ? { decisionSelection: { requested: ids, matched: ids, missing: [] as string[] } }
          : {}),
      },
    ],
  };
}

describe("shapePlansGet: narrowed decision reads keep COMPLETE bodies (EI-21573289806322713)", () => {
  for (const tier of ["trimmed", "standard"] as const) {
    it(`${tier}: every requested decision survives with an uncut body`, () => {
      const env = narrowedEnvelope({ withSelection: true });
      // Snapshot the EXACT input bodies and compare against those rather than a
      // reconstructed length — strings are immutable, so this is a true
      // before-image, and it cannot drift from the fixture the way a hand-built
      // expected length can (it did: `body 10 ` is one char longer than
      // `body 0 `, so a reconstruction was wrong for every two-digit index).
      const expectedBodies = new Map(
        (env.results[0]!.decisions as Array<{ id: string; body: string }>).map((d) => [d.id, d.body]),
      );
      const out = shapePlansGet(env, tier) as {
        results: Array<Record<string, unknown>>;
      };
      const r = out.results[0]!;
      const decisions = r.decisions as Array<Record<string, unknown>>;

      // The tail-slice is the more dangerous of the two cuts: it drops
      // explicitly-requested ids from the HEAD. 12 > the trimmed cap of 8.
      expect(decisions).toHaveLength(12);
      expect(decisions[0]!.id).toBe("D-000"); // the head the slice would have cut
      expect(r.decisionsTruncated).toBeUndefined();

      // ...and every body is byte-for-byte what went in, at either tier.
      for (const d of decisions) {
        expect(d.body).toBe(expectedBodies.get(String(d.id)));
        expect(d.body_truncated).toBeUndefined();
        expect(d.body_full_chars).toBeUndefined();
      }

      // The honesty field still means what it says.
      expect(r.decisionSelection).toMatchObject({ missing: [] });
    });
  }

  it("is keyed on decisionSelection: the SAME payload without it is still cut", () => {
    // The differential control. Identical decisions array; the only difference
    // is the presence of `decisionSelection`. This pins the guard's TRIGGER, not
    // merely its effect — a future edit that exempts the wrong reads, or that
    // stops detecting narrowed ones, fails exactly here.
    const browse = shapePlansGet(narrowedEnvelope({ withSelection: false }), "trimmed") as {
      results: Array<Record<string, unknown>>;
    };
    const b = browse.results[0]!;
    const browsed = b.decisions as Array<Record<string, unknown>>;

    expect(browsed).toHaveLength(8); // newest-N still applies to a browse read
    expect(browsed[0]!.id).not.toBe("D-000"); // head still cut
    expect((browsed[0]!.body as string).length).toBeLessThanOrEqual(240);
    expect(browsed[0]!.body_truncated).toBe(true);
    expect(b.decisionsTruncated).toMatchObject({ total: 12, shown: 8 });
  });

  it("a narrowed read UNDER the caps is unchanged either way", () => {
    // Guards against a fix that accidentally makes the exempt path special in
    // some other way: a small selection should look identical to what the
    // unexempted shaper would already have produced.
    const out = shapePlansGet(
      { ok: true, results: [{ ok: true, slug: "s", decisions: [{ id: "D-001", title: "t", body: "short" }], decisionSelection: { requested: ["D-001"], matched: ["D-001"], missing: [] } }] },
      "trimmed",
    ) as { results: Array<Record<string, unknown>> };
    const decisions = out.results[0]!.decisions as Array<Record<string, unknown>>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.body).toBe("short");
    expect(decisions[0]!.body_truncated).toBeUndefined();
  });
});
