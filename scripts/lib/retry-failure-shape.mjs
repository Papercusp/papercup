// Retry gating on FAILURE SHAPE (plan gate-latency-selection-and-retry-policy-2026-09-06, P-003).
//
// `scripts/affected-tests.mjs` re-runs a failed workspace once under AFFECTED_RETRY_FAILED=1 to
// absorb LOAD FLAKES — the 2026-06-06 class where single-test timeouts held green `main` back
// for hours while an identification re-run passed 8867/8867. That retry used to fire on ANY
// gating failure, regardless of what the failure looked like. Measured 2026-09-05 (gate run
// e70cd139): 36 operator-core files failed on deterministic assertion diffs, the retry re-ran
// the whole workspace serially, reproduced the identical result, and cost 34 minutes of a
// 2h28m gate for no new information.
//
// This module decides, from the first pass's own output, whether a second pass CAN answer
// anything. It is pure and unit-tested; the runner only reads `decision.retry`/`mode`.
//
// The rule, in the fail-safe direction for the property the retry protects (never let a
// genuine load flake hold the gate red):
//   • a FLAKE-CLASS signature anywhere in the output ⇒ retry (fresh-process on the failed
//     files when ≤ maxFiles, else the whole workspace exactly as before);
//   • no flake signature, but a TINY failed set (≤ smallRedFiles) ⇒ retry the files anyway —
//     seconds of cost, and small reds are where an unrecognised flake shape is most likely;
//   • no flake signature and a BROAD deterministic red ⇒ skip. A second identical pass over an
//     assertion diff is not evidence, and past `maxFiles` the code already called it "a real
//     regression, not a flake" — it just kept re-running it.
//   • nothing parseable (no failed files) ⇒ retry the workspace as before: an unattributable
//     failure is an infrastructure shape until proven otherwise.

/**
 * Signatures of the failure classes a fresh-process re-run can plausibly absorb. Each is named
 * so the log line says WHICH class earned the retry — a reader can then judge whether the
 * absorption was legitimate.
 */
export const RETRY_FLAKE_CLASSES = Object.freeze([
  {
    id: "test-timeout",
    re: /\b(?:Test|Hook) timed out in \d+ms\b|\btimed out (?:after|in) \d+\s*ms\b|Timeout - Async callback/i,
  },
  {
    id: "connection",
    re: /\bECONNRESET\b|\bECONNREFUSED\b|\bEPIPE\b|socket hang up|Connection terminated unexpectedly|\bETIMEDOUT\b/i,
  },
  { id: "port-conflict", re: /\bEADDRINUSE\b/ },
  {
    id: "late-console",
    // vitest-fail-on-console: a co-resident file's late output lands in the next file's
    // assertion window (HARDEN-GATE's "cross-file state poisoning" class).
    re: /Expected test not to call console\.|vitest-fail-on-console|fail-on-console/i,
  },
  {
    id: "worker-crash",
    re: /Worker exited unexpectedly|JavaScript heap out of memory|FATAL ERROR: |\bSIG(?:KILL|SEGV|ABRT)\b|Segmentation fault|ERR_IPC_CHANNEL_CLOSED|Channel closed|Worker terminated due to reaching memory limit/i,
  },
  {
    id: "transform-race",
    // A peer's mid-edit transform error on the shared tree (the other HARDEN-GATE class): the
    // module graph the first pass loaded no longer exists by the time anyone looks.
    re: /Transform failed with \d+ error|Failed to resolve import|Failed to load url|ENOENT: no such file or directory, open '[^']*\.(?:ts|tsx|mts|js|mjs)'/i,
  },
]);

/** Below this many failed files a retry costs seconds; above `maxFiles` it costs the suite. */
export const RETRY_SMALL_RED_FILES = 3;

/**
 * Which flake classes appear in the captured output.
 *
 * @param {string} output
 * @returns {string[]} class ids, in RETRY_FLAKE_CLASSES order
 */
export function matchRetryFlakeClasses(output) {
  const text = typeof output === "string" ? output : "";
  if (!text) return [];
  return RETRY_FLAKE_CLASSES.filter(({ re }) => re.test(text)).map(({ id }) => id);
}

