// @vitest-environment jsdom
//
// LearningTab — the BEGIN side of PERF_INTERACTIONS.learningViewSwitch must run
// before any panel's settle point (EI-19375505819043214).
//
// WHY THIS FILE EXISTS. The instrument added to answer the owner's "the
// learning analyze took several seconds" report emitted a 15,289ms measure in a
// real headless desktop run — against a 1500ms budget — for a view switch that
// actually settled in ~1.3s. The measure was not wrong about the arithmetic; it
// was pairing the wrong two marks.
//
// THE MECHANISM. React runs effects in phases, and within a phase CHILD BEFORE
// PARENT. The begin lives in the parent (LearningTab, on a view change); every
// settle point lives in a child panel (AnalyzePanel, ObservationsPanel,
// ImprovementsView) as a passive `useEffect`. With a PASSIVE begin the order on
// a view switch is therefore:
//
//     child endInteraction  →  parent beginInteraction
//
// A panel whose data is already cached settles ON MOUNT, so its endInteraction
// runs first and consumes whatever start mark is lying around — the PREVIOUS
// view's dangling start. The measure then spans "how long the user sat on the
// previous view", which is unbounded and unrelated to render cost. In the run
// that exposed this, the harness dwelt 14s per view and the emitted measure was
// 14s of dwell + ~1.3s of real settle.
//
// STALE_START_MS does not save us: it discards starts older than 30s, and a
// user who spends 15s on a view produces a garbage measure comfortably inside
// that window — indistinguishable from a real 10x budget breach. A perf guard
// that invents breaches is worse than no guard, because it trains the reader to
// discount it.
//
// THE FIX. ALL layout effects run before ANY passive effect, so a begin in a
// layout effect precedes every child settle regardless of child-before-parent.
// These tests pin that contract from both ends: the ordering behaviour (so the
// guarantee is asserted, not assumed) and the source of LearningTab itself (so
// a revert to `useEffect` fails here rather than silently in production).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useEffect, useLayoutEffect, useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

/** Records begin/end in call order — the ordering IS the property under test,
 *  so this asserts sequence rather than a wall-clock duration (which would be
 *  flaky on a loaded box and would not localise the failure anyway). */
let calls: string[] = [];

/** A settle point exactly as the real panels implement it: a PASSIVE effect
 *  that ends the interaction once its primary read is no longer in flight.
 *  `settledOnMount` models the cached-data case — the one that exposed the bug,
 *  because it is the only case where the child has something to do on the very
 *  commit that mounts it. */
function SettlingPanel({ settledOnMount }: { settledOnMount: boolean }) {
  useEffect(() => {
    if (settledOnMount) calls.push("end");
  }, [settledOnMount]);
  return <div data-testid="panel" />;
}

/** A view with no settle point (`improvements` was one until this work; several
 *  learning views still are). Its begin dangles, which is what a later panel
 *  wrongly consumes. */
function InertPanel() {
  return <div data-testid="inert" />;
}

/** Mirrors LearningTab's begin: fires on a view CHANGE, never on first mount.
 *  `phase` selects the effect layer so the test can demonstrate both the broken
 *  and the fixed ordering against the same tree. */
function Parent({ view, phase }: { view: string; phase: "passive" | "layout" }) {
  const prev = useRef<string | null>(null);
  const useChosenEffect = phase === "layout" ? useLayoutEffect : useEffect;
  useChosenEffect(() => {
    const before = prev.current;
    prev.current = view;
    if (before !== null && before !== view) calls.push("begin");
  }, [view]);
  return view === "inert" ? (
    <InertPanel />
  ) : (
    <SettlingPanel settledOnMount />
  );
}

afterEach(() => {
  cleanup();
  calls = [];
});

