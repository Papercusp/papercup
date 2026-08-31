/**
 * P-005 / P-006 / D-005 — the shared report-host gate.
 *
 * Two defects are pinned here:
 *
 *   1. R3 — both hosts gated on `phase === "review"`, so a run that
 *      auto-applied everything (`complete`) and a run that died (`failed`)
 *      rendered NOTHING. The auto-apply run is the one that changed the
 *      owner's work without asking, so it is the one that most needs a report.
 *
 *   2. D-005 — R3 read literally would also admit `pending`/`running` on
 *      foreground alone, and the run param IS the progress strip's deep link.
 *      That would slam a full-pane takeover over Plans/Inbox the moment any
 *      run started. A live run therefore needs the EXPLICIT owner marker.
 */
import { describe, expect, it } from "vitest";
import {
  REVIEW_RUN_PHASES,
  reviewReportPresentation,
  reviewReportReadOnly,
  type ReviewReportGateInput,
  type ReviewReportPresentation,
  type ReviewRunPhase,
} from "./ReviewReportHost";

const gate = (
  overrides: Partial<ReviewReportGateInput> = {},
): ReviewReportGateInput => ({
  enabled: true,
  foreground: true,
  explicitOwner: true,
  hasValue: true,
  phase: "review",
  ...overrides,
});

describe("reviewReportPresentation", () => {
  it("opens a settled run on foreground alone — no owner marker needed", () => {
    // This is the pre-existing `review` behaviour, preserved exactly: a strip
    // deep link to a settled run has always opened its report.
    for (const phase of ["review", "complete", "failed"] as const) {
      expect(
        reviewReportPresentation(gate({ phase, explicitOwner: false })),
      ).not.toBeNull();
    }
  });

  /**
   * The acceptance drill for "every run phase is inspectable", written the way
   * the criterion demands: the phases come from the type's OWN members
   * (REVIEW_RUN_PHASES), never a literal list copied into the test.
   *
   * The expectation table is a Record keyed by the phase union, so a phase
   * added to REVIEW_RUN_PHASES without an entry here fails to COMPILE. That is
   * the "by construction" part — an unhandled phase cannot reach review by
   * someone forgetting to extend a fixture, which is exactly what the previous
   * literal `cases` array allowed.
   */
  const EXPECTED_PRESENTATION: Record<
    ReviewRunPhase,
    { foreground: ReviewReportPresentation | null; backgrounded: null }
  > = {
    review: { foreground: "review", backgrounded: null },
    complete: { foreground: "settled", backgrounded: null },
    failed: { foreground: "failed", backgrounded: null },
    // D-005: a live run is the strip's until the owner explicitly opens it.
    pending: { foreground: "live", backgrounded: null },
    running: { foreground: "live", backgrounded: null },
  };

  it("maps EVERY declared phase to a presentation, across foreground x explicitOwner", () => {
    // Guards the guard: if the union ever empties or the import degrades to a
    // non-iterable, the loops below would vacuously pass.
    expect(REVIEW_RUN_PHASES.length).toBeGreaterThan(0);

    for (const phase of REVIEW_RUN_PHASES) {
      const expected = EXPECTED_PRESENTATION[phase];

      // Backgrounded never mounts, whoever asked.
      for (const explicitOwner of [true, false]) {
        expect(
          reviewReportPresentation(
            gate({ phase, foreground: false, explicitOwner }),
          ),
        ).toBe(expected.backgrounded);
      }

      // Foregrounded + explicitly opened by the owner always mounts, and every
      // phase resolves to a real presentation family — no phase renders
      // nothing, which is the whole point of the criterion.
      const opened = reviewReportPresentation(
        gate({ phase, foreground: true, explicitOwner: true }),
      );
      expect(opened).toBe(expected.foreground);
      expect(opened).not.toBeNull();

      // read-only is a property of the presentation, so it is asserted here
      // rather than trusted: only a live run is read-only.
      expect(reviewReportReadOnly(opened)).toBe(opened === "live");
    }
  });

  it("R3: `complete` and `failed` mount — the two phases that rendered nothing", () => {
    expect(reviewReportPresentation(gate({ phase: "complete" }))).toBe(
      "settled",
    );
    expect(reviewReportPresentation(gate({ phase: "failed" }))).toBe("failed");
  });

  it("D-005: a LIVE run stays in the strip without the explicit owner marker", () => {
    for (const phase of ["pending", "running"] as const) {
      expect(
        reviewReportPresentation(gate({ phase, explicitOwner: false })),
      ).toBeNull();
      // …and opens once the owner actually asked for it.
      expect(
        reviewReportPresentation(gate({ phase, explicitOwner: true })),
      ).toBe("live");
    }
  });

  it("mounts nothing when the feature is off, backgrounded, or unset", () => {
    expect(reviewReportPresentation(gate({ enabled: false }))).toBeNull();
    expect(reviewReportPresentation(gate({ foreground: false }))).toBeNull();
    expect(reviewReportPresentation(gate({ hasValue: false }))).toBeNull();
  });

  it("mounts nothing for an unknown or absent phase rather than guessing", () => {
    expect(reviewReportPresentation(gate({ phase: null }))).toBeNull();
    expect(reviewReportPresentation(gate({ phase: undefined }))).toBeNull();
    expect(
      reviewReportPresentation(
        gate({ phase: "archived" as unknown as ReviewRunPhase }),
      ),
    ).toBeNull();
  });
});

describe("reviewReportReadOnly", () => {
  it("withholds batch apply ONLY while the run is still writing rows", () => {
    expect(reviewReportReadOnly("live")).toBe(true);
    expect(reviewReportReadOnly("review")).toBe(false);
    // A `failed` run's recommended rows are still applicable, and a `complete`
    // run naturally offers nothing because every row is already terminal —
    // neither needs a read-only special case, and asserting that is the point.
    expect(reviewReportReadOnly("settled")).toBe(false);
    expect(reviewReportReadOnly("failed")).toBe(false);
    expect(reviewReportReadOnly(null)).toBe(false);
  });
});
