/**
 * `scripts/lib/load-suspect.mjs` decides how to REPORT a failure that survived HARDEN-GATE
 * flake absorption: as a confident hard red, or as load-suspect residue that must be
 * re-triaged on a quiet box before anyone "fixes" it (WI-38300).
 *
 * WHY THIS FILE EXISTS (the WI-37830 argument, same as affected-tests-task-exit-class.test.ts):
 * in-process every one of these branches runs ONLY after a task has already failed AND its
 * absorption re-run has also failed — on a healthy tree, never. That is exactly how the false
 * premise this helper corrects ("a real regression fails both runs; a load flake almost never
 * fails twice in a row", affected-tests.mjs:1577) survived unchallenged in a comment: nothing
 * executed it, so nothing could contradict it.
 *
 * The assertions are deliberately two-sided, for a reason specific to this subject. The naive
 * reading of WI-38300 — "stop reporting it as a hard red" — is one careless edit away from
 * "stop reporting it", which would convert a noisy-but-safe false RED into a silent false
 * GREEN and wave a genuine regression through whenever the box is busy. So every test that
 * proves the new LABEL is applied is paired with one proving the GATE still holds.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyResidualFailure,
  residualGates,
  formatLoadSuspectNotice,
  formatLoadSuspectMarker,
} from '../../../../scripts/lib/load-suspect.mjs';

// The caller's mirror (scripts/affected-tests.mjs AUTO_RETRY_LOAD1_THRESHOLD), passed in as a
// parameter so the module stays import-free — see its header for why that is deliberate.
const THRESHOLD = 40;

describe('classifyResidualFailure', () => {
  it('counts a re-run that PASSED as absorbed (the flake case that already worked)', () => {
    expect(
      classifyResidualFailure({ absorptionRan: true, rerunStatus: 0, load1AtRerun: 89, threshold: THRESHOLD }),
    ).toBe('absorbed');
  });

  it('labels a re-run that failed again while the box was STILL loaded as load-suspect', () => {
    // The WI-38300 case, with the measured numbers from the 2026-08-12 run.
    expect(
      classifyResidualFailure({ absorptionRan: true, rerunStatus: 1, load1AtRerun: 89, threshold: THRESHOLD }),
    ).toBe('load-suspect');
  });

  it('still calls a re-run that failed again on a QUIET box a hard red', () => {
    // The paired negative: absorption's premise DOES hold at low load, so the verdict there
    // must stay confident. A helper that labelled everything load-suspect would pass the test
    // above and be useless — this is what stops that.
    expect(
      classifyResidualFailure({ absorptionRan: true, rerunStatus: 1, load1AtRerun: 3, threshold: THRESHOLD }),
    ).toBe('hard-red');
  });

  it('treats load exactly AT the threshold as a hard red, matching the enabling comparison', () => {
    // affected-tests.mjs enables absorption on `load1 > THRESHOLD` (strictly greater). If this
    // used >=, a run could enable absorption on a load it then refuses to blame — the same
    // incoherence, one boundary over.
    expect(
      classifyResidualFailure({
        absorptionRan: true,
        rerunStatus: 1,
        load1AtRerun: THRESHOLD,
        threshold: THRESHOLD,
      }),
    ).toBe('hard-red');
  });

  it('reports a hard red when the load was NOT MEASURED, rather than inventing an excuse', () => {
    // Unknown load is not evidence of load. A missing reading must never manufacture the
    // softer label — that would let an absent measurement argue for its own conclusion.
    for (const load1AtRerun of [null, undefined, Number.NaN]) {
      expect(
        classifyResidualFailure({ absorptionRan: true, rerunStatus: 1, load1AtRerun, threshold: THRESHOLD }),
      ).toBe('hard-red');
    }
  });

  it('reports no-absorption distinctly, even under high load', () => {
    // Retry disabled, too many failed files to re-run scoped, or nothing parseable: this run
    // holds no second observation at all, so it must not claim one in either direction.
    expect(
      classifyResidualFailure({ absorptionRan: false, rerunStatus: null, load1AtRerun: 89, threshold: THRESHOLD }),
    ).toBe('not-absorbed');
  });
});

describe('residualGates — the fail-safe property', () => {
  it('GATES a load-suspect residue: the label changes attribution, never the verdict', () => {
    // ⚠ THE LOAD-BEARING ASSERTION OF THIS FILE. Softening a load-suspect residue into a pass
    // is the one change that would turn WI-38300's false-red into a false-GREEN, and on a
    // green tree nothing else in the repo would notice.
    expect(residualGates('load-suspect')).toBe(true);
  });

  it('gates every failure class and forgives only a genuine absorption', () => {
    // Two-sided: proves the predicate is not simply `true` everywhere (which would pass the
    // test above while making the label meaningless), and not `false` anywhere it matters.
    expect(residualGates('hard-red')).toBe(true);
    expect(residualGates('not-absorbed')).toBe(true);
    expect(residualGates('absorbed')).toBe(false);
  });

  it('gates a load-suspect residue exactly as hard as a hard red', () => {
    // Stated as an equality so the two cannot drift apart in a later edit that "softens"
    // only one of them.
    expect(residualGates('load-suspect')).toBe(residualGates('hard-red'));
  });
});

describe('formatLoadSuspectNotice', () => {
  const notice = formatLoadSuspectNotice({
    workspace: 'operator-core',
    load1AtRerun: 89,
    threshold: THRESHOLD,
    files: ['lib/live-federation-gate-admission-pressure.test.ts'],
  });

  it('names the measurement that justifies the label', () => {
    expect(notice).toContain('89');
    expect(notice).toContain(String(THRESHOLD));
    expect(notice).toContain('operator-core');
  });

  it('says the failure is STILL COUNTED, so the label cannot be misread as forgiveness', () => {
    // A reader who takes "load-suspect" as "ignore it" would ship a regression. The text has
    // to close that reading itself, because the text is all a triager sees.
    expect(notice).toContain('STILL COUNTED AS A FAILURE');
  });

  it('gives the ONE next action rather than leaving the reader to invent one', () => {
    expect(notice).toContain('RE-TRIAGE ON A QUIET BOX');
  });

  it('names the residual files when known', () => {
    expect(notice).toContain('lib/live-federation-gate-admission-pressure.test.ts');
  });

  it('omits the file list cleanly when none are known', () => {
    const bare = formatLoadSuspectNotice({ workspace: 'operator-core', load1AtRerun: 89, threshold: THRESHOLD });
    expect(bare).not.toContain('Residual file(s)');
    expect(bare).toContain('STILL COUNTED AS A FAILURE');
  });
});

describe('formatLoadSuspectMarker', () => {
  const marker = formatLoadSuspectMarker({ tasks: 1, files: 3, maxLoad1: 89.4, threshold: THRESHOLD });

  it('carries the counts and the load that justified them', () => {
    expect(marker).toContain('tasks=1');
    expect(marker).toContain('files=3');
    expect(marker).toContain('maxLoad1=89');
    expect(marker).toContain(`threshold=${THRESHOLD}`);
  });

  it('is greppable in the house MARKER key=value shape', () => {
    // machine-line-grep-anchors.ts: a real emitted line always continues `MARKER <key>=…`,
    // which is what lets a triage recipe anchor on it instead of the bare marker — a bare
    // grep also matches vitest TEST NAMES echoed into the same log (WI-37636). This test's
    // own name deliberately does NOT contain the marker, for that exact reason.
    expect(marker).toMatch(/^AFFECTED_TESTS_LOAD_SUSPECT\s+[A-Za-z][A-Za-z0-9_]*=/);
  });

  it('does not reuse the AFFECTED_TESTS_RESULT verdict marker', () => {
    // The advisory must stay a SEPARATE line: AFFECTED_TESTS_RESULT's shape is pinned by
    // affected-tests-result-line.test.ts and parsed by green-checkpoint, and widening a
    // verdict contract to carry an advisory is how advisories get read as verdicts.
    expect(marker).not.toContain('AFFECTED_TESTS_RESULT');
  });
});
