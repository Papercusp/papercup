/**
 * The Verify strip's rubric chip (EI-21949865560276745). Every guard below is paired
 * with the case that must NOT trip it — the failure being fixed was silent, so a test
 * that only ever inspects the alarming input cannot tell a working marker from one
 * that fires unconditionally.
 */
import { describe, expect, it } from "vitest";

import { readinessRubricChipText } from "./learning-readiness-chip";

type Rubric = Parameters<typeof readinessRubricChipText>[0];

const rubric = (over: Partial<NonNullable<Rubric>> = {}): Rubric =>
  ({
    rubricId: "blender-release-readiness",
    title: "Blender release readiness",
    status: "active",
    criteriaCount: 3,
    proposedBy: "su-a",
    ratifiedBy: "su-b",
    updatedAt: "2026-07-13T00:00:00.000Z",
    scorecardCount: 4,
    latestScorecardAt: "2026-07-14T00:00:00.000Z",
    latestScore10: 9,
    scoreEvidence: {
      sampleCount: 4,
      excluded: { provisional: 0, gradingAuditPending: 0 },
      windowStart: "2026-07-10T00:00:00.000Z",
      windowEnd: "2026-07-14T00:00:00.000Z",
      latestAgeMs: 1_000,
      latestGenerationFreshness: "fresh",
      countTruncated: false,
    },
    ...over,
  }) as Rubric;

describe("readinessRubricChipText", () => {
  it("names the population as SETTLED, not as raw scorecards", () => {
    expect(readinessRubricChipText(rubric())).toBe(
      "rubric: active · 4 settled · latest 9/10",
    );
  });

  it("no rubric at all is distinct from a rubric with no grades", () => {
    expect(readinessRubricChipText(null)).toBe("rubric: none proposed");
  });

  describe("a count over a capped page is marked a floor", () => {
    it("marks it when the page was truncated", () => {
      const ev = { ...rubric()!.scoreEvidence!, countTruncated: true };
      expect(readinessRubricChipText(rubric({ scoreEvidence: ev }))).toContain(
        "4 settled+",
      );
    });

    it("CONTROL: does not mark a short page", () => {
      expect(readinessRubricChipText(rubric())).toContain("4 settled ");
      expect(readinessRubricChipText(rubric())).not.toContain("+");
    });
  });

  describe("a grade whose generation has ended is called out", () => {
    it("flags a stale generation", () => {
      const ev = {
        ...rubric()!.scoreEvidence!,
        latestGenerationFreshness: "stale" as const,
      };
      expect(readinessRubricChipText(rubric({ scoreEvidence: ev }))).toBe(
        "rubric: active · 4 settled · latest 9/10 · gen ended",
      );
    });

    it("CONTROL: a fresh generation is silent — the marker discriminates", () => {
      expect(readinessRubricChipText(rubric())).not.toContain("gen ended");
    });

    it("an UNRECORDED generation is silent too — absence is not a warning, and not a clean bill", () => {
      const ev = {
        ...rubric()!.scoreEvidence!,
        latestGenerationFreshness: null,
      };
      const text = readinessRubricChipText(rubric({ scoreEvidence: ev }));
      expect(text).not.toContain("gen ended");
      expect(text).toBe("rubric: active · 4 settled · latest 9/10");
    });
  });

  describe("nothing settled", () => {
    /**
     * The state the old chip could not express at all: cards ARE arriving, so it looked
     * like a graded gate, but none of them count as evidence yet.
     */
    it("says so, and how many are held back", () => {
      const ev = {
        ...rubric()!.scoreEvidence!,
        sampleCount: 0,
        excluded: { provisional: 2, gradingAuditPending: 1 },
      };
      expect(
        readinessRubricChipText(
          rubric({ scorecardCount: 0, latestScore10: null, scoreEvidence: ev }),
        ),
      ).toBe("rubric: active · no settled grade (3 unsettled)");
    });

    it("CONTROL: a genuinely ungraded rubric still reads as ungraded, not as held back", () => {
      const ev = {
        ...rubric()!.scoreEvidence!,
        sampleCount: 0,
        excluded: { provisional: 0, gradingAuditPending: 0 },
      };
      expect(
        readinessRubricChipText(
          rubric({ scorecardCount: 0, latestScore10: null, scoreEvidence: ev }),
        ),
      ).toBe("rubric: active · no scorecards yet");
    });

    it("survives a failed scorecard read (scoreEvidence null) without inventing a count", () => {
      expect(
        readinessRubricChipText(
          rubric({ scorecardCount: 0, latestScore10: null, scoreEvidence: null }),
        ),
      ).toBe("rubric: active · no scorecards yet");
    });
  });

  it("a settled count with no mapping score omits the score rather than showing 0", () => {
    expect(readinessRubricChipText(rubric({ latestScore10: null }))).toBe(
      "rubric: active · 4 settled",
    );
  });
});
