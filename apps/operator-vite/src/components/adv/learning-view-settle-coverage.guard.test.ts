// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LEARNING_VIEWS } from "./LearningTab";

/**
 * WI-7263 guard: a Learning view must not be added without a perf settle point.
 *
 * ## The defect this class produces
 *
 * `LearningTab` calls `beginInteraction(learningViewSwitch)` on EVERY view
 * change, but only some views end it. `endInteraction` deliberately no-ops when
 * no matching start mark exists, and `beginInteraction` REPLACES an unconsumed
 * start — so a view with no settle point emits no measure at all, leaks nothing,
 * and reports no error. The instrument simply says nothing about it.
 *
 * That is the worst possible failure mode for a perf guard, because **silence
 * reads as speed**. "The Learning tab is fast" was unfalsifiable for 12 of 16
 * views: not slow, not fast, unmeasured — and indistinguishable from healthy on
 * every dashboard that consumes the measure.
 *
 * ## Why this shape, and NOT a plain assertion
 *
 * This is the same CLASS as the WI-6383 reachability defect (see
 * learning-view-reachability.guard.test.ts): two parallel lists over one
 * population — `LVIEWS` and the set of views that end the interaction — with
 * nothing forcing them to agree. No type breaks, no test fails, and the code is
 * live so `knip` sees nothing.
 *
 * The obvious guard ("every view has a settle point") FAILED at filing time,
 * listing 12 views. Landing a red test to prove a point would have red the
 * shared gate for the whole fleet, so this shipped as a **ratchet** first: pin
 * the CURRENT gap, fail the moment it changes in either direction, retire the
 * 12 known-unmeasured views incrementally. That incremental work is now DONE
 * (2026-08-03, same day) — all 12 gained a settle point, so the baseline below
 * has been tightened to zero. The ratchet stays: it now guards against a NEW
 * view landing without a settle point, or an existing one silently losing its.
 *
 * Note the original two covered LearningTab views were the two heaviest reads
 * on the tab (learning.improvements 320,607B + learning.hive 230,147B, ~71% of
 * its ~778KB) — the initial coverage was the high-value end and the remaining
 * 12 were the long tail, which is why "12 of 16" alone overstated the gap at
 * filing time. All surviving views are covered now.
 *
 * ## Why a source scan rather than a render probe
 *
 * Coverage here is decided by whether a component CALLS `useInteractionSettle`
 * with this interaction — a fact about the source, not about catalog data (so
 * the reachability guard's pure-data comparison is unavailable) and not about
 * runtime behaviour that could disagree (the call either exists or it does not).
 * A declared `VIEWS_WITH_SETTLE_POINT` set would be the wrong answer: it is a
 * third parallel list, free to lie, and would recreate this very defect one
 * level up. Scanning derives the count from the code that actually runs.
 *
 * The per-settle-point TIMING contract — settling on a fault, gating on the
 * primary read only, and gating on `active` for warm revisits — is pinned
 * separately in AnalyzePanel.perf-settle.test.tsx and .perf-cached-revisit.
 * This file only answers "does the view report at all".
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");

/** All three trees that render Learning views: the tab itself and most panels
 *  live in operator-vite; the Observations pane lives in the operator app's
 *  `adv` tree; the shared RubricsPanel (also used by the standalone /rubrics
 *  page) lives in operator's `_components` tree. Missing any one of these
 *  silently exempts whatever view it renders from the ratchet — exactly the
 *  vacuity failure mode the "observes real files" test below exists to catch. */
const SCAN_ROOTS = [
  join(REPO_ROOT, "apps/operator-vite/src/components/adv"),
  join(REPO_ROOT, "apps/operator/app/adv"),
  join(REPO_ROOT, "apps/operator/app/_components"),
];

/** Matches both spellings in the tree: the single-line call in AnalyzePanel /
 *  ObservationsPanel and the wrapped multi-line call in LearningTab. */
const SETTLE_CALL = /useInteractionSettle\(\s*PERF_INTERACTIONS\.learningViewSwitch\b/g;

/** Today's reality, measured 2026-08-03 (post WI-7263 fix: every view has a
 *  settle point — SignalsPanel, RubricsPanel, GymView, ApiaryView,
 *  HiveEvalTrendView, BakeoffTrendView, EkgPanel, RedQueenPanel,
 *  ExperimentsPanel, FrontierPanel and ThroughputView joined the original 4).
 *  Both numbers are BASELINES: changing either without updating this file is
 *  the thing the guard exists to catch.
 *
 *  ⬇ 16 → 15 on 2026-08-11: the `wake-efficiency` view was DELETED with the
 *  Mug/Kettle tier (retire-mug-kettle-su-only-2026-08-09 P-059 / D-076) and
 *  MugWakeEfficiencyPanel moved to `_retired/`, which is outside SCAN_ROOTS.
 *  BOTH sides of the ratchet moved by one — LEARNING_VIEWS lost a member and
 *  the scan lost a call site — so `unmeasured` is still 0. That is the
 *  "retires none without shrinking the baseline" branch working as designed:
 *  a deliberate shrink, not a silently-lost settle point. */
const KNOWN_SETTLE_CALL_SITES = 15;
const KNOWN_UNMEASURED_VIEWS = 0;

function tsxFilesUnder(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // a tree that moved is caught by the vacuity test below
  }
  return entries.flatMap((entry) => {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) return tsxFilesUnder(full);
    // Test files reference the interaction while asserting ON it; counting them
    // would let a new test silently satisfy the ratchet for a real view.
    if (!full.endsWith(".tsx") || /\.test\.tsx$/.test(full)) return [];
    return [full];
  });
}

