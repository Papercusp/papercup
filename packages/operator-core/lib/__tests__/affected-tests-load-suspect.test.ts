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
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * WIRING — the helper being correct is worthless if nothing calls it, and the classification
 * above is a pure function that cannot observe its own caller. Driving the absorption path for
 * real would need a genuinely failing vitest child AND a loaded box, so these are SOURCE-SHAPE
 * assertions, which affected-tests-result-line.test.ts establishes as legitimate exactly where
 * "executing the path is genuinely expensive". They pin CODE tokens, never prose — prose pins
 * are what red-pinned the fleet's gate twice (EI-20103084274785576).
 */
describe('wiring into scripts/affected-tests.mjs', () => {
  const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  /**
   * Same test-only seam as affected-tests-result-line.test.ts: point this at a MUTATED COPY
   * (outside the tree) to prove these assertions can actually fail. It is the only safe way
   * to falsify them — mutating the real script in place races git-sync, which sweeps the whole
   * tree every few minutes and would commit the mutant even if nothing else went wrong. Unset
   * in every normal run. Drive it with scripts/mutation-probe.sh.
   */
  // Resolved against REPO_ROOT, not process.cwd(): vitest runs this suite with
  // cwd=packages/operator-core, so a bare resolve() of a RELATIVE override silently looked for
  // packages/operator-core/scripts/affected-tests.mjs and the probe's baseline leg died on
  // ENOENT. `resolve(base, abs)` returns abs unchanged, so this is correct for both forms.
  const AFFECTED_TESTS = process.env.PAPERCUSP_AFFECTED_TESTS_SCRIPT
    ? resolve(REPO_ROOT, process.env.PAPERCUSP_AFFECTED_TESTS_SCRIPT)
    : resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
  const src = readFileSync(AFFECTED_TESTS, 'utf8').replaceAll('"', "'");

  it('imports the classifier from the shared module rather than re-deriving it inline', () => {
    expect(src).toContain("from './lib/load-suspect.mjs'");
    expect(src).toContain('classifyResidualFailure');
  });

  it('judges against the SAME threshold that auto-enables absorption', () => {
    // If the enabling comparison and the blaming comparison ever used different constants, a
    // run could switch absorption on for a load it then refuses to blame — the exact
    // incoherence WI-38300 is about, reintroduced one constant over.
    expect(src).toMatch(/threshold:\s*retryLoad1Threshold/);
  });

  it('normalizes the auto-retry trigger by the process available parallelism', () => {
    // A raw load1 threshold is machine-size dependent: load1=40 is severe on a 16-core box
    // but only 0.31 runnable tasks per core on the 128-core host this runner shares. The
    // policy is therefore expressed in loadavg/core and the raw threshold used for residual
    // attribution is derived from that same policy.
    expect(src).toContain('const AUTO_RETRY_LOAD1_THRESHOLD = 1.0;');
    expect(src).toMatch(/const currentLoadPerCore = currentLoad1 \/ RETRY_LOAD1_CORES;/);
    expect(src).toMatch(/:\s*currentLoadPerCore > AUTO_RETRY_LOAD1_THRESHOLD;/);
    expect(src).toMatch(
      /const retryLoad1Threshold\s*=\s*AUTO_RETRY_LOAD1_THRESHOLD\s*\*\s*RETRY_LOAD1_CORES;/,
    );
  });

  it('samples the load AFTER each absorption re-run, never before it', () => {
    // ⚠ THE ASSERTION NO UNIT TEST CAN REACH, and the one a refactor is most likely to
    // silently invert. loadavg()[0] is a TRAILING average: sampled after the re-run it
    // describes the load the RE-RUN experienced; hoisted above the re-run it describes the
    // first pass, which is already known-high (it is what enabled absorption) and would
    // therefore label essentially EVERY residual failure load-suspect. That failure is
    // invisible in output — the notice still renders, with a plausible number.
    // P-004 (gate-latency-selection-and-retry-policy-2026-09-06): both arms — the scoped
    // fresh-process re-run and the whole-workspace retry — now run through ONE retry pool, so
    // there is exactly ONE re-run site and ONE sample site: inside the pool's runTask,
    // immediately after the child settles. The reporting loop runs only once EVERY retry has
    // settled, so a sample taken there would describe the load of nothing in particular; it
    // must READ the pool's sample, never take its own.
    const sites = [...src.matchAll(/const load1AtRerun = loadavg\(\)\[0\];/g)];
    expect(sites).toHaveLength(1);
    // (`src` has its double quotes normalised to single quotes — see its definition above.)
    expect(src).toMatch(
      /await runCapturedTask\(\s*context,\s*allocation,\s*context\.__retry\.extraArgs,\s*context\.__retry\.scriptOverride,\s*'retry',\s*\);\s*(?:\/\/[^\n]*\n\s*)*const load1AtRerun = loadavg\(\)\[0\];/,
    );
    expect(src).toMatch(/load1AtRerun = retried\.value\.__load1AtRerun \?\? null;/);
    // No stray sample AFTER the reporting loop begins (the late-sample failure this guard
    // exists for): the one sample site must precede `retryPrep.get(...)` in file order.
    expect(src).not.toMatch(/retryPrep\.get\(scheduled\.index\)[\s\S]*load1AtRerun = loadavg\(\)\[0\];/);
  });

  it("re-runs a LANE workspace's failed files under the DEFAULT `test` script, so the retry is ISOLATED", () => {
    // THE INVARIANT THE PURE/STATEFUL LANE SPLIT'S SAFETY RESTS ON (P-003, plan
    // gate-suite-speedup-2026-08-12). The pure lane runs with vitest's `isolate` OFF, so files
    // share a fork's module registry — which is the whole speedup, and also means a file can
    // fail purely because of what a SIBLING left behind. Those are artifacts, not defects.
    //
    // MEASURED 2026-08-13: a lane leg failed 14 files; 10 passed when re-run isolated. If the
    // retry re-invokes the SAME script, PC_TEST_LANE stays set, the files run non-isolated
    // again, and the artifacts reproduce — so the one class this retry is best placed to
    // absorb is the one it cannot. Worse, each survivor counts as a failing FILE against
    // FRESH_RETRY_MAX_FILES (15) here and ISOLATION_MAX_FILES (15) in green-checkpoint.ts,
    // past which a red is declared a real regression and the isolation rescue is SKIPPED.
    // Lane artifacts would then spend a budget that exists to absorb genuine load flakes.
    //
    // `test` sets no lane env, so it resolves the default config and is isolated BY
    // CONSTRUCTION — the same property resolveWorkspaceTestInvocation relies on for the gate's
    // own isolation and confirming co-execution re-runs.
    // P-004: the invocation is now a pure per-decision builder (the retry itself runs in the
    // shared pool), but the lane rule is unchanged: a fresh-files re-run of a lane workspace
    // goes through the default `test` script.
    expect(src).toMatch(
      /const retryInvocationFor = \(t, decision, failedFiles\) =>\s*decision\.mode === 'fresh-files'\s*\?\s*hasLaneSplit\(t\.ws\)\s*\?\s*\{ extraArgs: failedFiles, scriptOverride: 'test' \}\s*:\s*\{ extraArgs: failedFiles, scriptOverride: null \}/,
    );
    // …and it is the function the retry plan actually uses. Pinned separately because the
    // helper could be defined correctly and simply not wired in — a passing definition beside
    // a bare file-list spread would look right and behave exactly as before.
    expect(src).toMatch(/\.\.\.retryInvocationFor\(t, retryDecision, failedFiles\),/);
    expect(src).not.toMatch(/\n\s*r = await run\(failedFiles\);/);
  });

  it('reports as residue what SURVIVED the re-run, not what entered it', () => {
    // Two-sided partner to the test above. formatLoadSuspectNotice states the files "failed
    // the first pass AND the fresh-process re-run"; assigning the PRE-retry set made that
    // sentence false for every file the re-run absorbed. Measured 2026-08-13: 14 in, 4 out,
    // and the notice named all 14 — sending gate triage at 10 files that had just passed.
    expect(src).toMatch(/residualFiles =\s*rerunFailedFiles\.length > 0 \? rerunFailedFiles : failedFiles;/);
    // The fallback direction is deliberate: when the re-run's output does not parse we name
    // the pre-retry set rather than nothing, because a notice naming NO file is unactionable.
    expect(src).toMatch(/const rerunFailedFiles = parseFailedFiles\(/);
    expect(src).not.toMatch(/\n\s*residualFiles = failedFiles;/);
  });

  it('emits the advisory marker BEFORE the verdict line, and never inside it', () => {
    const markerCall = src.lastIndexOf('formatLoadSuspectMarker({');
    expect(markerCall).toBeGreaterThan(0);
    // The script now has TWO failed-verdict sites: the undetermined-only early exit
    // (`!failed && undeterminedTasks`) sits BEFORE the marker and structurally cannot
    // carry load-suspect residue — load-suspect tasks stay counted in `failed` (see the
    // gate-holds test below), so `!failed` excludes them. The property this guard pins
    // is that the marker precedes ITS OWN verdict emission, so anchor the search at the
    // marker call: a marker moved after (or into) every verdict leaves no verdict to
    // find past it and fails here.
    const failedVerdict = src.indexOf("errSync(resultLine('failed'))", markerCall);
    expect(failedVerdict).toBeGreaterThan(markerCall);
    // The verdict template must stay exactly as affected-tests-result-line.test.ts pins it:
    // no load-suspect field may be smuggled onto the line green-checkpoint parses.
    expect(src).not.toMatch(/AFFECTED_TESTS_RESULT status=\$\{status\}[^`]*loadSuspect/);
  });

  it('keeps a load-suspect task counted in `failed` — the gate still holds', () => {
    // The label is applied INSIDE the branch that has already run `failed++`, so it cannot
    // subtract from the count. Pinned because "report it differently" is one edit away from
    // "report it less", and that edit would be invisible on a green tree.
    const failedIncrement = src.indexOf('failed++;');
    const labelSite = src.indexOf('classifyResidualFailure({');
    expect(failedIncrement).toBeGreaterThan(0);
    expect(labelSite).toBeGreaterThan(failedIncrement);
    expect(src).not.toMatch(/failed--|failed\s*-=\s*1/);
  });
});
