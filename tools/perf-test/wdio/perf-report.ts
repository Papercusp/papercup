/**
 * Measure collection for the packaged-binary perf runner.
 *
 * WHY THIS EXISTS (perf-testing-sweep-2026-07-27, WI-6538 / WI-6535):
 * `harness_shared.desktop_perf_runs` was EMPTY from the day the desktop-perf
 * suite landed (2026-07-20), which made the desktop-perf release gate
 * structurally incapable of firing — `desktop-perf-gate.ts` looks for the latest
 * run, finds none, and takes its fail-soft `pass` branch. Every deploy therefore
 * cleared a perf gate that had never measured anything.
 *
 * The specs in this runner DID measure real interactions; they just `console.log`ged
 * the numbers and threw them away. This module is the collection half that lets a
 * run persist them (the wdio.conf.ts `onComplete` hook POSTs them to the operator's
 * ingest route, which wraps the same `recordDesktopPerfRun` the in-app admin suite
 * uses — one writer, one schema, one trend).
 *
 * WHY A FILE AND NOT AN IN-MEMORY ARRAY:
 * wdio's `local` runner FORKS a separate child process per spec file, while
 * `onPrepare`/`onComplete` run in the LAUNCHER process (see the long note on
 * `resolveDriverPort` in wdio.conf.ts — the same process boundary bit that fix
 * too). A module-scoped array written by a spec is invisible to `onComplete`:
 * different process, different memory. The measures must cross that boundary on
 * disk.
 *
 * WHY JSONL AND NOT A JSON ARRAY:
 * appending one self-contained line per measure is a single O_APPEND write with no
 * read-modify-write step, so concurrent spec workers cannot clobber each other's
 * measures (`maxInstances` is 1 today, but that is a tuning knob, not a guarantee).
 * It also degrades safely: a worker killed mid-write leaves one unparseable
 * trailing line, which `readMeasures` skips, instead of corrupting the whole file.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

/** Mirrors `DesktopPerfMetricUnit` in packages/operator-core/lib/admin-test-suites-shared.ts. */
export type PerfMeasureUnit = "ms" | "kb" | "count";

/** Mirrors `DesktopPerfMeasure` — the exact shape the ingest route validates. */
export interface PerfMeasure {
  /** Stable metric key, e.g. 'interaction:command-palette-open'. */
  key: string;
  value: number;
  unit: PerfMeasureUnit;
  /** null for an unbudgeted metric — recorded, never a failure. */
  budget: number | null;
  ok: boolean;
  /**
   * Binary correctness invariant rather than a tunable budget: a breach BLOCKS the
   * release gate even though ordinary budget regressions only warn
   * (no-http-anywhere-2026-07-28 P-003c). Prefer {@link recordInvariant}.
   */
  invariant?: boolean;
}

const RESULTS_DIR = path.resolve(__dirname, "results");
const MEASURES_PATH = path.join(RESULTS_DIR, "measures.jsonl");

export { MEASURES_PATH };

/**
 * Record one measured interaction.
 *
 * CALL THIS BEFORE THE BUDGET ASSERTS, NEVER AFTER. `expect(...)` throws on a
 * breach, so a call placed after the asserts records only PASSING measures — and
 * a breach is precisely the observation the release gate exists to catch. Recording
 * first means a failing run still posts its evidence and the gate can act on it.
 *
 * Never throws: a reporting failure must not turn a healthy perf run red. A write
 * that fails is logged and dropped (the run's log still carries the `[perf]` lines).
 */
export function recordMeasure(measure: PerfMeasure): void {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    appendFileSync(MEASURES_PATH, `${JSON.stringify(measure)}\n`, "utf8");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[perf-report] could not record ${measure.key}:`, err);
  }
}

/**
 * Convenience wrapper for the common `ms`-against-a-budget case: derives `ok` and
 * emits the same `[perf]` log line the specs used to write by hand, so the run log
 * keeps reading identically.
 *
 * `value` is `number | null` because `latestMeasure()` returns null when the
 * interaction produced no `performance.measure` entry. A null is deliberately NOT
 * recorded: "the interaction never reported" is a suite/instrumentation failure
 * (the spec's own `expect(...).not.toBeNull()` catches it), not a slow interaction,
 * and inventing a 0ms or budget-breaching row would put a fabricated number into
 * the trend the gate reads.
 */
export function recordInteractionMs(
  name: string,
  value: number | null,
  budgetMs: number,
): void {
  // eslint-disable-next-line no-console
  console.log(`[perf] ${name} = ${value}ms (budget ${budgetMs}ms)`);
  if (value === null || !Number.isFinite(value)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[perf-report] ${name} produced no measure — not recorded (an absent measure is an instrumentation failure, not a timing)`,
    );
    return;
  }
  recordMeasure({
    key: `interaction:${name}`,
    value,
    unit: "ms",
    budget: budgetMs,
    ok: value <= budgetMs,
  });
}

/**
 * Record a binary CORRECTNESS INVARIANT — a property that must hold exactly, whose
 * breach blocks the release gate outright (no-http-anywhere-2026-07-28 P-003c).
 *
 * Use this instead of {@link recordMeasure} when the number is not a tunable
 * threshold but a count that must equal `mustEqual` (default 0): escaped HTTP
 * requests, unhandled console errors, leaked listeners. Do NOT use it for a timing
 * budget — those are load-sensitive, and blocking the fleet's deploys on a number
 * that moves with machine load is exactly what the gate's warn-only default exists
 * to prevent.
 *
 * Like `recordInteractionMs`, CALL THIS BEFORE THE ASSERTS. A breach is precisely
 * the observation the gate exists to act on, so it has to be recorded on the path
 * that is about to throw.
 */
export function recordInvariant(
  name: string,
  value: number,
  mustEqual = 0,
): void {
  const held = value === mustEqual;
  // eslint-disable-next-line no-console
  console.log(`[perf] invariant ${name} = ${value} (must be ${mustEqual})${held ? "" : " ← BREACH"}`);
  recordMeasure({
    key: `invariant:${name}`,
    value,
    unit: "count",
    budget: mustEqual,
    ok: held,
    invariant: true,
  });
}

/**
 * Discard any measures on disk. Called from `onPrepare` so a file left behind by a
 * previously CRASHED run (one that died before `onComplete` could consume and clear
 * it) is never posted as if it were this run's data — that would report stale
 * timings against the current commit, which is worse than reporting none.
 */
export function resetMeasures(): void {
  try {
    rmSync(MEASURES_PATH, { force: true });
  } catch {
    /* nothing recorded yet, or already gone */
  }
}

/** Read every recorded measure, skipping any unparseable (partially-written) line. */
export function readMeasures(): PerfMeasure[] {
  if (!existsSync(MEASURES_PATH)) return [];
  const measures: PerfMeasure[] = [];
  for (const line of readFileSync(MEASURES_PATH, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      measures.push(JSON.parse(trimmed) as PerfMeasure);
    } catch {
      // eslint-disable-next-line no-console
      console.warn("[perf-report] skipping unparseable measure line");
    }
  }
  return measures;
}
