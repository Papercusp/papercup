/**
 * `scripts/lib/terminal-counter-fields.mjs` — WI-1048027 layer 2 regression guard.
 *
 * THE MEASURED FAILURE (canonical run 4, 2026-08-30). The run aborted and emitted:
 *
 *   AFFECTED_TESTS_RESULT status=aborted tasks=121 failed=0 quarantinedFailed=0 \
 *     timedOutTasks=0 undeterminedTasks=0 reason=exit-without-verdict code=1
 *
 * Every counter zero, which reads as "121 tasks ran, nothing failed". The truth was that
 * ~85 tasks had started and one had ALREADY exited 1 — a governed-admission error under a
 * pgbouncer CONNECTION_CLOSED, logged three lines ABOVE that verdict. The run died between
 * OBSERVING that exit and TALLYING it (the crash came from an async postgres.js `Immediate`
 * callback), so the run loop's `failed++` never executed.
 *
 * The verdict was therefore not merely wrong, it was wrong in the direction of GOOD NEWS —
 * `failed=0` is the shape of a pass, and the one large number on the line (`tasks=121`) is
 * the PLANNED count, the one number that does not mean "ran". That combination is why the
 * run was nearly read as a near-pass.
 *
 * The guard: when a nonzero exit was OBSERVED but the tally says nothing failed, the line
 * must say so in words. These tests pin the predicate, not the prose — but they do assert
 * the note is present, because a silent numeric disagreement is what failed the reader.
 */
import { describe, expect, it } from 'vitest';

import { formatTerminalCounterFields } from '../../../../scripts/lib/terminal-counter-fields.mjs';

describe('formatTerminalCounterFields', () => {
  it('reports both observation counters so an abort verdict is never counters-free', () => {
    const { text } = formatTerminalCounterFields({
      failed: 3,
      observedNonzeroExits: 3,
      observedAdmissionErrors: 0,
    });
    expect(text).toContain('observedNonzeroExits=3');
    expect(text).toContain('observedAdmissionErrors=0');
  });

  // THE REGRESSION CASE — run 4's exact shape.
  it('flags TALLY-UNDERCOUNT when an exit was observed but the tally says failed=0', () => {
    const { text, undercount } = formatTerminalCounterFields({
      failed: 0,
      observedNonzeroExits: 1,
      observedAdmissionErrors: 1,
    });
    expect(undercount).toBe(true);
    expect(text).toContain('TALLY-UNDERCOUNT');
    // The two facts a reader of run 4's line did not have: that failed=0 is understated,
    // and that `tasks=` never meant "ran".
    expect(text).toContain('UNDERSTATE');
    expect(text).toContain('PLANNED count');
  });

  it('stays silent on a healthy run where the tally already counted the failures', () => {
    const { text, undercount } = formatTerminalCounterFields({
      failed: 2,
      observedNonzeroExits: 2,
      observedAdmissionErrors: 0,
    });
    expect(undercount).toBe(false);
    expect(text).not.toContain('TALLY-UNDERCOUNT');
  });

  // Deliberately NOT `observed !== failed`: on a healthy run the tally legitimately runs
  // level with or ahead of observation, and quarantined failures are counted separately.
  // A guard that fires on ambiguity is one people learn to ignore, so only the strict
  // failed===0 case asserts.
  it('does not fire merely because the tally and observation counts differ', () => {
    const { undercount } = formatTerminalCounterFields({
      failed: 1,
      observedNonzeroExits: 2,
      observedAdmissionErrors: 0,
    });
    expect(undercount).toBe(false);
  });

  it('stays silent on a genuinely clean abort — nothing observed, nothing tallied', () => {
    const { text, undercount } = formatTerminalCounterFields({
      failed: 0,
      observedNonzeroExits: 0,
      observedAdmissionErrors: 0,
    });
    expect(undercount).toBe(false);
    expect(text).not.toContain('TALLY-UNDERCOUNT');
  });

  // This runs on the crash path, where an abort BEFORE the run loop reads the pre-upgrade
  // closure and a counter may legitimately be absent. A NaN/undefined leaking into a
  // release verdict would be worse than a zero.
  it('renders zeros rather than undefined/NaN when counters are missing entirely', () => {
    const { text, undercount } = formatTerminalCounterFields({});
    expect(text).toContain('observedNonzeroExits=0');
    expect(text).toContain('observedAdmissionErrors=0');
    expect(text).not.toMatch(/undefined|NaN/);
    expect(undercount).toBe(false);
  });

  it('tolerates a no-argument call without throwing on the crash path', () => {
    expect(() => formatTerminalCounterFields()).not.toThrow();
  });
});