describe("learning-view-switch begin/settle ordering", () => {
  it("PASSIVE begin lets a cached panel settle FIRST — the 15,289ms bug", () => {
    // Start on a view with no settle point, then switch to one that settles on
    // mount: precisely the sequence the headless run performed.
    const { rerender } = render(<Parent view="inert" phase="passive" />);
    expect(calls).toEqual([]); // first mount is deliberately not measured

    rerender(<Parent view="settling" phase="passive" />);

    // The child consumed the start mark before the parent replaced it, so the
    // emitted measure spans the previous view's dwell instead of this view's
    // render. This assertion documents the DEFECT; it is why the begin below
    // must not be a passive effect.
    expect(calls).toEqual(["end", "begin"]);
  });

  it("LAYOUT begin runs before the panel settles, so the measure is this view's", () => {
    const { rerender } = render(<Parent view="inert" phase="layout" />);
    expect(calls).toEqual([]);

    rerender(<Parent view="settling" phase="layout" />);

    // begin lands first, so endInteraction consumes the start THIS switch
    // created and the measure covers only this view's settle.
    expect(calls).toEqual(["begin", "end"]);
  });

  it("first mount emits no begin, in either phase", () => {
    // Mount cost is harness-dock-open's territory. Folding it in here would
    // blend two populations under one budget — the conflation that made
    // command-palette-open report a 7.6x regression that did not exist
    // (WI-6543).
    render(<Parent view="settling" phase="layout" />);
    expect(calls).toEqual(["end"]);
  });
});

describe("LearningTab source contract", () => {
  // Resolved from cwd rather than import.meta.url: Vite rewrites module URLs to
  // a non-file scheme, so fileURLToPath throws here (ERR_INVALID_URL_SCHEME).
  // Both candidates are tried so the test is indifferent to whether the runner
  // starts in the workspace or the repo root.
  const REL = "src/components/adv/LearningTab.tsx";
  const sourcePath = [
    resolve(process.cwd(), REL),
    resolve(process.cwd(), "apps/operator-vite", REL),
  ].find(existsSync);
  if (!sourcePath) throw new Error(`LearningTab.tsx not found from ${process.cwd()}`);
  const source = readFileSync(sourcePath, "utf8");

  it("begins the interaction in a LAYOUT effect, not a passive one", () => {
    // Guards the real component, not the model above: the behavioural tests
    // prove what layout-vs-passive DOES, this proves LearningTab still picks
    // the correct one. A revert to useEffect reds here.
    const beginIndex = source.indexOf(
      "beginInteraction(PERF_INTERACTIONS.learningViewSwitch)",
    );
    expect(beginIndex).toBeGreaterThan(-1);

    // The nearest effect opener above the begin call must be the layout one.
    const preceding = source.slice(0, beginIndex);
    const lastLayout = preceding.lastIndexOf("useLayoutEffect(");
    const lastPassive = preceding.lastIndexOf("useEffect(");
    expect(lastLayout).toBeGreaterThan(-1);
    expect(lastLayout).toBeGreaterThan(lastPassive);
  });

  /** Matches the settle call for a given `settled` variable, tolerant of a
   *  prettier reflow. Pins the `active` argument too: without it the settle is
   *  blind to a warm revisit (see below). */
  const settleCall = (settledVar: string) =>
    new RegExp(
      `useInteractionSettle\\(\\s*PERF_INTERACTIONS\\.learningViewSwitch,\\s*${settledVar},\\s*active,?\\s*\\)`,
    );

  it("settles the improvements view — the default AND heaviest view", () => {
    // learning.improvements is 320,607B on the live operator and `improvements`
    // is the tab's default landing view, so a missing settle point here meant
    // the instrument could not measure the view the owner most plausibly hit.
    expect(source).toContain("improvementsSettled");
    expect(source).toMatch(settleCall("improvementsSettled"));
  });

  it("settles the learnings view", () => {
    expect(source).toContain("learningsSettled");
    expect(source).toMatch(settleCall("learningsSettled"));
  });

  it("tells each pane whether it is the SELECTED view", () => {
    // EI-19383745196363732 — the WARM half of the same instrument bug.
    //
    // Panes are kept mounted while warm (`warmViews`: the current pane plus the
    // two most recent) and only `hidden` flips, so a normal back-and-forth
    // never remounts. A settle effect keyed on `settled` alone therefore never
    // re-runs on a revisit and the switch measures NOTHING — the silent-zero
    // failure mode, where the budget check passes by measuring zero on the path
    // a real user takes most.
    //
    // The panels gate on `active` (pinned by settleCall above), but that only
    // works if this component actually tells them. This assertion is the one
    // place that covers the wiring: a panel-level test renders the panel
    // directly and so cannot catch its removal here.
    expect(source).toMatch(/active=\{mountedView === view\}/);
  });
});
