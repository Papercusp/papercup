/**
 * Detects when a background job's OWN captured exit-code marker (an
 * `EXIT=<n>` / `SOMETHING_EXIT=<n>` line the command's own redirect idiom
 * wrote into its log) disagrees with the `exit_code` `capability:bash_output`
 * is about to report.
 *
 * WHY (EI-21852949719867845, filed 2026-08-30)
 * ─────────────────────────────────────────────
 * `capability:bash`'s own advice recommends recovering a buffered pipeline
 * with `cmd > /tmp/job.log 2>&1; echo "EXIT=$?" >> /tmp/job.log` (see
 * `formatBufferingPipelineAdvice` in `./bash-jobs`) — and agents independently
 * reach for the same `cmd; echo "MY_EXIT=$?"` shape to capture a verdict from
 * a job that pipes through something the tool can't otherwise summarize. But a
 * shell's reported exit status is always the LAST command's, so that idiom
 * makes the *reported* `exit_code` describe the `echo`, not `cmd` — an agent
 * who trusts `exit_code` alone ships a red run as green. This module only
 * DETECTS the divergence after the fact, from the log the job itself wrote;
 * `formatBufferingPipelineAdvice`'s redirect example was separately corrected
 * to stop teaching the trap at launch time.
 *
 * Deliberately narrow: it fires only when the job has actually finished, its
 * `exit_code` is known, AND the log carries a captured-exit marker line that
 * disagrees with it. A job with no such marker (the overwhelming majority)
 * gets no verdict at all — there is nothing here to compare against, and
 * inventing one would be a false alarm in the alarm.
 */

/** Matches a whole log line shaped like `EXIT=1` or `AFFECTED_EXIT=137`. */
const CAPTURED_EXIT_RE = /^[ \t]*[A-Za-z_]*EXIT=(-?\d+)[ \t]*$/gm;

/** The LAST captured-exit marker line in the log, or `null` if there is none. */
function lastCapturedExit(log: string): number | null {
  CAPTURED_EXIT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: number | null = null;
  while ((match = CAPTURED_EXIT_RE.exec(log)) !== null) {
    const parsed = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(parsed)) last = parsed;
  }
  return last;
}

/**
 * The mismatch verdict for a finished background job, or `null` when there is
 * nothing to say: the job is still running, its `exit_code` is unknown, the
 * log carries no captured-exit marker, or the marker agrees with `exit_code`.
 */
export function capturedExitMismatch(job: {
  status: string;
  exitCode: number | null;
  log: string;
}): { headline: string; advice: string } | null {
  if (job.status === 'running') return null;
  if (job.exitCode === null) return null;
  const captured = lastCapturedExit(job.log);
  if (captured === null || captured === job.exitCode) return null;
  return {
    headline: `exit_code (${job.exitCode}) disagrees with a captured EXIT marker in the log (${captured})`,
    advice:
      `This job's reported exit_code (${job.exitCode}) is the shell's LAST command's status, which the log's ` +
      `own captured marker shows disagrees with the real run (${captured}). This usually means the command ends ` +
      `in \`echo\`/\`printf\` after capturing \`$?\` (e.g. \`cmd; echo "EXIT=$?"\`) — the echo's own exit status ` +
      `(always 0) overwrites the shell's reported status the wrapper reads. Trust the log's captured marker ` +
      `(${captured}) as this job's real verdict, not exit_code. For a rerun, capture the status BEFORE printing ` +
      `it and re-exit it, e.g. \`cmd > /tmp/job.log 2>&1; rc=$?; echo "EXIT=$rc" >> /tmp/job.log; exit $rc\`.`,
  };
}
