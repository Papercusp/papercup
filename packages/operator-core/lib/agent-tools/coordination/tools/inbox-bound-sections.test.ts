/**
 * coord:inbox — EI-19423034419710126: `max_body_chars` bounds `sections[].text`,
 * not just `body`.
 *
 * WHY THIS EXISTS. `max_body_chars` is the documented lever for "read many entries
 * cheaply". It bounded `summary`/`body` only, while `sections[].text` — which
 * carries the SAME prose, and which coord:send effectively MANDATES by refusing a
 * plain-string `body` — passed through whole. So the arg was approximately a no-op
 * on exactly the messages that make a read expensive. Measured in the field: a
 * `max_body_chars: 1` read returned 1-char bodies beside ~3.8KB of untouched
 * sections and overran a ~1500-token result door by 35x.
 *
 * FALSIFIABILITY (repo rule: a guard that has never failed is a guard you have not
 * tested). `boundInboxEntries` is a module we import, so this file uses the tier-1
 * control: `legacyBoundEntries` below is a deliberately-wrong implementation
 * reproducing the PRE-FIX behaviour, kept permanently. `describe('control')`
 * asserts the pins genuinely FAIL against it — so if a future refactor silently
 * stops bounding sections, these tests cannot all keep passing. The shared
 * `expectSectionsBounded` helper is what both the real subject and the control are
 * measured with, so the control cannot drift away from the assertion it calibrates.
 * No production file is mutated and nothing is written to the shared tree.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/coordination/tools/inbox-bound-sections.test.ts
 */
import { describe, expect, it } from "vitest";

import { boundInboxEntries } from "./inbox";

/** The PRE-FIX implementation, verbatim in behaviour: bounds `summary`/`body`
 *  and passes every other field — including `sections` — through untouched.
 *  Kept permanently as the control this file's pins are calibrated against. */
function legacyBoundEntries<T extends Record<string, unknown>>(
  entries: readonly T[],
  maxChars: number,
): Array<Record<string, unknown>> {
  if (!(maxChars > 0))
    return entries as unknown as Array<Record<string, unknown>>;
  return entries.map((e) => {
    let out: Record<string, unknown> = e;
    for (const field of ["summary", "body"] as const) {
      const v = e[field];
      if (typeof v === "string" && v.length > maxChars) {
        out = {
          ...out,
          [field]: v.slice(0, maxChars),
          [`${field}_truncated`]: true,
          [`${field}_full_chars`]: v.length,
        };
      }
    }
    return out;
  });
}

type Bounder = typeof boundInboxEntries;

const sectionsOf = (row: Record<string, unknown>): Array<Record<string, unknown>> =>
  (row["sections"] ?? []) as Array<Record<string, unknown>>;

const totalSectionChars = (row: Record<string, unknown>): number =>
  sectionsOf(row).reduce(
    (n, s) => n + (typeof s?.["text"] === "string" ? (s["text"] as string).length : 0),
    0,
  );

/** The property under test, factored so the real subject and the control are
 *  judged by the SAME assertion. */
function expectSectionsBounded(fn: Bounder, maxChars: number) {
  const entry = {
    msg_id: "m1",
    body: "B".repeat(4000),
    sections: [
      { text: "a".repeat(1000) },
      { text: "b".repeat(1000) },
      { text: "c".repeat(1000) },
      { text: "d".repeat(1000) },
    ],
  };
  const [row] = fn([entry], maxChars);
  expect(totalSectionChars(row!)).toBeLessThanOrEqual(maxChars);
}

