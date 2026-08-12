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

// Vitest's per-file rollup rows are the only output that proves a file completed.
// Do not count arbitrary `.test.ts` mentions: failure details, stack traces, and
// reporter metadata mention paths too, but none of those establish forward progress.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const COMPLETED_FILE_ROW_RE = /^\s*[✓❯]\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\([^)]*\)\s+(\d+(?:\.\d+)?)ms\s*$/;
const TOTAL_FILES_RE = /^\s*Test Files\b.*\((\d+)\)\s*$/m;

/**
 * Parse the progress evidence available in a captured Vitest report.
 *
 * This intentionally returns an "observed" signal, not a claim that the child
 * was advancing at the instant it was killed: `spawnSync` only gives this parent
 * the captured bytes after the native wait ends, so those bytes have no timestamps.
 * A caller with a live stream may pass `lastProgressAgeMs` to
 * `classifyBatchProgress` when it has that stronger evidence.
 *
 * @param {string | null | undefined} output captured child output; null means it was streamed
 * @param {{ totalFiles?: number }} [opts]
 * @returns {{ available: boolean, completedFiles: number, totalFiles: number | null,
 *   completedFilePaths: string[], lastCompletedFile: string | null, lastDurationMs: number | null,
 *   completionRows: number }}
 */
export function parseBatchProgress(output, { totalFiles } = {}) {
  const suppliedTotal = Number.isInteger(totalFiles) && totalFiles > 0 ? totalFiles : null;
  if (typeof output !== 'string') {
    return {
      available: false,
      completedFiles: 0,
      totalFiles: suppliedTotal,
      completedFilePaths: [],
      lastCompletedFile: null,
      lastDurationMs: null,
      completionRows: 0,
    };
  }

  const paths = new Set();
  let lastCompletedFile = null;
  let lastDurationMs = null;
  let completionRows = 0;
  for (const line of output.replace(ANSI_RE, '').split(/\r?\n/)) {
    const match = COMPLETED_FILE_ROW_RE.exec(line);
    if (!match) continue;
    completionRows += 1;
    paths.add(match[1]);
    lastCompletedFile = match[1];
    lastDurationMs = Number(match[2]);
  }

  const summaryTotal = TOTAL_FILES_RE.exec(output.replace(ANSI_RE, ''));
  const reportedTotal = summaryTotal ? Number(summaryTotal[1]) : null;
  return {
    available: true,
    completedFiles: paths.size,
    totalFiles: suppliedTotal ?? (Number.isInteger(reportedTotal) && reportedTotal > 0 ? reportedTotal : null),
    completedFilePaths: [...paths],
    lastCompletedFile,
    lastDurationMs,
    completionRows,
  };
}

/**
 * Classify progress without upgrading weak evidence into a spin diagnosis.
 *
 * `lastProgressAgeMs` is optional because the current synchronous capture path
 * cannot measure it. Only an explicitly stale live-stream reading earns the
 * `stalled` classification; a captured report is merely observed or unknown.
 *
 * @param {{ available: boolean, completedFiles: number }} progress
 * @param {{ lastProgressAgeMs?: number, staleAfterMs?: number }} [opts]
 * @returns {'unknown' | 'no-progress-observed' | 'progress-observed' | 'advancing' | 'stalled'}
 */
export function classifyBatchProgress(progress, { lastProgressAgeMs, staleAfterMs = 10_000 } = {}) {
  if (!progress?.available) return 'unknown';
  if (Number.isFinite(lastProgressAgeMs)) {
    return lastProgressAgeMs > staleAfterMs ? 'stalled' : 'advancing';
  }
  return progress.completedFiles > 0 ? 'progress-observed' : 'no-progress-observed';
}

/**
 * Render the evidence for a watchdog diagnostic. The wording is deliberately
 * conservative when output timing is unavailable: it never tells a triager to
 * hunt a spinning test based on a path mention or on an empty capture alone.
 *
 * @param {{ available: boolean, completedFiles: number, totalFiles: number | null }} progress
 * @param {ReturnType<typeof classifyBatchProgress>} classification
 * @returns {string}
 */
export function formatBatchProgress(progress, classification = classifyBatchProgress(progress)) {
  if (!progress?.available) return 'progress UNKNOWN (output was streamed, not captured)';
  const count = progress.totalFiles ? `${progress.completedFiles}/${progress.totalFiles}` : `${progress.completedFiles}`;
  if (classification === 'advancing') return `${count} test file(s) done; progress still advancing`;
  if (classification === 'stalled') return `${count} test file(s) done; progress stopped (spin is now a supported hypothesis)`;
  if (classification === 'no-progress-observed') {
    return `no completed test-file rows observed (capture has no timing; cannot infer a spin)`;
  }
  return `${count} test file(s) done; completion rows observed, but capture has no timing (do not infer a spin)`;
}
