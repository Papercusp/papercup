import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LEARNING_VIEWS } from "./LearningTab";

/**
 * WI-4366 guard: the real-webview sweep's view list must not drift from the app's.
 *
 * ## The defect this class produced
 *
 * `scripts/verify-learning-tab-views.sh` is the release gate that drives every
 * Learning view in a real webview. It holds its own literal `ALL_VIEWS` list,
 * and that literal is deliberate — its own header says so: "a checker that
 * derives its expectations from the thing it is checking cannot catch a view
 * being dropped from the catalog."
 *
 * The cost of that independence is drift, and drift arrived. `wake-efficiency`
 * (MugWakeEfficiencyPanel) was DELETED on 2026-08-09 with the Mug/Kettle tier
 * (retire-mug-kettle-su-only-2026-08-09 P-059 / D-074 / D-076); the panel now
 * lives in `_retired/mug-kettle-deciders/` and the id is simply absent from
 * `LVIEWS`, so LearningTab correctly rejects a stale `?lview=wake-efficiency`
 * into the default view. Nothing removed it from the sweep's list. From that
 * day the gate probed a view that no longer exists, read the intentional
 * fallback as `WRONG VIEW — rendered improvements instead (undeclared
 * degrade)`, and exited 1 on a HEALTHY tree — measured 2026-09-02: 15 of 16
 * views ok, one red, no defect behind it.
 *
 * Nothing could have caught it. The reachability guard
 * (learning-view-reachability.guard.test.ts) compares `LVIEWS` against `STAGES`
 * — both INSIDE LearningTab — so a stale entry in a bash array is invisible to
 * it. No type breaks; the lists are in different languages. And the only
 * observable symptom was a red release gate, which is the symptom most likely
 * to be read as "something is broken" and least likely to be read as "the
 * checker is stale" — a permanently-red gate for a non-defect is how a team
 * learns to ignore a gate.
 *
 * ## Why this shape
 *
 * This does NOT generate the script's list from the app, which would destroy
 * the independence the sweep is built on. The script keeps its own literal; the
 * check merely REPORTS that the two disagree, names which side has the extra
 * id, and leaves a human to decide which one is stale. That keeps the sweep an
 * independent checker while moving discovery of a divergence from a ~15-minute
 * Xvfb/Tauri boot to a 20ms unit test.
 *
 * Both directions matter and they fail for opposite reasons:
 *  · an id in the SCRIPT but not the app = the D-076 case above — the gate reds
 *    forever on a view that was deliberately removed.
 *  · an id in the APP but not the script = a new view that the release gate
 *    silently never drives, so its render is unverified in a real webview.
 */

const SCRIPT_RELATIVE_PATH = "scripts/verify-learning-tab-views.sh";

/** Walk up from this file until the directory holding the sweep script appears. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let hop = 0; hop < 12; hop += 1) {
    if (existsSync(join(dir, SCRIPT_RELATIVE_PATH))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `could not locate ${SCRIPT_RELATIVE_PATH} above ${fileURLToPath(import.meta.url)}`,
  );
}

/**
 * Parse the `ALL_VIEWS=( ... )` bash array. Deliberately a parse of the real
 * file rather than a second copy of the list: a copy would be a third thing to
 * drift.
 */
export function parseSweepViews(source: string): string[] {
  const open = source.indexOf("ALL_VIEWS=(");
  if (open === -1) throw new Error("ALL_VIEWS=( not found — the sweep script's array was renamed");
  const close = source.indexOf(")", open);
  if (close === -1) throw new Error("ALL_VIEWS=( is never closed");
  return source
    .slice(open + "ALL_VIEWS=(".length, close)
    .split("\n")
    .map((line) => line.replace(/#.*$/, ""))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean);
}

const SWEEP_VIEWS = parseSweepViews(readFileSync(join(repoRoot(), SCRIPT_RELATIVE_PATH), "utf8"));

describe("Learning sweep view-list drift (WI-4366)", () => {
  it("parsed a real, non-trivial list — the parser is not silently matching nothing", () => {
    // Without this, a renamed array or a reformatted literal would yield [], and
    // an empty set trivially satisfies BOTH assertions below: the guard would go
    // permanently green while checking nothing. That failure is indistinguishable
    // from real agreement, so it is asserted first rather than assumed.
    expect(SWEEP_VIEWS.length).toBeGreaterThanOrEqual(10);
    expect(SWEEP_VIEWS).toContain("signals");
    expect(SWEEP_VIEWS).toContain("throughput");
  });

  it("drives no view the app no longer offers", () => {
    const stale = SWEEP_VIEWS.filter(
      (view) => !(LEARNING_VIEWS as readonly string[]).includes(view),
    );
    expect(stale).toEqual([]);
  });

  it("drives every view the app does offer", () => {
    const unprobed = (LEARNING_VIEWS as readonly string[]).filter(
      (view) => !SWEEP_VIEWS.includes(view),
    );
    expect(unprobed).toEqual([]);
  });

  it("reds on the REAL pre-fix list, not merely on a synthetic one", () => {
    // The exact array that shipped between 2026-08-09 and this fix: today's list
    // with the deleted id put back. Reconstructed in memory on purpose — this
    // tree is shared and git-sync commits it WHOLE, so mutating the script on
    // disk to watch it red risks committing the broken state.
    const preFix = [...SWEEP_VIEWS, "wake-efficiency"];
    expect(preFix.filter((view) => !(LEARNING_VIEWS as readonly string[]).includes(view))).toEqual([
      "wake-efficiency",
    ]);
  });

  it("is not blind in the other direction either", () => {
    // A view the app offers that the gate never drives — the same defect arriving
    // the other way round. Uses a real current view so the control cannot pass by
    // naming something that was never in either list.
    const withoutRubrics = SWEEP_VIEWS.filter((view) => view !== "rubrics");
    expect(
      (LEARNING_VIEWS as readonly string[]).filter((view) => !withoutRubrics.includes(view)),
    ).toEqual(["rubrics"]);
  });
});