describe("boundInboxEntries — sections[].text (EI-19423034419710126)", () => {
  it("bounds the COMBINED text across sections to one shared budget", () => {
    expectSectionsBounded(boundInboxEntries, 100);
  });

  it("reproduces the reported repro: max_body_chars:1 leaves ~1 char, not ~3.8KB", () => {
    const entry = {
      body: "R".repeat(4000),
      sections: [
        { text: "x".repeat(950) },
        { text: "y".repeat(950) },
        { text: "z".repeat(950) },
        { text: "w".repeat(950) },
      ],
    };
    const [row] = boundInboxEntries([entry], 1);
    expect(row!["body"]).toBe("R");
    expect(totalSectionChars(row!)).toBe(1);
    expect(row!["sections_truncated"]).toBe(true);
    expect(row!["sections_full_chars"]).toBe(3800);
  });

  it("spends the budget from the actionable tail: later sections keep text first", () => {
    const entry = {
      sections: [{ text: "aaaaa" }, { text: "bbbbb" }, { text: "ccccc" }],
    };
    const [row] = boundInboxEntries([entry], 7);
    const texts = sectionsOf(row!).map((s) => s["text"]);
    expect(texts).toEqual(["", "bb", "ccccc"]);
    expect(totalSectionChars(row!)).toBe(7);
  });

  it("preserves a final actionable section when earlier context fills the cap", () => {
    const actionText = "Please take the next step.";
    const actionFields = { relation: "owns", ref: "EI-21616634841649510" };
    const [row] = boundInboxEntries(
      [
        {
          msg_id: "m-action-tail",
          body: `${"context ".repeat(40)}\n\n${actionText}`,
          sections: [
            { text: "context ".repeat(40) },
            { text: actionText, forYouBecause: actionFields },
          ],
        },
      ],
      actionText.length,
    );
    const sections = sectionsOf(row!);

    expect(row!["body"]).toBe(actionText);
    expect(sections[0]!["text"]).toBe("");
    expect(sections[1]!["text"]).toBe(actionText);
    expect(sections[1]!["forYouBecause"]).toEqual(actionFields);
    expect(totalSectionChars(row!)).toBeLessThanOrEqual(actionText.length);
  });

  it("PRESERVES structural keys so authoredFieldsMarker still sees them", () => {
    // This is the regression guard for the cheaper fix (dropping `sections`
    // outright), which would silently cost the `authored` marker derived after
    // bounding.
    const entry = {
      sections: [
        {
          text: "q".repeat(5000),
          premises: ["plan#D-001"],
          forYouBecause: { relation: "owns" },
          youMayNotKnow: [{ text: "n" }],
          couldNotDetermine: [{ text: "u" }],
          clarify: [{ text: "c" }],
        },
      ],
    };
    const [row] = boundInboxEntries([entry], 10);
    const s = sectionsOf(row!)[0]!;
    expect(s["text"]).toHaveLength(10);
    expect(s["premises"]).toEqual(["plan#D-001"]);
    expect(s["forYouBecause"]).toEqual({ relation: "owns" });
    expect(s["youMayNotKnow"]).toEqual([{ text: "n" }]);
    expect(s["couldNotDetermine"]).toEqual([{ text: "u" }]);
    expect(s["clarify"]).toEqual([{ text: "c" }]);
  });

  it("leaves sections untouched when already within budget (no churn, no markers)", () => {
    const sections = [{ text: "short" }, { text: "also short" }];
    const entry = { sections };
    const [row] = boundInboxEntries([entry], 1000);
    expect(row!["sections"]).toBe(sections); // same reference — untouched
    expect(row!["sections_truncated"]).toBeUndefined();
    expect(row!["sections_full_chars"]).toBeUndefined();
  });

  it("does not truncate anything when maxChars <= 0", () => {
    const entry = { body: "B".repeat(100), sections: [{ text: "t".repeat(100) }] };
    const [row] = boundInboxEntries([entry], 0);
    expect(row).toBe(entry);
    expect(totalSectionChars(row!)).toBe(100);
  });

  it("tolerates malformed sections without throwing or dropping them", () => {
    const entry = {
      sections: [
        null,
        "not-an-object",
        { noText: true },
        { text: 42 },
        { text: "k".repeat(500) },
      ],
    };
    const [row] = boundInboxEntries([entry as Record<string, unknown>], 10);
    const out = sectionsOf(row!);
    expect(out).toHaveLength(5);
    expect(out[0]).toBeNull();
    expect(out[1]).toBe("not-an-object");
    expect(out[3]!["text"]).toBe(42); // non-string text left alone
    expect(out[4]!["text"]).toBe("k".repeat(10));
  });

  it("ignores a non-array `sections` field", () => {
    const entry = { sections: { text: "not an array" } };
    const [row] = boundInboxEntries([entry], 1);
    expect(row!["sections"]).toEqual({ text: "not an array" });
    expect(row!["sections_truncated"]).toBeUndefined();
  });

  it("still bounds summary and body as before (no regression)", () => {
    const entry = { summary: "S".repeat(50), body: "B".repeat(50) };
    const [row] = boundInboxEntries([entry], 10);
    expect(row!["summary"]).toBe("S".repeat(10));
    expect(row!["body"]).toBe("B".repeat(10));
    expect(row!["summary_truncated"]).toBe(true);
    expect(row!["body_full_chars"]).toBe(50);
  });

  it("puts a coord:read pointer inside clipped message text", () => {
    const [row] = boundInboxEntries(
      [{ msg_id: "m-long", body: "x".repeat(900) }],
      600,
    );

    expect(row!["body"]).toHaveLength(600);
    expect(row!["body"]).toContain('coord:read { msg_id: "m-long" }');
    expect(row!["body_truncated"]).toBe(true);
    expect(row!["body_full_chars"]).toBe(900);
  });

  it("puts the same pointer on the clipped section text", () => {
    const [row] = boundInboxEntries(
      [{ msg_id: "m-sections", sections: [{ text: "x".repeat(700) }, { text: "tail" }] }],
      600,
    );
    const sections = sectionsOf(row!);

    // The preserved tail section consumes four characters of the shared
    // budget, so the clipped earlier section carries the remaining 596.
    expect(sections[0]!["text"]).toHaveLength(596);
    expect(sections[0]!["text"]).toContain('coord:read { msg_id: "m-sections" }');
    expect(sections[1]!["text"]).toBe("tail");
    expect(row!["sections_truncated"]).toBe(true);
    expect(row!["sections_full_chars"]).toBe(704);
  });
});

describe("control — the pre-fix implementation must FAIL these pins", () => {
  it("calibration: the real subject passes the bound", () => {
    expect(() => expectSectionsBounded(boundInboxEntries, 100)).not.toThrow();
  });

  it("the legacy bounder leaves sections whole, so the bound is violated", () => {
    // If this ever stops throwing, the pin above has gone vacuous.
    expect(() => expectSectionsBounded(legacyBoundEntries, 100)).toThrow();
  });

  it("the legacy bounder still bounds body — so the control is wrong only about sections", () => {
    const entry = { body: "B".repeat(4000), sections: [{ text: "a".repeat(4000) }] };
    const [row] = legacyBoundEntries([entry], 10);
    expect(row!["body"]).toBe("B".repeat(10)); // same as the real subject
    expect(totalSectionChars(row!)).toBe(4000); // and this is the defect
  });
});
