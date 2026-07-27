// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { LEARNING_STAGES, orphanedLearningViews } from "./LearningTab";

/**
 * WI-6383 guard: every Learning view must be reachable by clicking.
 *
 * ## The defect this class produced
 *
 * `?lview=` accepts one list of views (`LVIEWS`, which the render dispatch also
 * switches on) and the stage/subtab nav offers another (`STAGES`). Nothing made
 * the two agree. Throughput was removed from the nav on 2026-07-12 — collateral
 * damage from deleting a header utility row — and stayed removed for 15 days
 * while remaining fully implemented: still in `LVIEWS`, still in
 * `HIVE_AWARE_VIEWS`, still dispatched, still served by a live resolver. It was
 * openable only by hand-typing the URL.
 *
 * Nothing could have caught it. No type breaks (the two lists are independent),
 * no test failed (every Throughput test drove the component directly), and the
 * code is not dead so `knip` sees nothing. The only observable symptom was a
 * missing tab, which is exactly what nobody notices.
 *
 * ## Why this shape
 *
 * Restoring the one tab fixes today. The detector fixes the class: it compares
 * the two lists mechanically, so the NEXT view dropped from the nav fails here
 * instead of quietly going dark for a fortnight.
 *
 * It is a structural check rather than a render probe, and that is deliberate
 * rather than a shortcut. Reachability here is decided entirely by catalog
 * DATA — `orphanedLearningViews` reads the same `STAGES` the nav maps over, so
 * there is no runtime behaviour able to disagree with it. (Contrast D-005's
 * lens guard, which had to be a render probe precisely because the source
 * looked correct and the runtime behaviour was not.) The render layer is
 * separately pinned in LearningTab.test.tsx, which asserts the Throughput tab
 * is actually on screen inside the Verify row — the layer the user sees.
 */
describe("Learning view reachability (WI-6383)", () => {
  it("leaves no view reachable only by hand-typing ?lview=", () => {
    expect(orphanedLearningViews()).toEqual([]);
  });

  it("reds on the REAL pre-fix catalog, not merely on a synthetic one", () => {
    // The exact catalog that shipped between 2026-07-12 and this fix: today's
    // catalog with the one restored entry taken back out. Reconstructed in
    // memory on purpose — this tree is shared and git-sync commits it WHOLE, so
    // "break the file and watch it red" risks committing the broken state.
    const preFix = LEARNING_STAGES.map((stage) => ({
      ...stage,
      views: stage.views.filter((candidate) => candidate.id !== "throughput"),
    }));
    expect(orphanedLearningViews(preFix)).toEqual(["throughput"]);
  });

  it("is not blind: it can see a view the nav never offered at all", () => {
    // A view that exists in LVIEWS but was never added to any stage — the same
    // defect arriving the other way round (added to the route, forgotten in the
    // nav). Proves the detector reads `views`, not just the catalog.
    expect(orphanedLearningViews(LEARNING_STAGES, ["learnings", "throughput"])).toEqual(
      [],
    );
    expect(
      orphanedLearningViews(
        LEARNING_STAGES.map((stage) => ({ ...stage, views: [] })),
        ["learnings", "throughput"],
      ),
    ).toEqual(["learnings", "throughput"]);
  });

  it("observes a non-trivial catalog (a green here is not a green over nothing)", () => {
    const offered = LEARNING_STAGES.flatMap((stage) =>
      stage.views.map((candidate) => candidate.id),
    );
    // A detector fed an empty catalog would report every view as orphaned, so
    // the first test cannot pass vacuously — but an empty VIEWS list would make
    // it pass over nothing at all. Pin both ends: real stages, real views.
    expect(LEARNING_STAGES.length).toBeGreaterThanOrEqual(5);
    expect(offered.length).toBeGreaterThanOrEqual(15);
    expect(offered).toContain("throughput");
  });

  it("lists each view under exactly one stage", () => {
    // A view claimed by two stages makes `stageForView` order-dependent: the
    // stage nav would highlight one stage while the subtab row rendered the
    // other's views, and which one you got would depend on array order.
    const offered = LEARNING_STAGES.flatMap((stage) =>
      stage.views.map((candidate) => candidate.id),
    );
    expect(offered).toHaveLength(new Set(offered).size);
  });
});
