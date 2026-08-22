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
