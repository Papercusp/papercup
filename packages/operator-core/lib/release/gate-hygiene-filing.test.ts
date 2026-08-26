import { describe, it, expect } from "vitest";

import {
  deriveHygieneFilings,
  filingConditionKey,
  type RemedyDirection,
} from "./gate-hygiene-filing.ts";
import {
  assessRepairOutcomes,
  type RepairOutcome,
  type RepairVerdict,
} from "./gate-auto-repair.ts";

/**
 * Build a REAL verdict by running the real assessor, so these tests pin the actual
 * pipeline (outcome -> verdict -> filing) rather than a hand-written verdict string that
 * could drift out of agreement with what the assessor actually emits.
 */
function verdictFor(outcome: Omit<RepairOutcome, "entry">, entry = "gen:x:check") {
  const assessment = assessRepairOutcomes([{ entry, ...outcome }]);
  return assessment.results[0];
}

const REPAIRED = { repairExitCode: 0, verifyExitCode: 0, producedDiff: true };
const REFUSED = { repairExitCode: 1, verifyExitCode: 1, producedDiff: false, refused: true };
const FAILED = { repairExitCode: 1, verifyExitCode: 1, producedDiff: false };
const STILL_FAILING = { repairExitCode: 0, verifyExitCode: 1, producedDiff: true };
const NOT_STALE = { repairExitCode: 0, verifyExitCode: 1, producedDiff: false };

describe("deriveHygieneFilings — what gets filed", () => {
  it("files NOTHING for a clean repair, and says so in `skipped`", () => {
    const plan = deriveHygieneFilings({ assessed: [verdictFor(REPAIRED)] });

    expect(plan.drafts).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0].entry).toBe("gen:x:check");
    // The silence is explained, not merely absent — a caller can prove why nothing filed.
    expect(plan.skipped[0].why).toContain("repaired");
  });

  it("files every verdict that did NOT repair cleanly", () => {
    for (const outcome of [REFUSED, FAILED, STILL_FAILING, NOT_STALE]) {
      const assessed = verdictFor(outcome);
      const plan = deriveHygieneFilings({ assessed: [assessed] });

      expect(
        plan.drafts,
        `verdict ${assessed.verdict} must be filed`,
      ).toHaveLength(1);
      expect(plan.drafts[0].entry).toBe("gen:x:check");
    }
  });

  it("files unrepairable entries, which never reach a repair attempt at all", () => {
    const plan = deriveHygieneFilings({
      unrepairable: [{ entry: "lint:tool-prompts", why: "no paired generator exists" }],
    });

    expect(plan.drafts).toHaveLength(1);
    expect(plan.drafts[0].direction).toBe("needs-human-triage");
    expect(plan.drafts[0].body).toContain("no paired generator exists");
  });
});

