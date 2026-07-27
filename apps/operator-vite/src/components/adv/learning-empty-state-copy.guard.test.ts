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
 * SignalsPanel.tsx is EXEMPT — and this is the one exemption in the file.
 *
 * The Observe sub-view (Signals / Observations / Rubrics) is code-frozen by
 * plan decision D-001 of learning-tab-surface-public-release-2026-07-27:
 * [owner 2026-07-27] "just leave the observe tab as it is now". Its copy
 * defect ("the accumulator sweep has not run on this workspace") is REAL and is
 * recorded on WI-6388; it must not be fixed without an explicit owner
 * exception. The exemption is therefore an owner directive, not a waiver of
 * convenience — which is why it names its source here rather than being a bare
 * entry in a skip list.
 */
const FROZEN_BY_OWNER = new Set(["SignalsPanel.tsx"]);

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
  it("the frozen-by-owner exemption still describes reality", () => {
    const signals = ALL_USAGES.filter((u) => u.file === "SignalsPanel.tsx");
    if (signals.length === 0) return; // panel gone/renamed — nothing to assert
    const stillViolates = signals.some(
      ({ text }) =>
        INTERNAL_VOCABULARY.some((t) => text.toLowerCase().includes(t.toLowerCase())) ||
        (!/\bbody=/.test(text) && !/\baction=/.test(text)),
    );
    expect(
      stillViolates,
      "SignalsPanel no longer violates — drop it from FROZEN_BY_OWNER (D-001 exemption is now stale)",
    ).toBe(true);
  });
});
