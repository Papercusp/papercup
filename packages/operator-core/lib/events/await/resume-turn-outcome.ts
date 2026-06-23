/**
 * Resume-turn outcome — observe + classify the EXIT of a detached headless resume
 * turn (loop-wake-rate-limit-robustness-2026-06-23 P0a).
 *
 * THE GAP THIS CLOSES (agent-insights/loop-wake-turn-deaths-recorded-as-delivered):
 * `executeWake`'s `resume-headless` channel runs `claude --resume <uuid> -p` DETACHED
 * with `stdio:'ignore'` and returns `{ kind:'delivered' }` the instant a PID is
 * assigned — on SPAWN success, not TURN success. A turn that 429s seconds-to-minutes
 * later dies into `/dev/null`: the in-process RateLimitGovernor never sees it (the
 * subprocess draws from Claude Code's OWN CLI transport bucket), and for a LOOP wake
 * the failure-streak circuit never opens, so the loop keeps firing empty wakes into a
 * rate-limited void. This module is the PURE half: given the eventual exit (code +
 * signal + bounded output tails captured by wake-executor), classify it into
 * survived-vs-died, reusing the shared turn-error taxonomy — NO ad-hoc 429 matching.
 *
 * The IMPURE halves live elsewhere (the layering keeps this file pure + unit-testable):
 *  - wake-executor.ts captures the tails + fires `onResumeTurnExit(d, raw)` on close.
 *  - harness/routines/loop-turn-outcome.ts is the registered handler that classifies
 *    a LOOP-sourced death via this function and feeds the autoloop circuit + 429-aware
 *    re-arm (P0b/P1a).
 */

import { classifySubprocessResult, type TurnError } from '@papercusp/papercusp-shared/agent';

/**
 * The raw exit observation of a detached `resume-headless` turn — the exit code +
 * signal + the BOUNDED stdout/stderr tails wake-executor captured from the subprocess.
 * Forwarded verbatim to `onResumeTurnExit`; classified by `classifyResumeTurnExit`.
 */
export interface ResumeTurnExitRaw {
  /** The subprocess exit code (null when killed by a signal). */
  exitCode: number | null;
  /** The killing signal name (null when it exited normally). */
  signal: NodeJS.Signals | string | null;
  /** The last N bytes of stdout (the CLIs print API errors — incl. 429 — to STDOUT). */
  stdoutTail: string;
  /** The last N bytes of stderr. */
  stderrTail: string;
}

/** Survived (the turn ran to completion) vs died (with the classified failure). */
export type ResumeTurnOutcome = { ok: true } | { ok: false; error: TurnError };

/**
 * Classify a detached resume turn's exit into survived-vs-died (P0a).
 *
 * A clean exit (code 0, no signal) IS success — the `claude --resume … -p` turn ran
 * its one turn and exited, leaving the session updated for the next wake. We do NOT
 * route a clean exit through `classifySubprocessResult`: that helper reads
 * exit-0-with-no-captured-stdout as `empty_output` (a failure), but here we capture
 * only a bounded tail (not the transcript), so a clean exit must be read as success
 * regardless of what the tail holds.
 *
 * A non-zero / signalled exit is a DEATH — classify it with the shared subprocess
 * taxonomy. The claude/codex CLIs print API errors (rate limit / usage limit / overload
 * / auth) to STDOUT (not stderr — see turn-error.ts), so both tails are passed and the
 * classifier folds stdout into its scan on a failed exit. The provider is always
 * `anthropic` (a resume turn is always a claude-code session).
 */
export function classifyResumeTurnExit(raw: ResumeTurnExitRaw, now: number = Date.now()): ResumeTurnOutcome {
  if (raw.exitCode === 0 && !raw.signal) return { ok: true };
  const error = classifySubprocessResult(
    {
      exitCode: raw.exitCode,
      signal: raw.signal ?? null,
      stderr: raw.stderrTail,
      stdout: raw.stdoutTail,
    },
    'anthropic',
    now,
  );
  return { ok: false, error };
}

/** Is this a transient rate-limit / plan-cap death — the class that warrants a
 *  retry-after-aware loop re-arm (P1a) rather than the blind interval? */
export function isRateLimitDeath(outcome: ResumeTurnOutcome): boolean {
  return !outcome.ok && (outcome.error.class === 'rate_limited' || outcome.error.class === 'usage_limit');
}
