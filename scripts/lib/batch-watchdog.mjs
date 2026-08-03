// batch-watchdog.mjs — the pure decision logic behind the per-batch process-level
// watchdog `scripts/affected-tests.mjs` applies to every workspace's test spawn
// (EI-19370814345784324).
//
// A test that blocks its vitest worker's event loop SYNCHRONOUSLY (a tight
// `mkdirSync` ENOENT/EEXIST spin was the observed case) makes vitest's own
// `testTimeout` unable to fire — that timeout is a timer on the very event loop
// the spin never yields, so the one bound that looks like it covers this is
// structurally incapable of firing. Measured 2026-08-02: a single wedged worker
// held the green-checkpoint gate (and every fleet deploy behind it) for 74
// minutes before being found and killed by hand.
//
// The fix has to live in the PARENT process, not the child's: `spawnSync`'s
// `timeout` option is enforced by the native wait loop around the child (libuv),
// NOT a JS timer on either process's event loop — so it fires even while the
// child is synchronously spinning and the parent is itself blocked waiting on
// it. This module is only the decision of whether a given `spawnSync` result
// WAS that watchdog firing, extracted so it is unit-testable with real object
// inputs instead of only a source-text regex assertion (which cannot catch a
// runtime fault on a path that, by construction, only ever runs once the gate
// is already red — see vitest-summary.mjs's own header for the same argument).

/**
 * Resolve the per-batch timeout in ms: an explicit positive override, or the
 * default. Deliberately generous relative to a normal suite run but well below
 * the ~120-minute green-checkpoint gate ceiling this exists to protect.
 *
 * @param {string | undefined} envValue raw `AFFECTED_BATCH_TIMEOUT_MS` value
 * @param {number} defaultMs fallback when unset / not a positive number
 * @returns {number}
 */
export function resolveBatchTimeoutMs(envValue, defaultMs) {
  const n = envValue ? Number(envValue) : NaN;
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

/**
 * Did THIS `spawnSync` result come from our own batch-level watchdog kill,
 * rather than the child's own normal exit or an unrelated external signal
 * (an operator's manual kill, the kernel OOM killer — both can also send
 * SIGKILL)? `signal === killSignal` alone is ambiguous; requiring the elapsed
 * wall-clock to have essentially cleared the configured window is what makes
 * the attribution positive rather than a guess.
 *
 * @param {{ signal: string | null, status: number | null, elapsedMs: number }} result
 * @param {{ killSignal: string, timeoutMs: number, slackMs?: number }} opts
 * @returns {boolean}
 */
export function isWatchdogTimeout(result, { killSignal, timeoutMs, slackMs = 2000 }) {
  return (
    result.signal === killSignal &&
    result.status === null &&
    (result.elapsedMs ?? 0) >= timeoutMs - slackMs
  );
}
