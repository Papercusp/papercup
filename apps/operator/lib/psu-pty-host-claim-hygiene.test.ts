/**
 * psu-pty-turn-boundary-generalization-2026-09-22 D-011 — a claim that MEASUREMENT
 * RETRACTED must not survive in code as warrant for anything.
 *
 * WHAT HAPPENED. D-003 argued the naive codex port of the "user_message resets" rule
 * "could never latch" and would return false FOREVER. D-009 retracted that mechanism
 * against measurement — replaying the production tail window at every poll point of a
 * 3,071-row transcript gave polls=3066, divergences=1 (0.03%) — because Claude Code
 * writes the `end_turn` row AFTER the final tool_result, so each spurious reset is
 * immediately overwritten.
 *
 * The retraction landed in the plan record and in the classifier's own comment, but ONE
 * downstream citation survived: the doc comment above the exported `TURN_ROW_CLASSIFIERS`
 * registry still read "it just returns false forever (D-003)". The sentence it was
 * supporting is TRUE — a classifier that is genuinely wrong fails quietly, which is the
 * real reason the registry must be enumerable by a test — but the citation pointed at a
 * mechanism that had been measured false, so a reader following it came away believing
 * the guard rested on firmer ground than it does. That is the defect this guard encodes:
 * not a wrong claim, a retracted WARRANT.
 *
 * WHY A WINDOW AND NOT A BLANKET RULE. `D-003` is not a globally reserved token — this
 * file carries an unrelated `D-003` citation about socket/SID/lock survival across a
 * re-exec. A rule of the form "every D-003 must sit beside D-009" would fail on that
 * line, and a guard that is red for a reason nobody believes gets weakened by whoever
 * next touches it. So the guard fires only where a D-003 citation shares a window with
 * the RETRACTED phrasing, and is satisfied when the retraction is named in that same
 * window.
 *
 * ⚠ THE POSITIVE CONTROL IS LOAD-BEARING. This guard's headline assertion is an ABSENCE,
 * and an absence is exactly what a broken instrument manufactures: a typo'd regex, a
 * renamed file, or a read that returns an empty string all produce a confident green.
 * The first test therefore asserts the detector still matches the retracted phrasing
 * SOMEWHERE in the file. If a future change legitimately removes every trace of the
 * D-003/D-009 episode, that control fails loudly — deliberately. It is asking a human to
 * confirm the guard still has a subject, rather than letting it pass vacuously forever.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Overridable ON PURPOSE. This guard's subject is a source FILE, so the only honest way
 * to prove it can fail is to weaken a copy and re-point the test at it — never to mutate
 * the shared tree, which git-sync sweeps every few minutes and would happily commit the
 * mutant. This one line is what makes `scripts/mutation-probe.sh` copy-out mode usable:
 *   scripts/mutation-probe.sh --file apps/operator/scripts/psu-pty-host.mjs \
 *     --mutate 's/D-009/D-00X/g' \
 *     --test 'PSU_PTY_HOST_SRC={} npx vitest run --config apps/operator/vitest.config.ts apps/operator/lib/psu-pty-host-claim-hygiene.test.ts'
 */
const HOST_SRC_PATH =
  process.env.PSU_PTY_HOST_SRC ?? fileURLToPath(new URL('../scripts/psu-pty-host.mjs', import.meta.url));
const HOST_SRC = readFileSync(HOST_SRC_PATH, 'utf8');
const LINES = HOST_SRC.split('\n');

/**
 * The propositions D-009 retracted. Kept deliberately narrow: this must match the
 * RETRACTED mechanism, not the surviving "fails quietly" argument that replaced it.
 */
const RETRACTED_CLAIM = /(returns?\s+false[\s\S]{0,80}?forever)|(never\s+latch)/i;

/** Lines either side of a citation that count as "the same breath". */
const WINDOW = 8;

const windowAround = (index: number): string =>
  LINES.slice(Math.max(0, index - WINDOW), Math.min(LINES.length, index + WINDOW + 1)).join('\n');

describe('D-011 — retracted-claim hygiene in psu-pty-host.mjs', () => {
  it('positive control: the instrument reads the right file and can still see the retracted phrasing', () => {
    // Right file, not an empty/stale read.
    expect(HOST_SRC.length).toBeGreaterThan(1000);
    expect(HOST_SRC).toContain('export const TURN_ROW_CLASSIFIERS');
    expect(HOST_SRC).toContain('D-003');
    // The detector matches real text in this file. Without this, the guard below is an
    // absence claim made by an instrument nobody proved was working.
    expect(RETRACTED_CLAIM.test(HOST_SRC)).toBe(true);
  });

  it('never cites D-003 as warrant for the mechanism D-009 retracted, unless the retraction is named alongside it', () => {
    const offenders = LINES.flatMap((line, i) => {
      if (!line.includes('D-003')) return [];
      const context = windowAround(i);
      // A D-003 citation about something else entirely (e.g. re-exec socket survival) is
      // none of this guard's business.
      if (!RETRACTED_CLAIM.test(context)) return [];
      const namesRetraction = context.includes('D-009') && /retract|supersed/i.test(context);
      return namesRetraction ? [] : [{ line: i + 1, text: line.trim() }];
    });

    expect(offenders).toEqual([]);
  });

  it('the TURN_ROW_CLASSIFIERS doc comment carries the surviving claim, not the retracted warrant', () => {
    const exportIndex = LINES.findIndex((l) => l.includes('export const TURN_ROW_CLASSIFIERS'));
    // Instrument check: a -1 here would make every assertion below vacuously true.
    expect(exportIndex).toBeGreaterThan(-1);

    const doc = LINES.slice(Math.max(0, exportIndex - 24), exportIndex).join('\n');

    // The registry is exported so a test can ENUMERATE it; the comment must say why in
    // terms that survived measurement.
    expect(doc).toMatch(/ENUMERATE/i);
    // The retraction must be named where D-003 is invoked here.
    expect(doc).toContain('D-009');
    expect(doc).toMatch(/retract|supersed/i);
    // And the bare pre-correction form must not come back.
    expect(doc).not.toMatch(/forever\s*\(D-003\)/i);
  });
});