/**
 * FALSIFIABILITY CONTROL (repo discipline: a guard that has never failed is a guard you
 * have not tested). The subject is a module we import, so the prescribed tier is a
 * deliberately-wrong implementation kept permanently here as a control — no mutation of
 * the shared tree, so no trap-vs-git-sync-sweep race can commit a mutant.
 *
 * `brokenUndercount` is the PRE-FIX behaviour: it reports the counters but never raises
 * the discrepancy — exactly run 4, where the numbers disagreed and nothing said so. If the
 * assertions above can pass against this, they are decorative.
 */
function brokenUndercount(counters: {
  failed?: number;
  observedNonzeroExits?: number;
  observedAdmissionErrors?: number;
}): { text: string; undercount: boolean } {
  return {
    text:
      ` observedNonzeroExits=${counters.observedNonzeroExits ?? 0}` +
      ` observedAdmissionErrors=${counters.observedAdmissionErrors ?? 0}`,
    undercount: false,
  };
}

describe('the undercount guard is falsifiable', () => {
  const run4Shape = { failed: 0, observedNonzeroExits: 1, observedAdmissionErrors: 1 };

  it('CALIBRATION: the real implementation passes the discriminating assertion', () => {
    const real = formatTerminalCounterFields(run4Shape);
    expect(real.undercount).toBe(true);
    expect(real.text).toContain('TALLY-UNDERCOUNT');
  });

  it('CONTROL: the pre-fix implementation FAILS that same assertion', () => {
    const broken = brokenUndercount(run4Shape);
    // Stated as an explicit failure of the control rather than `.not.toBe`, so this reads
    // as "the guard discriminates" rather than as one more property of the broken version.
    expect(broken.undercount).not.toBe(true);
    expect(broken.text).not.toContain('TALLY-UNDERCOUNT');
  });

  it('CONTROL: the pre-fix implementation is otherwise indistinguishable', () => {
    // Both render the same counter fields, which is precisely why the run-4 verdict looked
    // well-formed. The discrepancy note is the ONLY thing separating them.
    const real = formatTerminalCounterFields(run4Shape);
    const broken = brokenUndercount(run4Shape);
    expect(real.text).toContain('observedNonzeroExits=1');
    expect(broken.text).toContain('observedNonzeroExits=1');
  });
});

describe('affected-tests.mjs wiring', () => {
  it('counts nonzero exits at OBSERVATION time, which is what survives the crash window', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(
      resolve(__dirname, '../../../../scripts/affected-tests.mjs'),
      'utf8',
    );

    // The whole point of layer 2: these counters are module-scope and incremented where an
    // outcome is SEEN. Were they derived from the tally instead, they would go stale in
    // exactly the window that loses the tally, and the guard above would never fire.
    expect(source).toMatch(/let observedNonzeroExits = 0;/);
    expect(source).toMatch(/let observedAdmissionErrors = 0;/);

    // The governed-admission path is run 4's actual case and never reaches emitProgress,
    // so it must increment on its own.
    expect(source).toMatch(/observedAdmissionErrors\+\+;/);

    // Both closures must expose them — the pre-upgrade one covers an abort before the run
    // loop, the upgraded one covers an abort during it.
    const closures = source.match(/readTerminalCounters = \(\) => \(\{/g) ?? [];
    expect(closures.length).toBe(2);
    expect(source.match(/observedNonzeroExits,/g)?.length).toBe(2);
  });
});
