/**
 * CLAUDE.md's log-triage recipes must anchor each house machine-line marker on the
 * field only a REAL emitter writes — never the bare marker (WI-37636; sibling of
 * `gate-candidate-ref.ts` / `retired-surfaces.ts`, same P-004 family).
 *
 * WHY this needs a guard rather than prose. vitest echoes TEST NAMES into the very
 * log these recipes grep, and `green-checkpoint.test.ts:4919` is named
 * "...in the house GATE_HELD_BY / AFFECTED_TESTS_RESULT shape" — so both markers
 * appear as impostors whenever that suite is selected, i.e. exactly when the gate is
 * judging the release path and someone is triaging. Measured 2026-08-10 on
 * `…-cand-a68d051e8fd8.log`: the bare form returned that test name, ALL 6 matches
 * were impostors, and ZERO real machine lines existed — on a legitimately GREEN run,
 * where the absence IS the signal. The failure therefore reads as an answer.
 *
 * The fix landed as corrected prose in CLAUDE.md, which nothing enforced; this judge
 * is what keeps it from silently regressing on the next edit.
 *
 * SCOPING: only lines inside a fenced code block are judged. CLAUDE.md necessarily
 * QUOTES the bad form in prose to warn about it (the warning beside these very
 * recipes contains a literal bare `grep -o 'GATE_HELD_BY.*'`), so judging prose would
 * fire on the documentation of the bug itself. Fenced blocks are where recipes a
 * reader COPIES actually live.
 */

/** Marker → the field that only a real emitted line carries. */
export const REQUIRED_ANCHOR: Readonly<Record<string, string>> = Object.freeze({
  GATE_HELD_BY: 'count=',
  GATE_PROMOTION: 'candidate=',
  AFFECTED_TESTS_RESULT: 'status=',
  AFFECTED_TESTS_FAILING_FILES: 'run=',
  TEST_FILE_RESULT: 'status=',
});

export interface UnanchoredSite {
  readonly line: number;
  readonly marker: string;
  readonly requiredAnchor: string;
  readonly text: string;
}

export interface MachineLineGrepVerdict {
  readonly ok: boolean;
  readonly checkedLines: number;
  readonly unanchoredSites: readonly UnanchoredSite[];
  readonly violations: readonly string[];
}

/** A doc too short to contain the recipes is a FAILED READ, never a clean bill. */
const MIN_PLAUSIBLE_CHARS = 2000;

/**
 * `AFFECTED_TESTS_FAILING_FILES` contains no other marker as a substring, and no two
 * markers here are prefixes of one another — but sort longest-first anyway so a future
 * marker cannot be shadowed by a shorter sibling.
 */
const MARKERS = Object.keys(REQUIRED_ANCHOR).sort((a, b) => b.length - a.length);

export function judgeMachineLineGrepAnchors(markdown: string): MachineLineGrepVerdict {
  if (markdown.trim().length < MIN_PLAUSIBLE_CHARS) {
    throw new Error(
      `Refusing to judge machine-line grep anchors: read only ${markdown.trim().length} char(s), ` +
        `expected >= ${MIN_PLAUSIBLE_CHARS}. A failed/short read must not be reported as clean.`,
    );
  }

  const lines = markdown.split('\n');
  const unanchoredSites: UnanchoredSite[] = [];
  let inFence = false;
  let checkedLines = 0;

  lines.forEach((text, index) => {
    if (text.trimStart().startsWith('```')) {
      inFence = !inFence;
      return;
    }
    // Prose deliberately quotes the bad form to warn about it — see SCOPING above.
    if (!inFence || !text.includes('grep')) return;

    checkedLines += 1;
    for (const marker of MARKERS) {
      if (!text.includes(marker)) continue;
      const requiredAnchor = REQUIRED_ANCHOR[marker]!;
      // Every occurrence must be anchored; one anchored use does not excuse a bare one.
      const anchored = new RegExp(`${marker}\\s+${requiredAnchor}`, 'g');
      const occurrences = text.split(marker).length - 1;
      const anchoredCount = (text.match(anchored) ?? []).length;
      if (anchoredCount < occurrences) {
        unanchoredSites.push({ line: index + 1, marker, requiredAnchor, text: text.trim() });
      }
    }
  });

  const violations = unanchoredSites.map(
    (s) =>
      `CLAUDE.md:${s.line} greps the bare marker \`${s.marker}\` — anchor it as ` +
      `\`${s.marker} ${s.requiredAnchor}\`, which only a real emitted line carries. ` +
      `A bare grep also matches vitest TEST NAMES echoed into the same log (WI-37636), ` +
      `so it returns plausible prose where the honest answer is no match. Line: ${s.text}`,
  );

  return { ok: violations.length === 0, checkedLines, unanchoredSites, violations };
}
