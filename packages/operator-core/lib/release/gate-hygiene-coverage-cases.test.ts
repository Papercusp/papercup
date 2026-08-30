/**
 * WI-41765 / plan decision D-010 — the guard that makes COVERAGE_CLASS_TEST_CASES safe.
 *
 * The registry lets a failing test FILE promote `main` when every failing case in it is a
 * registered coverage-class case. That trust is only sound while each registered case
 * contains ONLY instrument assertions. If someone later adds a substantive assertion back
 * into one, the registry silently converts a REAL product failure into hygiene — which is
 * exactly the D-008 hazard ("exempt the file and you switch off the pin"), moved down one
 * level from the file to the case.
 *
 * A comment saying "these must never re-merge" does not survive contact with a future
 * editor. This does: it reads the REAL file and fails if a forbidden symbol appears inside
 * an `expect(...)` in the registered case.
 *
 * The FIXTURE CONTROLS below are load-bearing for the reason the doc-claims siblings state:
 * once the live assertion goes green it stops being evidence that the detector works at all.
 * Each control reproduces a shape that MUST be caught — including the exact re-merge this
 * guard exists to prevent.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  COVERAGE_CLASS_TEST_CASES,
  type CoverageClassCase,
} from "./gate-hygiene-split";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The body of one `it('<caseName>', …)`, bounded by the START of the next `it(`/`describe(`
 *  rather than by brace matching — a brace inside a string or comment cannot unbalance a
 *  boundary that is only ever "the next sibling case". Returns null when the name is absent,
 *  which is itself a failure: a renamed case leaves the registry silently matching nothing. */
export function findCaseBody(source: string, caseName: string): string | null {
  const nameIdx = source.indexOf(caseName);
  if (nameIdx === -1) return null;
  const rest = source.slice(nameIdx + caseName.length);
  const next = rest.search(/\n\s*(?:it|describe)\s*\(/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Forbidden symbols appearing inside an `expect(...)` in `body`.
 *  Scans only `expect(` lines on purpose: these cases carry long explanatory comments that
 *  legitimately DISCUSS the substantive pin, and a comment is not an assertion. */
export function forbiddenAssertionsIn(
  body: string,
  forbiddenSymbols: readonly string[],
): string[] {
  const expectLines = body
    .split("\n")
    .filter((line) => line.includes("expect("))
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
  return forbiddenSymbols.filter((symbol) =>
    expectLines.some((line) => line.includes(symbol)),
  );
}

describe("COVERAGE_CLASS_TEST_CASES re-merge guard", () => {
  describe("fixture controls (the detector must be able to FAIL)", () => {
    const forbidden = ["violations", "verdict.ok"];

    it("catches a substantive assertion re-merged into a registered coverage case", () => {
      const body = `', () => {
      const verdict = judgeGateCandidateRef(source);
      expect(verdict.violations).toEqual([]);
      expect(verdict.candidateSites.length).toBeGreaterThanOrEqual(2);
    });`;
      expect(forbiddenAssertionsIn(body, forbidden)).toEqual(["violations"]);
    });

    it("does NOT fire on a forbidden symbol that appears only in a comment", () => {
      const body = `', () => {
      // The sibling case asserts verdict.violations and verdict.ok — that is the pin,
      // and it deliberately lives in its own it() so this one can be hygiene.
      const verdict = judgeGateCandidateRef(source);
      expect(verdict.candidateSites.length).toBeGreaterThanOrEqual(2);
    });`;
      expect(forbiddenAssertionsIn(body, forbidden)).toEqual([]);
    });

    it("stops at the next sibling case, so a neighbour's assertions are not attributed here", () => {
      const source = `
    it('detector coverage: sees both sites', () => {
      expect(verdict.candidateSites.length).toBeGreaterThanOrEqual(2);
    });

    it('cuts from the LOCAL branch', () => {
      expect(verdict.violations).toEqual([]);
    });`;
      const body = findCaseBody(source, "detector coverage: sees both sites");
      expect(body).not.toBeNull();
      expect(forbiddenAssertionsIn(body!, forbidden)).toEqual([]);
    });

    it("reports a renamed/absent case as null rather than silently passing", () => {
      expect(findCaseBody("it('something else', () => {});", "a case that is gone")).toBeNull();
    });
  });

  describe("the live registry", () => {
    it("is non-empty, so the checks below are not vacuous", () => {
      expect(COVERAGE_CLASS_TEST_CASES.length).toBeGreaterThan(0);
    });

    it.each(COVERAGE_CLASS_TEST_CASES.map((c) => [c.caseName, c] as const))(
      "%s — resolves to exactly one real file whose case holds no substantive assertion",
      (_name: string, entry: CoverageClassCase) => {
        // The workspace-relative `file` is what MATCHES at gate time; `repoPath` is what the
        // guard reads. Asserting the suffix relationship is what proves they describe the
        // same file — otherwise the registry could match one file and audit another.
        expect(entry.repoPath.endsWith(entry.file)).toBe(true);

        const abs = resolve(REPO_ROOT, entry.repoPath);
        expect(existsSync(abs)).toBe(true);

        const source = readFileSync(abs, "utf8");
        // Guards against the silent-stale mode: a renamed case would make the registry match
        // nothing at gate time, and no test would ever notice.
        const body = findCaseBody(source, entry.caseName);
        expect(body).not.toBeNull();

        expect(forbiddenAssertionsIn(body!, entry.forbiddenSymbols)).toEqual([]);
      },
    );

    it("declares forbidden symbols for every entry — an empty list would guard nothing", () => {
      for (const entry of COVERAGE_CLASS_TEST_CASES) {
        expect(entry.forbiddenSymbols.length).toBeGreaterThan(0);
        expect(entry.why.length).toBeGreaterThan(40);
      }
    });
  });
});
