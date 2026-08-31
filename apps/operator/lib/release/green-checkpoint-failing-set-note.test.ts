import { describe, expect, it } from "vitest";

import {
  buildAlreadyFixedNote,
  buildFailingSetNote,
  buildLineageResidueNote,
} from "./green-checkpoint";

/**
 * EI-19381970048172232 — a green-checkpoint verdict never enumerated its FAILING
 * files; the two file-lists it did print answered a NEIGHBOURING question
 * ("which failing entries were modified since the candidate?") and both read
 * exactly like the failing set.
 *
 * The fix IS the wording, so the wording is what these tests pin. The specific
 * regression to guard is a future edit that "tidies" the fallback's `FAILING
 * SIGNATURE (≥N)` into `FAILING FILES (N)`, or drops the SUBSET qualifier from
 * the modified-since list — either one silently restores the original defect
 * while every other test still passes.
 */
describe("buildFailingSetNote", () => {
  it("enumerates file-granular failures as a census, with per-file case counts", () => {
    const note = buildFailingSetNote({
      failingFiles: [
        { workspace: "@papercusp/operator-core", file: "lib/a.test.ts" },
        { workspace: "@papercusp/web", file: "lib/b.test.ts" },
      ],
      failingCasesByFile: new Map([
        ["lib/a.test.ts", ["case one", "case two"]],
        ["lib/b.test.ts", ["only one"]],
      ]),
    });

    expect(note).toContain("FAILING FILES (2):");
    expect(note).toContain("@papercusp/operator-core :: lib/a.test.ts (2 failing cases)");
    // Singular, not "1 failing cases".
    expect(note).toContain("@papercusp/web :: lib/b.test.ts (1 failing case)");
  });

  it("omits the case count for a file with no recorded cases", () => {
    const note = buildFailingSetNote({
      failingFiles: [{ workspace: "@papercusp/web", file: "lib/b.test.ts" }],
    });

    expect(note).toContain("@papercusp/web :: lib/b.test.ts");
    expect(note).not.toContain("failing case");
  });

  it("renders the fallback as a `≥` FLOOR and never as a file census", () => {
    const note = buildFailingSetNote({
      failingFiles: [],
      failingTests: ["@papercusp/web :: test", "@papercusp/operator-core :: test"],
    });

    expect(note).toContain("FAILING SIGNATURE (≥2)");
    expect(note).toContain("a FLOOR and NOT a file census");
    // THE load-bearing assertion: the floor must never borrow the census's
    // label, or it becomes a third precisely-worded list that reads as the
    // complete failing set — the defect this item exists to fix.
    expect(note).not.toContain("FAILING FILES");
  });

  it("prefers the file census over the signature when both are present", () => {
    const note = buildFailingSetNote({
      failingFiles: [{ workspace: "@papercusp/web", file: "lib/b.test.ts" }],
      failingTests: ["@papercusp/web :: test"],
    });

    expect(note).toContain("FAILING FILES (1):");
    expect(note).not.toContain("FAILING SIGNATURE");
  });

  it("returns empty when there is nothing to enumerate (a gate-only red)", () => {
    expect(buildFailingSetNote({})).toBe("");
    expect(buildFailingSetNote({ failingFiles: [], failingTests: [] })).toBe("");
  });

  it("fails soft — a formatting fault never blocks or swallows the verdict", () => {
    const exploding = {
      get: () => {
        throw new Error("boom");
      },
    } as unknown as ReadonlyMap<string, readonly string[]>;

    expect(
      buildFailingSetNote({
        failingFiles: [{ workspace: "@papercusp/web", file: "lib/b.test.ts" }],
        failingCasesByFile: exploding,
      }),
    ).toBe("");
  });
});

/**
 * Falsifiability controls. A guard that has never failed is a guard nobody has
 * tested, and the assertions above are all `not.toContain` — the shape that
 * passes just as happily when the subject returns `""`, or when the predicate
 * is misspelled and can never match anything.
 *
 * These are permanent in-test controls (the prescribed proof for an imported
 * module — production code is never mutated). Each reimplements the exact
 * mistake the fix removed and asserts the guard CATCHES it; the calibration
 * case asserts the real subject still passes, so the controls cannot go green
 * by the property itself becoming untestable.
 */
