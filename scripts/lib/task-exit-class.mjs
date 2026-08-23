// task-exit-class.mjs — the pure classification behind one question in
// `scripts/affected-tests.mjs`: a task exited non-zero, so does that GATE the run?
//
// There are four answers, not two (WI-37826 / WI-37830). A strand-guard derives its
// subject from `git diff <base>`, so its exit code says one of three things — 0 "checked,
// found nothing", 1 "checked, found something", 2 "I could not look" — and a run that
// collapses those into `status !== 0` reads "I could not look" as "violation". Quarantine
// adds the fourth. The gate checkout is CLEAN BY CONSTRUCTION (its candidate is committed),
// so the working diff is empty and a registered strand guard examines zero files EVERY
// time; getting this wrong turns exit 2 into a permanent, content-free red.
//
// WHY THIS IS ITS OWN MODULE (WI-37830): the branch that forgives exit 2 runs ONLY when a
// task already failed, which on a healthy tree is never — so in-process it was reachable by
// no test and verifiable only by reading it. That is the same argument batch-watchdog.mjs
// and vitest-summary.mjs make for their own extraction: gate-PROTECTING logic must not be
// the code that never runs until the gate is already broken.
//
// Kept dependency-free ON PURPOSE. `affected-tests.mjs` is every agent's test-loop entry
// point and deliberately MIRRORS `EXIT_NOT_CHECKED` rather than importing the lint module
// that owns it, so that a load error in a lint module cannot hard-fail everyone's
// `test:affected`. Importing anything here would reintroduce exactly that coupling through
// the back door — hence `notCheckedExitCode` is a PARAMETER. It is passed in from the
// caller's existing mirror (already asserted equal to the real export by
// affected-tests-repo-wide-invariant-guards.test.ts), so this adds no third copy of the 2.

/**
 * @typedef {'pass' | 'not-checked' | 'undetermined' | 'quarantined' | 'failed'} TaskExitClass
 */

// A task that was estimated to take this long but ended almost immediately without
// producing any bytes likely never reached its test runner. These bounds are deliberately
// conservative: a short task with a stale estimate must not be silently reclassified, and
// any captured output is enough evidence that the child made observable progress.
const LONG_TASK_ESTIMATE_MS = 10 * 60 * 1000;
const VERY_SHORT_TASK_MS = 10 * 1000;

const FORK_STARVATION_OUTPUT =
  /\b(?:fork|spawn)\b[\s\S]{0,200}\b(?:eagain|resource temporarily unavailable)\b|\b(?:eagain|resource temporarily unavailable)\b[\s\S]{0,200}\b(?:fork|spawn)\b/i;

function hasForkStarvationEvidence(output) {
  return FORK_STARVATION_OUTPUT.test(output);
}

function hasConservativeNeverStartedEvidence({ capturedBytes, elapsedMs, durationEstimateMs }) {
  return (
    capturedBytes === 0 &&
    Number.isFinite(elapsedMs) &&
    elapsedMs >= 0 &&
    elapsedMs <= VERY_SHORT_TASK_MS &&
    Number.isFinite(durationEstimateMs) &&
    durationEstimateMs >= LONG_TASK_ESTIMATE_MS
  );
}

/**
 * Classify a finished task's exit status.
 *
 * Precedence is deliberate and mirrors the reporting order it replaced: "I could not look"
 * is decided BEFORE quarantine, so a non-gating guard reports the honest "examined nothing"
 * explanation rather than being absorbed into the vaguer quarantine bucket.
 *
 * @param {object} opts
 * @param {number | null | undefined} opts.status exit status of the task's process
 * @param {number} opts.notCheckedExitCode the caller's EXIT_NOT_CHECKED mirror
 * @param {boolean} [opts.notCheckedIsNonGating] does THIS task's registration forgive "I could not look"?
 * @param {boolean} [opts.quarantined] is this task quarantined?
 * @param {string} [opts.output] combined captured stdout/stderr
 * @param {string} [opts.stdout] captured stdout, when the caller keeps the streams separate
 * @param {string} [opts.stderr] captured stderr, when the caller keeps the streams separate
 * @param {number} [opts.capturedBytes] bytes captured from the child process
 * @param {number} [opts.elapsedMs] elapsed time before the child exited
 * @param {number} [opts.durationEstimateMs] historical duration estimate for this task
 * @returns {TaskExitClass}
 */
export function classifyTaskExit({
  status,
  notCheckedExitCode,
  notCheckedIsNonGating = false,
  quarantined = false,
  output,
  stdout,
  stderr,
  capturedBytes,
  elapsedMs,
  durationEstimateMs,
}) {
  if (status === 0) return 'pass';
  // A fork-starved child has not produced a trustworthy test verdict. This check intentionally
  // precedes the existing not-checked/quarantine buckets: an explicit process-launch failure
  // must remain visible as uncertainty even when another registration flag would otherwise
  // hide the non-zero exit.
  const capturedOutput = [output, stdout, stderr]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n');
  if (
    hasForkStarvationEvidence(capturedOutput) ||
    hasConservativeNeverStartedEvidence({ capturedBytes, elapsedMs, durationEstimateMs })
  ) {
    return 'undetermined';
  }
  // Only a task whose REGISTRATION opts in is forgiven. Without the flag, exit 2 stays a
  // failure — a guard that is not declared non-gating and could not look must still red the
  // run, or this helper would silently widen the forgiveness to every task in the repo.
  if (notCheckedIsNonGating && status === notCheckedExitCode) return 'not-checked';
  if (quarantined) return 'quarantined';
  return 'failed';
}

/**
 * Does this classification count against the run?
 *
 * The retry decision and the failure count must agree. They previously did not: the retry
 * branch tested `status !== 0 && !isQuarantined` and so re-ran a task the very same run was
 * about to classify non-gating four branches later — printing a WORKSPACE-shaped
 * "<workspace> FAILED — retrying once" for what was one guard reporting that it examined
 * nothing (EI-20107132436867486). Routing both decisions through one predicate is what
 * keeps them from drifting apart again.
 *
 * @param {TaskExitClass} cls
 * @returns {boolean}
 */
export function isGatingFailure(cls) {
  return cls === 'failed';
}
