import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EI-20204197087661235 — recurrence guard for a DOCUMENTATION defect that cost
 * real agent time four separate times over three weeks.
 *
 * THE DEFECT: `pc-heavy.sh` advertised `PC_HEAVY_GATE_RESERVE=0` as "the
 * override" in the stderr message it prints at the exact moment a caller is
 * queueing. But that flag is scoped to ONE thing — the green-checkpoint reserve
 * CLAMP (`_gate_reserve_active`), which cuts the slot count to a quarter while
 * the gate judges. Setting it to 0 restores the FULL slot count; it does not
 * bypass slot admission at all, so a focused `test:file` set with it still
 * waits behind unrelated heavy runs. The blanket bypass is a different variable
 * (`PC_HEAVY_BYPASS=1`).
 *
 * WHY A TEST AND NOT JUST A BETTER COMMENT: the misreading is on record as
 * REPEATED, not one-off — the reporter of this item hit it, and observations
 * EI-20202047343153322 / EI-20282166185451338 / EI-21341363876583563 plus two
 * codex sessions each independently recorded `PC_HEAVY_GATE_RESERVE=0` as "the
 * documented focused-test escape hatch". A message that offers an override
 * without naming its scope reliably reads as a general one, and the wording is
 * exactly the kind of thing a later edit trims back to one line. So the scope
 * qualifier is pinned here rather than left to survive on good intentions.
 *
 * THE INVARIANT: wherever this script shows `PC_HEAVY_GATE_RESERVE=0` to a
 * reader, the surrounding passage must also say what it does NOT do, or name
 * the no-admission-ticket path for focused tests (`testing:run`). Deliberately
 * a wording-tolerant window check, not a string equality assertion: rewording
 * the guidance should stay green, silently dropping its scope should not.
 *
 * Falsifiability: proven with scripts/mutation-probe.sh in copy-out mode (never
 * mutating the tracked file) against a mutant that restores the original bare
 * "Override with PC_HEAVY_GATE_RESERVE=0." message. See this item's completion
 * evidence for the verdict.
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2), matching the convention already set by
// pc-heavy-retry-stdout-isolation.test.ts and pc-heavy-scratch-nesting-recurrence-guard.test.ts.
const SCRIPT = process.env.PC_HEAVY_SCRIPT ?? resolve(__dirname, '../../../scripts/pc-heavy.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');
const LINES = SOURCE.split('\n');

/** A line that puts the literal override in front of a reader. */
const MENTIONS_OVERRIDE = /PC_HEAVY_GATE_RESERVE\s*=\s*0/;

/**
 * Any phrasing that tells the reader the override is SCOPED — i.e. that it does
 * not admit you ahead of the semaphore. Kept deliberately broad so a rewrite
 * that preserves the meaning keeps passing.
 */
const STATES_ITS_SCOPE =
  /clamp only|does not bypass|not bypass|still (?:queue|wait|compete)|scoped to this clamp|not a general/i;

/** The supported way to run focused tests without taking an admission ticket. */
const NAMES_NO_TICKET_PATH = /testing:run/;

const WINDOW = 16;

function passage(index: number): string {
  return LINES.slice(Math.max(0, index - WINDOW), index + WINDOW + 1).join('\n');
}

describe('pc-heavy.sh — PC_HEAVY_GATE_RESERVE=0 is never advertised as a general "skip the queue" switch', () => {
  it('positive control: the script actually still mentions the override (else this guard measures nothing)', () => {
    // Without this, renaming or removing the variable would make every
    // assertion below vacuously true — the guard would go green precisely
    // because it had stopped inspecting anything.
    const mentions = LINES.filter((line) => MENTIONS_OVERRIDE.test(line));
    expect(
      mentions.length,
      'no line mentions PC_HEAVY_GATE_RESERVE=0 any more. If the variable was intentionally ' +
        'renamed or retired, update this guard to track its replacement; do not delete it.',
    ).toBeGreaterThanOrEqual(2);
  });

  it('every mention of the override states what it does NOT do, or names the no-ticket path', () => {
    const offenders: string[] = [];

    LINES.forEach((line, i) => {
      if (!MENTIONS_OVERRIDE.test(line)) return;
      const context = passage(i);
      if (STATES_ITS_SCOPE.test(context) || NAMES_NO_TICKET_PATH.test(context)) return;
      offenders.push(`  line ${i + 1}: ${line.trim()}`);
    });

    expect(
      offenders,
      'PC_HEAVY_GATE_RESERVE=0 is offered here without saying it only lifts the green-checkpoint ' +
        'CLAMP — you still queue for a slot behind unrelated heavy runs (EI-20204197087661235). ' +
        'Say so in the same passage, or point at `testing:run { files }` for focused tests:\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('the clamp notice printed while a caller is queueing names the no-ticket alternative', () => {
    // This specific message is the highest-leverage one: it is what an agent
    // reads at the exact moment their focused test is stuck, which is why the
    // bare form of it produced the misreading four times over.
    // Match the EMITTED notice, not the prose that discusses it: the `[pc-heavy]`
    // prefix is what marks a user-facing line. Two comments elsewhere in the
    // script also contain "release gate is JUDGING", and a bare substring match
    // finds the first of those instead — caught by this guard's own first run.
    const noticeIndex = LINES.findIndex((line) =>
      /\[pc-heavy\][^\n]*release gate is JUDGING/.test(line),
    );
    expect(
      noticeIndex,
      'the "release gate is JUDGING" clamp notice is gone; re-point this assertion at whatever ' +
        'now tells a caller their slots are clamped.',
    ).toBeGreaterThanOrEqual(0);

    const notice = LINES.slice(noticeIndex, noticeIndex + 10).join('\n');
    expect(
      NAMES_NO_TICKET_PATH.test(notice),
      'the clamp notice must tell a blocked caller how to run focused tests WITHOUT an admission ' +
        'ticket (`testing:run { files }`). Offering only PC_HEAVY_GATE_RESERVE=0 here is the ' +
        'original defect: it lifts the clamp but leaves the caller queueing.',
    ).toBe(true);
  });
});