/** Every file containing a settle point for this interaction, with its count. */
function settlePointSites(): { file: string; count: number }[] {
  return SCAN_ROOTS.flatMap(tsxFilesUnder)
    .map((file) => ({
      file: relative(REPO_ROOT, file),
      count: readFileSync(file, "utf8").match(SETTLE_CALL)?.length ?? 0,
    }))
    .filter((hit) => hit.count > 0)
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** PURE: the coverage verdict, injectable so the falsification test below can
 *  prove this reds on the REAL defect rather than on a synthetic stand-in.
 *  Production callers pass nothing (same contract as `orphanedLearningViews`). */
export function settleCoverage(
  viewCount: number = LEARNING_VIEWS.length,
  callSites: number = settlePointSites().reduce((n, hit) => n + hit.count, 0),
): { views: number; callSites: number; unmeasured: number } {
  return { views: viewCount, callSites, unmeasured: viewCount - callSites };
}

const BASELINE = {
  views: KNOWN_SETTLE_CALL_SITES + KNOWN_UNMEASURED_VIEWS,
  callSites: KNOWN_SETTLE_CALL_SITES,
  unmeasured: KNOWN_UNMEASURED_VIEWS,
};

describe("Learning view perf-settle coverage (WI-7263)", () => {
  it("adds no view without a settle point, and retires none without shrinking the baseline", () => {
    const sites = settlePointSites();
    const callSites = sites.reduce((total, hit) => total + hit.count, 0);
    const unmeasured = LEARNING_VIEWS.length - callSites;

    // One equality catches all three directions of drift:
    //   a new view with no settle point   -> gap grows  -> red
    //   a settle point removed            -> gap grows  -> red
    //   a settle point ADDED              -> gap shrinks -> red, so the baseline
    //     must be updated deliberately (that is the ratchet tightening).
    expect(
      settleCoverage(LEARNING_VIEWS.length, callSites),
      `Learning-view settle coverage changed.\n` +
        `  views=${LEARNING_VIEWS.length} settlePoints=${callSites} unmeasured=${unmeasured}\n` +
        `  sites:\n${sites.map((s) => `    ${s.file} x${s.count}`).join("\n")}\n` +
        `If you ADDED a view: give it a settle point (see LearningTab.tsx:1299 for the\n` +
        `contract — gate on the PRIMARY read, settle on a fault too, and gate on \`active\`\n` +
        `because panes stay mounted). If you ADDED a settle point: lower\n` +
        `KNOWN_UNMEASURED_VIEWS here. Leaving a view unmeasured is not neutral — it\n` +
        `reports nothing, and nothing reads as fast.`,
    ).toEqual(BASELINE);
  });

  it("reds on the REAL defect — a view added with no settle point", () => {
    // The defect exactly as it arrives: someone appends a 17th entry to LVIEWS,
    // ships the panel, and never ends the interaction. Simulated in memory on
    // purpose — this tree is shared and git-sync commits it WHOLE, so actually
    // adding the view to watch it red risks committing the broken state
    // (the same reasoning as the WI-6383 guard's pre-fix reconstruction).
    expect(settleCoverage(LEARNING_VIEWS.length + 1, KNOWN_SETTLE_CALL_SITES)).not.toEqual(
      BASELINE,
    );
    expect(settleCoverage(LEARNING_VIEWS.length + 1, KNOWN_SETTLE_CALL_SITES).unmeasured).toBe(
      KNOWN_UNMEASURED_VIEWS + 1,
    );
  });

  it("reds when a settle point is REMOVED, and when one is added without shrinking the baseline", () => {
    // Both directions matter. Losing a settle point is a silent regression of
    // exactly the kind this guards; gaining one must force a deliberate
    // baseline edit, which is what makes this a ratchet rather than a snapshot.
    expect(settleCoverage(LEARNING_VIEWS.length, KNOWN_SETTLE_CALL_SITES - 1)).not.toEqual(
      BASELINE,
    );
    expect(settleCoverage(LEARNING_VIEWS.length, KNOWN_SETTLE_CALL_SITES + 1)).not.toEqual(
      BASELINE,
    );
  });

  it("observes real files (a green here is not a green over nothing)", () => {
    // The scan is the whole basis of the test above, so a moved directory or a
    // renamed hook would make it pass while measuring NOTHING — the exact
    // silent-zero failure this file exists to prevent, reproduced in the guard
    // itself. Pin the scan's own reach.
    const scanned = SCAN_ROOTS.flatMap(tsxFilesUnder);
    expect(scanned.length).toBeGreaterThanOrEqual(10);

    const files = settlePointSites().map((hit) => hit.file);
    expect(files).toContain(
      "apps/operator-vite/src/components/adv/LearningTab.tsx",
    );
    expect(files).toContain(
      "apps/operator-vite/src/components/adv/AnalyzePanel.tsx",
    );
    expect(files).toContain("apps/operator/app/adv/create/ObservationsPanel.tsx");
    // Pins the THIRD scan root specifically: it was added alongside the fix
    // that closed this file's baseline to zero, and a regression here would
    // silently exempt the rubrics view again (RubricsPanel lives outside both
    // of the other two roots).
    expect(files).toContain("apps/operator/app/_components/RubricsPanel.tsx");
  });

  it("counts the view population from LVIEWS, not from the nav catalog", () => {
    // LEARNING_VIEWS must be the route-level list. Deriving it from the nav
    // instead would be circular: the reachability guard already pins the nav to
    // LVIEWS, so a view added to BOTH would keep this guard green while going
    // unmeasured.
    expect(LEARNING_VIEWS.length).toBeGreaterThanOrEqual(15);
    expect(LEARNING_VIEWS).toContain("improvements");
    expect(LEARNING_VIEWS).toContain("learnings");
  });
});