/**
 * Decide whether — and how — to retry a failed task.
 *
 * @param {object}   o
 * @param {string[]} o.failedFiles      files the first pass's vitest summary named (may be empty)
 * @param {string}   o.output           the first pass's captured stdout+stderr
 * @param {number}   o.maxFiles         FRESH_RETRY_MAX_FILES — the fresh-process file cap
 * @param {number}   [o.smallRedFiles]  RETRY_SMALL_RED_FILES override
 * @returns {{
 *   retry: boolean,
 *   mode: 'fresh-files' | 'whole-workspace' | 'none',
 *   reason: string,
 *   flakeClasses: string[],
 *   failedFileCount: number,
 * }}
 */
export function decideRetry({
  failedFiles,
  output,
  maxFiles,
  smallRedFiles = RETRY_SMALL_RED_FILES,
}) {
  const files = Array.isArray(failedFiles) ? failedFiles : [];
  const flakeClasses = matchRetryFlakeClasses(output);
  const failedFileCount = files.length;
  const base = { flakeClasses, failedFileCount };

  if (failedFileCount === 0) {
    // Nothing parsed: a non-vitest failure mode (spawn error, collection crash, a guard).
    // The shape is unknown, so this stays the conservative whole-workspace retry.
    return {
      ...base,
      retry: true,
      mode: "whole-workspace",
      reason: "unattributed-failure",
    };
  }
  if (flakeClasses.length > 0) {
    return failedFileCount <= maxFiles
      ? { ...base, retry: true, mode: "fresh-files", reason: `flake-class:${flakeClasses.join("+")}` }
      : {
          ...base,
          retry: true,
          mode: "whole-workspace",
          reason: `flake-class:${flakeClasses.join("+")}(broad)`,
        };
  }
  if (failedFileCount <= smallRedFiles) {
    return { ...base, retry: true, mode: "fresh-files", reason: `small-red(${failedFileCount}<=${smallRedFiles})` };
  }
  return {
    ...base,
    retry: false,
    mode: "none",
    reason:
      failedFileCount > maxFiles
        ? `broad-deterministic-red(${failedFileCount}>${maxFiles})`
        : `deterministic-shape(${failedFileCount} file(s), no flake signature)`,
  };
}

/**
 * The single greppable line the runner emits for every retry decision.
 *
 * @param {string} workspace
 * @param {ReturnType<typeof decideRetry>} decision
 */
export function formatRetryDecisionLine(workspace, decision) {
  const tag = decision.retry ? "AFFECTED_RETRY_DECISION" : "AFFECTED_RETRY_SKIPPED";
  return (
    `${tag} ws=${workspace} retry=${decision.retry ? 1 : 0} mode=${decision.mode} ` +
    `failedFiles=${decision.failedFileCount} flakeClasses=${decision.flakeClasses.join(",") || "none"} ` +
    `reason=${decision.reason}`
  );
}

// ── P-004: the retry BUDGET ──────────────────────────────────────────────────────────────────
//
// A retry used to inherit the first pass's watchdog: the history-derived bound, floored at 45
// minutes and capped at 90. That bound exists to catch a synchronously-spinning worker in a
// FULL suite; a retry is a re-run of something the runner has just measured, so it has a far
// better estimate than the floor — the first pass's own elapsed time and the task's duration
// history. The budget below is derived from those, given headroom, and CAPPED so that a retry
// can never again spend the 34 minutes gate run e70cd139 spent re-running a whole workspace.
//
// Fail-safe direction (the property the retry protects is "a genuine load flake must not hold
// the gate red"): with NO reference at all the budget is the CAP, not the floor — a task of
// unknown duration killed at 60s would turn a flake into a red, which is the wrong error.

/** No retry, however short its reference, gets less than this. */
export const RETRY_BUDGET_FLOOR_MS = 60_000;
/** No retry, however long its reference, gets more than this (e70cd139's retry took 34m). */
export const RETRY_BUDGET_CAP_MS = 20 * 60_000;
/** Headroom over the reference: a re-run under load may legitimately take longer than pass 1. */
export const RETRY_BUDGET_HEADROOM = 2;

const finitePositive = (n) => (Number.isFinite(n) && n > 0 ? Number(n) : null);