describe("buildFailingSetNote — falsifiability controls", () => {
  /** The pre-fix mistake: label the heterogeneous floor as a file census. */
  const mislabelledFloor = (failingTests: readonly string[]): string =>
    `\n\nFAILING FILES (${failingTests.length}): ${failingTests.join(", ")}`;

  it("CONTROL: the label guard rejects a floor mislabelled as a census", () => {
    const bad = mislabelledFloor([
      "@papercusp/web :: test",
      "@papercusp/operator-core :: test",
    ]);

    // The real subject passes this exact predicate (see the fallback test); a
    // regression to the old wording must fail it. If this expectation ever
    // stops holding, the guard above has stopped guarding.
    expect(bad).toContain("FAILING FILES");
    expect(() => expect(bad).not.toContain("FAILING FILES")).toThrow();
  });

  it("CALIBRATION: the real subject passes the predicate the control fails", () => {
    const real = buildFailingSetNote({
      failingTests: ["@papercusp/web :: test", "@papercusp/operator-core :: test"],
    });

    expect(real).not.toContain("FAILING FILES");
    expect(real).toContain("FAILING SIGNATURE (≥2)");
    // Non-empty, so the `not.toContain` above is a real pass and not the
    // vacuous one an empty string would give.
    expect(real.length).toBeGreaterThan(0);
  });
});

describe("buildLineageResidueNote — falsifiability control", () => {
  /**
   * The pre-fix mistake, reproduced exactly: `notStale === 1 ? "first" : "first"`.
   *
   * Both branches were identical, so this is DEAD CODE rather than a grammar
   * bug — its output ("investigate those first") reads fine at every count.
   * That is precisely what makes it worth a control: the defect is invisible in
   * the rendered string, so only a test that pins the singular form can tell
   * the fixed subject from the no-op it replaced.
   */
  const noOpTernary = (notStale: number): string =>
    `${notStale} NOT modified since — investigate those ${notStale === 1 ? "first" : "first"}.`;

  it("CONTROL: the singular guard rejects the no-op ternary this replaced", () => {
    const bad = noOpTernary(1);

    // The no-op renders the plural form at n=1 — indistinguishable from n=3.
    expect(bad).toContain("investigate those first");
    expect(bad).toBe(noOpTernary(3).replace("3 NOT", "1 NOT"));
    expect(() => expect(bad).toContain("investigate that one first")).toThrow();
  });

  it("CALIBRATION: the real subject renders the singular form", () => {
    const real = buildLineageResidueNote({ signatureCount: 4, staleCount: 3 });

    expect(real).toContain("investigate that one first");
    expect(real).not.toContain("investigate those 1");
  });
});

describe("buildAlreadyFixedNote", () => {
  it("names itself a SUBSET of the failing set, not the failing set", () => {
    const note = buildAlreadyFixedNote({
      candidate: "f47d712cdeadbeef",
      changedInRange: ["lib/a.test.ts", "lib/b.test.ts"],
    });

    expect(note).toContain("OF THE FAILING SET ABOVE");
    expect(note).toContain("a SUBSET");
    expect(note).toContain("NOT the failing set");
    // Abbreviated candidate, matching every other line in the tail.
    expect(note).toContain("f47d712c");
    expect(note).not.toContain("f47d712cdeadbeef");
  });

  it("returns empty when nothing was modified in range", () => {
    expect(
      buildAlreadyFixedNote({ candidate: "f47d712c", changedInRange: [] }),
    ).toBe("");
  });
});

describe("buildLineageResidueNote", () => {
  it("states the residue — the count a reader actually wants", () => {
    const note = buildLineageResidueNote({ signatureCount: 5, staleCount: 3 });

    expect(note).toContain("5 failing, 3 modified-since (presumptively stale)");
    expect(note).toContain("2 NOT modified since");
    expect(note).toContain("investigate those first");
  });

  it("uses singular phrasing for a residue of one", () => {
    const note = buildLineageResidueNote({ signatureCount: 4, staleCount: 3 });

    expect(note).toContain("1 NOT modified since");
    // Guards the no-op ternary this replaced, whose branches were identical and
    // rendered "investigate those 1 first".
    expect(note).toContain("investigate that one first");
    expect(note).not.toContain("investigate those 1");
  });

  it("says the whole red may be stale when the residue is zero", () => {
    const note = buildLineageResidueNote({ signatureCount: 3, staleCount: 3 });

    expect(note).toContain("0 NOT modified since");
    expect(note).toContain("the whole red may be stale");
  });

  it("never reports a negative residue if the counts disagree", () => {
    // Defensive: the two counts come from one universe by construction, but a
    // future caller crossing universes must not produce "-2 NOT modified".
    const note = buildLineageResidueNote({ signatureCount: 1, staleCount: 3 });

    expect(note).not.toContain("-2");
    expect(note).toContain("0 NOT modified since");
  });

  it("returns empty when either count is zero (no lineage to report)", () => {
    expect(buildLineageResidueNote({ signatureCount: 0, staleCount: 3 })).toBe("");
    expect(buildLineageResidueNote({ signatureCount: 3, staleCount: 0 })).toBe("");
  });
});