describe("deriveHygieneFilings — the opposite-remedy pin", () => {
  /**
   * The load-bearing test. `repair-refused` and `repair-failed` look identical at the
   * exit-code level (both non-zero) but have OPPOSITE remedies: one says fix the
   * generator, the other says the generator is fine and forcing it destroys data. If
   * these two ever collapse into the same direction, the filer starts inviting the
   * exact data loss the `refused` verdict was introduced to prevent (WI-41770).
   */
  it("gives refused and failed DIFFERENT remedy directions", () => {
    const refused = deriveHygieneFilings({ assessed: [verdictFor(REFUSED)] }).drafts[0];
    const failed = deriveHygieneFilings({ assessed: [verdictFor(FAILED)] }).drafts[0];

    expect(refused.direction).toBe("fix-the-data-never-force");
    expect(failed.direction).toBe("fix-the-generator");
    expect(refused.direction).not.toBe(failed.direction);
  });

  it("puts the do-not-force warning in the FIRST line of a refused filing", () => {
    const draft = deriveHygieneFilings({ assessed: [verdictFor(REFUSED)] }).drafts[0];

    // A reader who stops after one line must still stop before forcing the overwrite.
    const firstLine = draft.body.split("\n")[0];
    expect(firstLine).toMatch(/DO NOT force/i);
  });

  it("never tells a reader to force an overwrite on a refusal", () => {
    const draft = deriveHygieneFilings({ assessed: [verdictFor(REFUSED)] }).drafts[0];

    // Assert the PROPERTY (a prohibition is present, no force instruction is), not one
    // exact phrasing — either wording satisfies the safety requirement.
    expect(draft.body).not.toMatch(/--force/);
    expect(draft.body).toMatch(/\b(do not|don't|never) force\b/i);
  });

  it("warns about the refusal ambiguity even on an UNCLASSIFIED failure", () => {
    // FAILED omits `refused`, so the generator MIGHT have been protecting data and
    // nobody classified it. Safety must not depend on the flag having been set.
    const draft = deriveHygieneFilings({ assessed: [verdictFor(FAILED)] }).drafts[0];

    expect(draft.body.toLowerCase()).toContain("refus");
    expect(draft.body.toLowerCase()).toContain("never force the write");
  });
});

describe("deriveHygieneFilings — dedupe identity", () => {
  it("keys the condition on the ENTRY alone, so a shifting verdict refreshes one item", () => {
    const entry = "gen:authored-docs:check";
    const asRefused = deriveHygieneFilings({
      assessed: [verdictFor(REFUSED, entry)],
    }).drafts[0];
    const asFailed = deriveHygieneFilings({
      assessed: [verdictFor(FAILED, entry)],
    }).drafts[0];

    // Same blocker, different failure mode -> SAME filing identity. Keying on the
    // verdict would split one blocker's history across sibling items exactly when the
    // failure mode changed, which is when that history matters most.
    expect(asRefused.conditionKey).toBe(asFailed.conditionKey);
    expect(asRefused.conditionKey).toBe(filingConditionKey(entry));
  });

  it("distinguishes different entries", () => {
    expect(filingConditionKey("gen:a:check")).not.toBe(filingConditionKey("gen:b:check"));
  });

  it("files one draft per entry when an entry is both unrepairable and assessed", () => {
    const entry = "gen:x:check";
    const plan = deriveHygieneFilings({
      unrepairable: [{ entry, why: "no generator" }],
      assessed: [verdictFor(REFUSED, entry)],
    });

    expect(plan.drafts).toHaveLength(1);
  });
});

describe("deriveHygieneFilings — unknown verdicts fail toward filing", () => {
  it("FILES an unrecognized verdict rather than silently dropping it", () => {
    // Simulates an older/hand-built caller: a verdict this build does not know.
    const plan = deriveHygieneFilings({
      assessed: [
        {
          entry: "gen:future:check",
          verdict: "some-new-verdict" as RepairVerdict,
          reason: "from a newer build",
        },
      ],
    });

    expect(plan.drafts).toHaveLength(1);
    expect(plan.drafts[0].direction satisfies RemedyDirection).toBe("needs-human-triage");
    expect(plan.drafts[0].body).toContain("Unrecognized repair verdict");
  });
});

describe("deriveHygieneFilings — empty and mixed input", () => {
  it("reports nothing owed on empty input without inventing a draft", () => {
    const plan = deriveHygieneFilings({});
    expect(plan.drafts).toEqual([]);
    expect(plan.reason).toContain("Nothing to file");
  });

  it("files only the survivors from a mixed pass", () => {
    const plan = deriveHygieneFilings({
      assessed: [
        verdictFor(REPAIRED, "gen:ok:check"),
        verdictFor(REFUSED, "gen:bad:check"),
      ],
    });

    expect(plan.drafts.map((d) => d.entry)).toEqual(["gen:bad:check"]);
    expect(plan.skipped.map((s) => s.entry)).toEqual(["gen:ok:check"]);
    expect(plan.reason).toContain("gen:bad:check");
  });
});