/**
 * Derive the time budget for one task's retry.
 *
 * @param {object} o
 * @param {number|null|undefined} o.firstPassElapsedMs   `__elapsedMs` of the failed first pass
 * @param {number|null|undefined} o.durationEstimateMs  `__durationEstimateMs` — the task's history
 * @param {number} [o.floorMs]
 * @param {number} [o.capMs]
 * @param {number} [o.headroomMultiplier]
 * @returns {{
 *   budgetMs: number,
 *   source: 'reference' | 'floor' | 'cap' | 'cap-no-reference',
 *   referenceMs: number | null,
 *   referenceSource: 'history' | 'first-pass' | 'none',
 *   firstPassElapsedMs: number | null,
 *   durationEstimateMs: number | null,
 *   floorMs: number,
 *   capMs: number,
 *   headroomMultiplier: number,
 * }}
 */
export function deriveRetryBudget({
  firstPassElapsedMs,
  durationEstimateMs,
  floorMs = RETRY_BUDGET_FLOOR_MS,
  capMs = RETRY_BUDGET_CAP_MS,
  headroomMultiplier = RETRY_BUDGET_HEADROOM,
}) {
  if (!Number.isFinite(floorMs) || floorMs <= 0) {
    throw new TypeError("floorMs must be a positive finite number");
  }
  if (!Number.isFinite(capMs) || capMs < floorMs) {
    throw new TypeError("capMs must be a finite number greater than or equal to floorMs");
  }
  if (!Number.isFinite(headroomMultiplier) || headroomMultiplier < 1) {
    throw new TypeError("headroomMultiplier must be a finite number greater than or equal to 1");
  }
  const first = finitePositive(firstPassElapsedMs);
  const history = finitePositive(durationEstimateMs);
  const base = {
    firstPassElapsedMs: first,
    durationEstimateMs: history,
    floorMs,
    capMs,
    headroomMultiplier,
  };
  // The LARGER of the two references: history is a peak-aware estimate that already absorbed
  // the task's bimodal runs, and the first pass is what this very box just measured. Taking
  // the smaller would trust whichever of them happened to be optimistic.
  let referenceMs = null;
  let referenceSource = "none";
  if (history != null && (first == null || history >= first)) {
    referenceMs = history;
    referenceSource = "history";
  } else if (first != null) {
    referenceMs = first;
    referenceSource = "first-pass";
  }
  if (referenceMs == null) {
    return { ...base, budgetMs: capMs, source: "cap-no-reference", referenceMs, referenceSource };
  }
  const raw = referenceMs * headroomMultiplier;
  const budgetMs = Math.min(capMs, Math.max(floorMs, raw));
  const source = raw > capMs ? "cap" : raw < floorMs ? "floor" : "reference";
  return { ...base, budgetMs, source, referenceMs, referenceSource };
}

/**
 * The greppable line the runner emits for every retry it actually schedules.
 *
 * @param {string} workspace
 * @param {ReturnType<typeof deriveRetryBudget>} budget
 */
export function formatRetryBudgetLine(workspace, budget) {
  return (
    `AFFECTED_RETRY_BUDGET ws=${workspace} budgetMs=${budget.budgetMs} source=${budget.source} ` +
    `referenceMs=${budget.referenceMs ?? "unknown"} referenceSource=${budget.referenceSource} ` +
    `firstPassMs=${budget.firstPassElapsedMs ?? "unknown"} ` +
    `durationEstimateMs=${budget.durationEstimateMs ?? "unknown"} ` +
    `floorMs=${budget.floorMs} capMs=${budget.capMs}`
  );
}

/**
 * The retry POOL's bracketing lines. Retries used to run one at a time, each through its own
 * single-task scheduler pool that assumed the whole worker budget; they now run through ONE
 * pool under the same allocation model as the initial pass, and these two lines bound the
 * stretch in the log so its wall time is attributable.
 *
 * @param {{ phase: 'start' | 'done' | 'aborted', tasks: number, budgetSumMs?: number,
 *   wallMs?: number, settled?: number, detail?: string }} o
 */
export function formatRetryPoolLine({ phase, tasks, budgetSumMs, wallMs, settled, detail }) {
  const parts = [`AFFECTED_RETRY_POOL phase=${phase} tasks=${tasks}`];
  if (Number.isFinite(budgetSumMs)) parts.push(`budgetSumMs=${Math.round(budgetSumMs)}`);
  if (Number.isFinite(wallMs)) parts.push(`wallMs=${Math.round(wallMs)}`);
  if (Number.isFinite(settled)) parts.push(`settled=${settled}`);
  if (detail) parts.push(`detail=${JSON.stringify(detail)}`);
  return parts.join(" ");
}
