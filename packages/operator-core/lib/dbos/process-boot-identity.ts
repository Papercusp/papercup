/**
 * Process boot identity for DBOS-owned watchdogs.
 *
 * This module is eagerly imported by `dbos/bootstrap.ts`, which is loaded while
 * the host is starting. The watchdog itself is intentionally lazy (it is
 * imported from the first `routinesTick`), so keeping these values there would
 * make a delayed first tick look like process boot and would sample the
 * checkout HEAD after the process had already been running.
 *
 * The wall-clock boot instant comes from `process.uptime()` rather than module
 * evaluation time. The commit lookup starts at module evaluation and is
 * memoized for the process lifetime, preserving the earliest stable bootstrap
 * seam while remaining fail-soft when the host is not a git checkout.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

let pexec: ((...args: any[]) => Promise<any>) | undefined;
const runExecFile = (...args: any[]) => (pexec ??= promisify(execFile) as any)(...args);

/** Best-effort current checkout HEAD resolver shared by boot and refresh reads. */
export async function resolveCurrentHeadCommit(): Promise<string | null> {
  try {
    const { stdout } = await runExecFile('git', ['rev-parse', 'HEAD'], { timeout: 5_000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    // Packaged hosts and non-checkout processes have no readable git HEAD.
    // Watchdogs must fail safe rather than turning that into a false alarm.
    return null;
  }
}

/**
 * Best-effort "how far behind is `bootCommit`?" — the COUNT of commits on
 * `currentCommit` that `bootCommit` does not have.
 *
 * Why a count and not a curated path filter: the stale-executor alarm used to
 * quantify only TIME ("has run 2h"), which reads as mild — the measured
 * 2026-08-30 incident was 2h of uptime but **109 commits** of code drift, and
 * the hours figure is what a reader anchors on. Magnitude is the actionable
 * number, so it belongs in the page.
 *
 * Deliberately NOT narrowed to a hand-listed set of "routine code" paths. A
 * curated directory list is a to-do list, not a detector: it has to be edited
 * every time code moves, and it silently under-reports until someone
 * remembers to (the exact defect class WI-1371132 removed from the
 * model-policy importer guard). A routines executor tsx-loads the WHOLE tree
 * at boot, so every commit since boot is genuinely code it is not running —
 * the uncurated total is both the honest number and the one that cannot rot.
 *
 * Fail-safe: returns null on anything unexpected (shallow clone, unrelated
 * histories, missing object, non-checkout host) so the caller degrades to its
 * pre-existing text rather than printing a wrong or fabricated magnitude.
 */
export async function resolveCommitsBehind(
  bootCommit: string | null,
  currentCommit: string | null,
): Promise<number | null> {
  const sha = /^[0-9a-f]{40}$/i;
  // Validate before interpolating into argv: these reach `git` as a revision
  // range, and an unvalidated value is how a range turns into an option.
  if (!bootCommit || !currentCommit || !sha.test(bootCommit) || !sha.test(currentCommit)) return null;
  if (bootCommit === currentCommit) return 0;
  try {
    const { stdout } = await runExecFile('git', ['rev-list', '--count', `${bootCommit}..${currentCommit}`], {
      timeout: 5_000,
    });
    const n = Number(stdout.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export interface ProcessBootIdentity {
  /** Wall-clock instant at which the process started (milliseconds). */
  bootTimeMs: number;
  /** Commit sampled at the bootstrap seam, memoized for this process. */
  bootCommit: Promise<string | null>;
}

/** Capture the two process-identity values together at one eager seam. */
export function captureProcessBootIdentity(opts: {
  nowMs?: number;
  uptimeSec?: number;
  resolveCommit?: () => Promise<string | null>;
} = {}): ProcessBootIdentity {
  const nowMs = opts.nowMs ?? Date.now();
  const uptimeSec = opts.uptimeSec ?? process.uptime();
  return {
    bootTimeMs: nowMs - Math.floor(uptimeSec * 1000),
    bootCommit: (opts.resolveCommit ?? resolveCurrentHeadCommit)(),
  };
}

// Start this read as soon as the DBOS bootstrap module graph evaluates. Do not
// move it behind the lazy watchdog import: that recreates EI-20338401938272036.
const PROCESS_BOOT_IDENTITY = captureProcessBootIdentity();

export function processBootTimeMs(): number {
  return PROCESS_BOOT_IDENTITY.bootTimeMs;
}

/** Memoized commit sampled at the eager DBOS bootstrap seam. */
export function processBootCommitSha(): Promise<string | null> {
  return PROCESS_BOOT_IDENTITY.bootCommit;
}
