import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WI-6388 guard: Learning-tab empty states must teach, and must not leak
 * internal vocabulary or assert a cause they cannot establish.
 *
 * ## Why a guard and not just fixed strings
 *
 * The audit found 10 of 12 `LearningVisualEmpty` uses were title-only and 3
 * asserted an internal mechanism as fact ("the singleton materializer has not
 * run on this workspace"). Fixing the strings fixes today; the NEXT panel added
 * will reintroduce both unless the rule is executable. `LearningVisualEmpty`
 * already documents the contract in its own props (`body` = "what this view
 * shows → what makes data appear") — this asserts the contract is actually met.
 *
 * ## Why the cause-assertion rule matters more than it looks
 *
 * Until WI-6382, a data-layer FAILURE arrived at these empty branches as a
 * normal empty. Copy that then explains WHY ("the accumulator sweep has not
 * run") is not merely jargon — it is a specific, authoritative, and possibly
 * FALSE diagnosis that sends the reader to investigate the wrong subsystem.
 */

const DIR = __dirname;

/**
 * Terms that describe INTERNAL MACHINERY the reader cannot see or act on.
 * Deliberately narrow: each is a real phrase found in shipped copy by the P-006
 * audit, not a guess at what might be jargon.
 */
const INTERNAL_VOCABULARY = [
  "singleton materializer",
  "accumulator sweep",
  "stage-artifact persist",
  "materializer",
  "resolver",
  "sync query",
  "migration",
  "42P01",
  "routinesTick",
  "precompute",
];

/**
 * Currently EMPTY — and the empty set is the correct state, not an oversight.
 *
 * The Observe sub-view (Signals / Observations / Rubrics) is code-frozen by
 * plan decision D-001 of learning-tab-surface-public-release-2026-07-27:
 * [owner 2026-07-27] "just leave the observe tab as it is now". That freeze
 * STILL STANDS and is why this list exists at all.
 *
 * SignalsPanel.tsx was listed here for the copy defect recorded on WI-6388
 * ("the accumulator sweep has not run on this workspace") — but that string
 * had already been removed from the panel on 2026-07-18, nine days before this
 * guard was written on 2026-07-27. The exemption was therefore stale the moment
 * it was authored: it described a defect the code no longer had, and the
 * "still describes reality" check below correctly flagged it.
 *
 * Dropping it changes NO user-facing copy — SignalsPanel already satisfies the
 * guard. It only stops exempting a file that complies, so the freeze is fully
 * preserved while the panel gains real coverage. Do NOT re-add an entry here to
 * silence a failure: an entry is an OWNER directive naming its source, never a
 * waiver of convenience.
 */
const FROZEN_BY_OWNER = new Set<string>([]);

function panelSources(): Array<{ file: string; src: string }> {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((file) => ({ file, src: readFileSync(join(DIR, file), "utf8") }))
    .filter(({ src }) => src.includes("<LearningVisualEmpty"));
}

/** Every `<LearningVisualEmpty ... />` usage, as its raw source text. */
function emptyStateUsages(src: string): string[] {
  const out: string[] = [];
  const re = /<LearningVisualEmpty\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    // Walk to the closing `/>` of this element, tolerating nested braces.
    let i = m.index;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      else if (depth === 0 && src.startsWith("/>", i)) {
        i += 2;
        break;
      }
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

const SOURCES = panelSources();
const ALL_USAGES = SOURCES.flatMap(({ file, src }) =>
  emptyStateUsages(src).map((text) => ({ file, text })),
);

describe("WI-6388 guard — Learning empty states teach, and never leak internals", () => {
  // Non-blindness: the scanner must prove it SEES before its silence means
  // anything. A refactor that renames the component, or a broken brace walk,
  // would otherwise leave every assertion below passing over an empty set.
  it("the scanner is not blind: it finds the empty states across several panels", () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(4);
    expect(ALL_USAGES.length).toBeGreaterThanOrEqual(8);
    for (const u of ALL_USAGES) expect(u.text).toContain("title");
  });

  it("the scanner can SEE a violation (it is not vacuously green)", () => {
    const synthetic = '<LearningVisualEmpty icon={X} title="No rows — the singleton materializer has not run." />';
    const found = emptyStateUsages(synthetic);
    expect(found).toHaveLength(1);
    expect(
      INTERNAL_VOCABULARY.some((t) => found[0].toLowerCase().includes(t.toLowerCase())),
    ).toBe(true);
    expect(/\bbody=/.test(found[0])).toBe(false);
  });

  it("no empty state leaks internal vocabulary to the user", () => {
    const violations: string[] = [];
    for (const { file, text } of ALL_USAGES) {
      if (FROZEN_BY_OWNER.has(file)) continue;
      for (const term of INTERNAL_VOCABULARY) {
        if (text.toLowerCase().includes(term.toLowerCase())) {
          violations.push(`${file}: "${term}" in ${text.slice(0, 120)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("every empty state carries teaching copy (body or action)", () => {
    const bare = ALL_USAGES.filter(
      ({ file, text }) =>
        !FROZEN_BY_OWNER.has(file) && !/\bbody=/.test(text) && !/\baction=/.test(text),
    ).map(({ file, text }) => `${file}: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
    expect(bare).toEqual([]);
  });

  // The exemption must stay HONEST: if SignalsPanel ever stops violating (an
  // owner exception is granted and the copy is fixed), this fails so the
  // exemption is removed rather than lingering as an unexamined skip.
  // Every exemption must still EARN its place: the panel it names must actually
  // still violate. An exemption for an already-clean file is dead weight that
  // silently withholds coverage — which is exactly what happened to the original
  // SignalsPanel.tsx entry (see the FROZEN_BY_OWNER comment above).
  //
  // Iterates the set rather than naming one file, so a future entry is checked
  // too. With the set empty this passes with nothing to assert — that is the
  // intended resting state, and the two guards above then cover every panel.
  it("every frozen-by-owner exemption still describes reality", () => {
    for (const file of FROZEN_BY_OWNER) {
      const usages = ALL_USAGES.filter((u) => u.file === file);
      if (usages.length === 0) continue; // panel gone/renamed — nothing to assert
      const stillViolates = usages.some(
        ({ text }) =>
          INTERNAL_VOCABULARY.some((t) => text.toLowerCase().includes(t.toLowerCase())) ||
          (!/\bbody=/.test(text) && !/\baction=/.test(text)),
      );
      expect(
        stillViolates,
        `${file} no longer violates — drop it from FROZEN_BY_OWNER (its D-001 exemption is now stale)`,
      ).toBe(true);
    }
  });
});
