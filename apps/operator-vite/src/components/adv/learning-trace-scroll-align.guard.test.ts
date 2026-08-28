import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * WI-554962 guard: the Learning TRACE drawer must not recenter the viewport
 * when the reader clicks a row that is already on screen.
 *
 * ## The defect this class produced
 *
 * `ImproveGrid` hands `selectedRowKey ?? expandedRowKey` to `VirtualGrid`'s
 * `scrollToRowKey`. `expandedRowKey` is CLICK-driven — clicking a row toggles
 * `?itrace=`, which resolves to that row's key — so the scroll fires on every
 * trace open, not only on a deep link. `VirtualGrid` defaults
 * `scrollToRowAlign` to `'center'`, and in @tanstack/virtual-core's
 * `getOffsetForIndex` ONLY `'auto'` short-circuits for an already-visible row:
 *
 *     if (align === "auto") {
 *       ...
 *       else return [scrollOffset, align];   // visible -> current offset, no move
 *     }
 *     // every other align falls through and repositions unconditionally
 *
 * So opening a trace centred the row the reader had just clicked, moving it out
 * from under the cursor, and then the expanded row rendered content on top of
 * the jump.
 *
 * ## Why nothing caught it
 *
 * The call site's own comment reasoned that "opening a trace is a click on an
 * already-visible row that needs no scroll" — a correct statement of INTENT
 * that the code did not implement. Types cannot see it (the prop is optional
 * and its default is valid), and grid-core's own tests legitimately pin
 * `align: 'center'` because that default is right for a pure deep-link landing.
 * The bug was the call site conflating a click-driven expansion with a
 * deep-link landing, which is invisible from inside either component.
 *
 * ## Why a source guard
 *
 * The symptom is scroll GEOMETRY, and this suite runs in jsdom where every
 * layout value is 0 — a render probe could not tell a centred row from an
 * unmoved one, so it would pass against the bug. What actually decides the
 * behaviour is a single prop at one call site, so that is what is pinned. The
 * runtime half is already covered in grid-core's VirtualGrid.test.tsx, which
 * asserts the align argument reaches `scrollToIndex`.
 */

const SOURCE_PATH = fileURLToPath(new URL("./LearningTab.tsx", import.meta.url));

/** The scroll-to block of the ImproveGrid VirtualGrid, from its target to the row renderer. */
function improveGridScrollBlock(source: string): string {
  const start = source.indexOf("scrollToRowKey={selectedRowKey ?? expandedRowKey}");
  if (start < 0) {
    throw new Error(
      "anchor 'scrollToRowKey={selectedRowKey ?? expandedRowKey}' not found — " +
        "ImproveGrid's scroll target was renamed or restructured; re-point this guard rather than deleting it.",
    );
  }
  const end = source.indexOf("renderExpandedRow", start);
  if (end < 0) throw new Error("'renderExpandedRow' not found after the scroll target");
  return source.slice(start, end);
}

/** Aligns that reposition unconditionally — every one except 'auto'. */
const REPOSITIONING_ALIGNS = ["center", "start", "end"] as const;

describe("Learning trace drawer scroll align (WI-554962)", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");

  it("reads a LearningTab source that actually contains the grid", () => {
    // Positive control. A path typo or a moved file would otherwise make every
    // assertion below vacuous, and an empty read would look exactly like a pass.
    expect(source.length).toBeGreaterThan(1000);
    expect(source).toContain("scrollToRowKey={selectedRowKey ?? expandedRowKey}");
  });

  it("asks for 'auto' so a click on a visible row does not move it", () => {
    expect(improveGridScrollBlock(source)).toContain('scrollToRowAlign="auto"');
  });

  it("does not fall back to any align that repositions unconditionally", () => {
    const block = improveGridScrollBlock(source);
    for (const align of REPOSITIONING_ALIGNS) {
      expect(block).not.toContain(`scrollToRowAlign="${align}"`);
    }
  });

  it("reds on the REAL pre-fix source, not merely on a synthetic one", () => {
    // Calibration control. Without it, a guard whose matcher silently missed
    // would pass for the same reason a correct one does. Reconstructed IN MEMORY
    // on purpose: this tree is shared and git-sync commits it WHOLE on a timer,
    // so mutating the file to watch it red risks committing the broken state.
    //
    // The pre-fix source is exactly today's minus the one added prop line.
    const preFix = source.replace(/\n\s*scrollToRowAlign="auto"/, "");
    expect(preFix).not.toEqual(source); // the removal really happened

    const block = improveGridScrollBlock(preFix);
    expect(block).not.toContain('scrollToRowAlign="auto"');
    // ...and with no explicit align, VirtualGrid's 'center' default applies,
    // which is precisely the repositioning behaviour this guard exists to stop.
    expect(block).not.toMatch(/scrollToRowAlign=/);
  });
});
