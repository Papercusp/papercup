/**
 * RECURRENCE GUARD — EI-20038981829684213.
 *
 * `plans:get { heading:'Decisions' }` returned a plausible-looking D-001..D-004
 * from a 30-decision ledger. The reporter nearly cited a decision from that
 * partial view; what saved them was unrelated suspicion, not anything in the
 * output. Decisions are the governance substrate — CLAUDE.md tells agents to
 * read a claimed item's plan decisions before building and to cite
 * `<slug>#D-NNN` rather than paraphrase — so a silently-partial ledger makes a
 * governing ruling that EXISTS indistinguishable from one that does not.
 *
 * ## What this guard asserts, and why it is shaped this way
 *
 * The property under test is deliberately NOT "the result has a
 * `body_truncated` field". That was already true when the bug was filed, and it
 * is exactly what a `projection.pick:['results[].section.body']` strips — which
 * also blinds the result door, whose upstream-truncation detector scans the
 * SERIALIZED TEXT for marker field names (result-door.ts:380). Asserting the
 * field name would therefore have passed against the broken build.
 *
 * The property is: A READER HOLDING NOTHING BUT THE BODY STRING CAN STILL TELL
 * IT IS INCOMPLETE — and, for a record ledger, how many records it is missing.
 * That is the reader the bug actually harmed, so that is the reader the guard
 * simulates ({@link pickBodyOnly}).
 *
 * The suite is driven through `shapePlansGet` — the REAL entry point — not the
 * helper alone. A helper can be correct, covered, and unreachable; that failure
 * has landed twice on this repo (WI-37503's inert constant, WI-37527's unwired
 * banner), both times with green unit tests.
 *
 * `PRE_FIX_CLIP` is a permanent falsifiability CONTROL, not a calibration case.
 * Calibration ("a real ledger still gets a marker") only proves the guard fires;
 * the control reconstructs the shipped-broken implementation and asserts it
 * VIOLATES the property, which is what proves a revert reds this file rather
 * than passing quietly. It is a local const so proving falsifiability never
 * mutates the shared tree (scripts/mutation-probe.sh exists for subjects that
 * cannot be imported; a module you can import needs no window at all).
 */
import { describe, expect, it } from "vitest";
import { shapePlansGet } from "./get-shape";
import { clipSectionBody, clipWithMarker, SHAPE_RECOVER_HINT } from "./shape-clip";
import { findSection, splitSections } from "./get.js";

/** The implementation that shipped the bug: a bare `…`, indistinguishable from prose. */
const PRE_FIX_CLIP = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const DECISION_COUNT = 30;

/** A Decisions section shaped like the real one (30 records, ~90KB). */
function decisionLedger(count = DECISION_COUNT): string {
  return Array.from({ length: count }, (_, i) => {
    const id = `D-${String(i + 1).padStart(3, "0")}`;
    return `### ${id} — ruling ${id}\n\n${"body prose. ".repeat(250)}\n`;
  }).join("\n");
}

/**
 * A section body on a result that did NOT explicitly narrow to a heading (no
 * result-level `heading` marker). Since 2026-09-04 an EXPLICIT heading read
 * (`plans:get { heading }`, which stamps `heading` beside `section`) is exempt
 * from this clip — the narrow read must be able to recover the very body it
 * selected, and an oversized one is spilled by the result door with a durable
 * cursor (get-shape.test.ts "preserves the complete body for a heading-narrowed
 * read"). The record-boundary clip under test here is the path that still
 * serves an UNMARKED section body ("still caps an unmarked section body").
 */
function shapeSectionRead(body: string, tier: "trimmed" | "standard") {
  const out = shapePlansGet(
    {
      ok: true,
      results: [{ ok: true, slug: "p", section: { heading: "Decisions", level: 2, body } }],
    },
    tier,
  ) as { results: Array<Record<string, unknown>> };
  return out.results[0]!.section as Record<string, unknown>;
}

/** The same ledger read the way `plans:get { heading:'Decisions' }` returns it. */
function shapeHeadingNarrowedRead(body: string, tier: "trimmed" | "standard") {
  const out = shapePlansGet(
    {
      ok: true,
      results: [
        { ok: true, slug: "p", heading: "Decisions", section: { heading: "Decisions", level: 2, body } },
      ],
    },
    tier,
  ) as { results: Array<Record<string, unknown>> };
  return out.results[0]!.section as Record<string, unknown>;
}

/** Simulate `projection: { pick: ['results[].section.body'] }` — the value, no siblings. */
const pickBodyOnly = (section: Record<string, unknown>): string => section.body as string;

describe("EI-20038981829684213 — a clipped section body announces itself IN BAND", () => {
  it("THE BUG: a 30-decision ledger read at the default tier is not mistakable for a complete one", () => {
    const section = shapeSectionRead(decisionLedger(), "trimmed");
    const bodyAlone = pickBodyOnly(section);

    // Precondition: this fixture really is truncated. Without it the assertions
    // below would also pass on a body that was never cut.
    expect(section.body_truncated).toBe(true);
    expect(section.body_records_total).toBe(DECISION_COUNT);
    expect(section.body_records_shown as number).toBeLessThan(DECISION_COUNT);

    // The property: the BODY ALONE carries the bad news.
    expect(bodyAlone).toContain("TRUNCATED");
    expect(bodyAlone).toContain(`of ${DECISION_COUNT}`);
  });

  it("CONTROL: the pre-fix clip VIOLATES that property (so a revert reds this file)", () => {
    const ledger = decisionLedger();
    const preFix = PRE_FIX_CLIP(ledger, 6_000);

    expect(preFix.length).toBeLessThanOrEqual(6_000); // it really did clip
    expect(preFix).not.toContain("TRUNCATED");
    expect(preFix).not.toContain(`of ${DECISION_COUNT}`);
    // The whole defect in one line: its only signal is a character that occurs
    // constantly inside real content.
    expect(preFix.endsWith("…")).toBe(true);
  });

  it("CALIBRATION: a body that FITS is returned untouched and unmarked", () => {
    const small = decisionLedger(1);
    const section = shapeSectionRead(small, "standard");
    // Under the cap → shapeResult leaves `section` alone entirely.
    expect(section.body).toBe(small);
    expect(section.body_truncated).toBeUndefined();
    expect(String(section.body)).not.toContain("TRUNCATED");
  });

  it("cuts at a RECORD boundary — never mid-decision", () => {
    const section = shapeSectionRead(decisionLedger(), "trimmed");
    const shown = section.body_records_shown as number;
    const body = section.body as string;

    expect(shown).toBeGreaterThanOrEqual(1);
    // Every record the reader can see is a WHOLE record: the count of record
    // headers in the retained text equals the reported count, and the text
    // before the marker ends at a record end rather than inside one.
    const retained = body.slice(0, body.indexOf("…["));
    expect(retained.match(/^### /gm) ?? []).toHaveLength(shown);
    expect(retained.trimEnd().endsWith("body prose.")).toBe(true);
  });

  it("respects the tier budget while carrying the marker", () => {
    expect((shapeSectionRead(decisionLedger(), "trimmed").body as string).length).toBeLessThanOrEqual(6_000);
    expect((shapeSectionRead(decisionLedger(), "standard").body as string).length).toBeLessThanOrEqual(20_000);
  });

  it("a standard-tier read shows MORE records than trimmed, and both say so", () => {
    const t = shapeSectionRead(decisionLedger(), "trimmed");
    const s = shapeSectionRead(decisionLedger(), "standard");
    expect(s.body_records_shown as number).toBeGreaterThan(t.body_records_shown as number);
    expect(s.body_records_total).toBe(DECISION_COUNT);
  });

  it("an EXPLICIT heading read is exempt: the selected ledger comes back whole, unmarked", () => {
    // The narrow read exists to fetch exactly this body; clipping it again would
    // make the recovery pointer above unrecoverable. Oversize is the result
    // door's job there (durable cursor), not this shaper's.
    const ledger = decisionLedger();
    const section = shapeHeadingNarrowedRead(ledger, "trimmed");
    expect(section.body).toBe(ledger);
    expect(section.body_truncated).toBeUndefined();
    expect(section.body_records_shown).toBeUndefined();
  });
});

describe("clipWithMarker / clipSectionBody", () => {
  it("never returns a silently-clipped string, at any cap", () => {
    for (const n of [10, 50, 120, 200, 1_000, 6_000]) {
      const out = clipWithMarker("x".repeat(50_000), n);
      expect(out).toContain("TRUNCATED");
    }
  });

  it("keeps the result within budget for realistic caps, and reports the omitted count", () => {
    const out = clipWithMarker("x".repeat(50_000), 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toMatch(/\+\d+ chars/);
  });

  it("uses the compact marker on a short budget so content is not crowded out", () => {
    const short = clipWithMarker("x".repeat(5_000), 120);
    expect(short.length).toBeLessThanOrEqual(120);
    expect(short).toContain("TRUNCATED");
    // The recovery hint is the part that yields on a small budget.
    expect(short).not.toContain("payloadTier");
    // …but a roomy budget keeps it, so the reader is told how to recover.
    expect(clipWithMarker("x".repeat(50_000), 6_000)).toContain(SHAPE_RECOVER_HINT);
  });

  it("uses the schema-safe nested dispatch for the reserved tier override", () => {
    const marker = clipWithMarker("x".repeat(50_000), 6_000);
    expect(marker).toContain("tools:invoke { name:'plans:get'");
    expect(marker).toContain("payloadTier:'full'");
    expect(marker).not.toContain('recover: payloadTier:"full"');
  });

  it("a body with NO record structure still gets an in-band char marker", () => {
    const cut = clipSectionBody("b".repeat(30_000), 6_000);
    expect(cut.truncated).toBe(true);
    expect(cut.fullChars).toBe(30_000);
    expect(cut.recordsTotal).toBeUndefined();
    expect(cut.body).toContain("TRUNCATED");
  });

  it("reports 0-of-N rather than a boundary cut when the FIRST record overruns the budget", () => {
    const huge = `### D-001\n${"x".repeat(50_000)}\n\n### D-002\nsecond\n`;
    const cut = clipSectionBody(huge, 1_000);
    expect(cut.recordsShown).toBe(0);
    expect(cut.recordsTotal).toBe(2);
    expect(cut.body).toContain("TRUNCATED");
  });
});

/**
 * EI-19459526252132133 — the record marker's recovery pointer.
 *
 * This module's rule is that a pointer is advertised only if it RESOLVES: "a
 * pointer that does not resolve is worse than none, because it becomes a lie
 * the reader trusts." A full-tier `tools:invoke` dispatch was the only honest exit while a
 * single record was unaddressable — but it is the wrong SIZE of answer, since
 * re-serving all N records to recover one just overflows the door again.
 *
 * plans:get now resolves `heading` to a `### ` record, so the marker names the
 * first record the reader is missing. The load-bearing test is the last one: it
 * feeds the emitted pointer back through the REAL resolver, so if the two ever
 * drift the pointer is caught being a lie rather than being trusted.
 */
describe("clipSectionBody — record recovery pointer", () => {
  const PLAN_SECTION = [
    "### D-001 — first ruling",
    "a".repeat(3_000),
    "",
    "### D-020 — the load-bearing ruling",
    "b".repeat(3_000),
    "",
    "### D-030 — a later ruling",
    "c".repeat(3_000),
  ].join("\n");

  it("names the FIRST OMITTED record, not the last shown one", () => {
    const cut = clipSectionBody(PLAN_SECTION, 4_000);
    expect(cut.recordsShown).toBe(1);
    expect(cut.recordsTotal).toBe(3);
    // D-001 was shown; D-020 is the first thing the reader is missing.
    expect(cut.body).toContain('plans:get { heading:"D-020');
    expect(cut.body).not.toContain('heading:"D-001');
  });

  it("still fits the budget with the pointer included", () => {
    // The reserve is sized against a full-length heading placeholder, so a
    // single pass must never overrun regardless of the real heading's length.
    for (const n of [300, 1_000, 4_000, 8_000]) {
      const cut = clipSectionBody(PLAN_SECTION, n);
      expect(cut.body.length, `cap ${n}`).toBeLessThanOrEqual(n);
    }
  });

  it("names the first record when ZERO complete records survive", () => {
    const huge = `### D-001 — a ruling\n${"x".repeat(50_000)}\n\n### D-002\nsecond\n`;
    const cut = clipSectionBody(huge, 1_000);
    expect(cut.recordsShown).toBe(0);
    expect(cut.body).toContain('plans:get { heading:"D-001');
  });

  it("keeps a long heading bounded so the marker cannot crowd out content", () => {
    // The omitted record carries a ~400-char heading; the quote must be capped
    // (RECOVER_HEADING_MAX) or the marker eats the budget it was reserved from.
    const longHeading = `### ${"D-020 — ".padEnd(400, "very long ruling title ")}`;
    const body = `### D-001 — a ruling\n${"a".repeat(1_500)}\n\n${longHeading}\n${"b".repeat(3_000)}\n`;
    const cut = clipSectionBody(body, 2_500);
    expect(cut.truncated).toBe(true);
    expect(cut.recordsShown).toBe(1);
    expect(cut.body.length).toBeLessThanOrEqual(2_500);
    expect(cut.body).toContain("TRUNCATED");
    expect(cut.body).toContain('heading:"D-020');
  });

  it("EI-22128943077118798: omittedHeadings names EVERY omitted record, not just the first", () => {
    const cut = clipSectionBody(PLAN_SECTION, 4_000);
    expect(cut.recordsShown).toBe(1);
    expect(cut.recordsTotal).toBe(3);
    // D-001 was shown; D-020 and D-030 were both omitted — both must be named,
    // not only the D-020 the in-band marker points at.
    expect(cut.omittedHeadings).toEqual([
      "D-020 — the load-bearing ruling",
      "D-030 — a later ruling",
    ]);
  });

  it("EI-22128943077118798: omittedHeadings survives even when ZERO complete records fit", () => {
    const huge = `### D-001 — a ruling\n${"x".repeat(50_000)}\n\n### D-002 — second\nsecond\n`;
    const cut = clipSectionBody(huge, 1_000);
    expect(cut.recordsShown).toBe(0);
    expect(cut.omittedHeadings).toEqual(["D-001 — a ruling", "D-002 — second"]);
  });

  it("EI-22128943077118798: omittedHeadings is capped so a mega-plan cannot re-inflate the payload", () => {
    const records = Array.from({ length: 25 }, (_, i) => `### D-${String(i).padStart(3, "0")} — ruling\nbody`).join(
      "\n\n",
    );
    const cut = clipSectionBody(records, 200);
    expect(cut.omittedHeadings?.length).toBe(21); // 20 named + one "+N more" entry
    expect(cut.omittedHeadings?.at(-1)).toMatch(/^\+\d+ more$/);
  });

  it("THE POINTER RESOLVES: the heading it names round-trips through plans:get's resolver", () => {
    // The falsifier for this whole change. A marker that quotes a heading the
    // real lookup cannot find would be exactly the lie this module forbids —
    // and a clipped heading only works because that lookup matches substrings.
    const cut = clipSectionBody(PLAN_SECTION, 4_000);
    const quoted = /heading:"([^"]+)"/.exec(cut.body)?.[1];
    expect(quoted).toBeTruthy();

    const sections = splitSections(`## Decisions\n${PLAN_SECTION}`);
    const resolved = findSection(sections, quoted!);
    expect(resolved?.level).toBe(3);
    expect(resolved?.heading).toBe("D-020 — the load-bearing ruling");
    expect(resolved?.body).toContain("b".repeat(100));
  });
});
