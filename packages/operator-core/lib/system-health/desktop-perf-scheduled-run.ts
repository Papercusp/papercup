/**
 * Scheduled producer for the desktop-perf release gate (WI-6538).
 *
 * The desktop-perf gate (apps/operator/lib/release/desktop-perf-gate.ts) has
 * been structurally incapable of firing since the suite landed 2026-07-20:
 * `harness_shared.desktop_perf_runs` was written ONLY by a human clicking Run
 * in the admin testing UI, and nobody ever has — the table stayed at zero
 * rows. This tick is the missing PRODUCER: it runs the already-working,
 * self-contained packaged-binary wdio suite (tools/perf-test/wdio — WI-5662
 * fixed its tauri-driver wiring 2026-07-27, verified end-to-end) on a
 * schedule, so the gate's `maxAgeMs` freshness window (24h — see that file's
 * own `DEFAULT_DESKTOP_PERF_MAX_AGE_MS`) always has a real run to evaluate.
 *
 * The suite is FULLY self-contained and this tick deliberately does not
 * duplicate any of its resolution logic (the two-copies trap wdio.conf.ts's
 * own `cargoTargetDir` note warns about):
 *   - it auto-picks a free Xvfb display via `xvfb-run -a` when DISPLAY is
 *     unset (wdio.conf.ts's tauriDriverSpawnArgs) — never touches :0/:1;
 *   - it auto-resolves the freshest COMPLETE packaged binary via `cargo
 *     metadata` (wdio.conf.ts's resolveTauriAppPath);
 *   - its own `onComplete` hook POSTs the measures to the ingest route
 *     (endpoint-route/routes/admin/testing-desktop-perf-ingest.ts), which
 *     calls the SAME `recordDesktopPerfRun` the in-app admin suite uses —
 *     one writer, one schema, one trend.
 * This tick therefore only has to launch the suite and wait; it never writes
 * to desktop_perf_runs itself.
 *
 * NEVER TREATS A TEST-FINDING FAILURE AS A TICK FAILURE. A nonzero wdio exit
 * means the suite found a real regression — it already recorded that via
 * `onComplete` (which fires before the budget asserts, per perf-report.ts's
 * own doc comment) before throwing. Only an infra failure (the process could
 * not be spawned, or hung past the timeout) is worth surfacing as a problem
 * with THIS tick; a completed run, whatever its exit code, is success here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';
import { REPO_ROOT } from '../agent-tools/docs/_repo-paths';

const WDIO_DIR = path.join(REPO_ROOT, 'tools', 'perf-test', 'wdio');

/**
 * Bounded — a hung tauri-driver/webview session must not wedge this tick
 * forever (mirrors green-checkpoint's own `runCmd` SIGKILL-on-timeout shape).
 * 10 minutes is generous: the WI-5662 live verification run completed the
 * full 3-spec suite in 00:01:38.
 */
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/** Bound the tail kept for the warn log — this is a log excerpt, not a report. */
const LOG_TAIL_CHARS = 4000;

export interface DesktopPerfScheduledRunResult {
  ran: boolean;
  skippedReason?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
}

/** IO seam for tests. */
export interface DesktopPerfScheduledRunIO {
  spawnFn: (command: string, args: readonly string[], options: Record<string, unknown>) => ChildProcess;
  readEnabled: () => Promise<boolean>;
}

const defaultIO: DesktopPerfScheduledRunIO = {
  spawnFn: (command, args, options) => spawn(command, args as string[], options),
  readEnabled: () => getFlag(FLAGS.DESKTOP_PERF_SCHEDULED_RUN, 'system').catch(() => true),
};

/**
 * Run the packaged-binary desktop-perf suite once. Resolves — never rejects —
 * with a result describing what happened; DBOS retries an infra-level miss
 * (spawn error) via the caller's step wrapper, not this function throwing.
 */
export async function runDesktopPerfScheduledRun(
  io: DesktopPerfScheduledRunIO = defaultIO,
): Promise<DesktopPerfScheduledRunResult> {
  const enabled = await io.readEnabled();
  if (!enabled) {
    return { ran: false, skippedReason: 'DESKTOP_PERF_SCHEDULED_RUN flag is off' };
  }

  const startedAt = Date.now();
  return new Promise((resolve) => {
    // Deliberately NO DISPLAY / TAURI_APP_PATH set here — wdio.conf.ts's own
    // resolvers already do this correctly (see the module doc above) and are
    // the single source of truth for it.
    const child = io.spawnFn('npm', ['test'], {
      cwd: WDIO_DIR,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      console.warn(
        `[desktop-perf-scheduled-run] timed out after ${RUN_TIMEOUT_MS}ms — killed. ` +
          `stdout tail:\n${stdout.slice(-LOG_TAIL_CHARS)}\nstderr tail:\n${stderr.slice(-LOG_TAIL_CHARS)}`,
      );
      resolve({ ran: true, timedOut: true, durationMs: Date.now() - startedAt });
    }, RUN_TIMEOUT_MS);
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[desktop-perf-scheduled-run] failed to spawn: ${message}`);
      resolve({ ran: false, skippedReason: `spawn error: ${message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (code !== 0) {
        // NOT a tick failure — see the module doc: a nonzero exit is the
        // suite reporting a real regression it already recorded. Logged for
        // visibility only.
        console.warn(
          `[desktop-perf-scheduled-run] wdio exited ${code} after ${durationMs}ms ` +
            `(measures already posted via onComplete regardless of exit code) — tail:\n` +
            `${stdout.slice(-LOG_TAIL_CHARS)}\n${stderr.slice(-LOG_TAIL_CHARS)}`,
        );
      }
      resolve({ ran: true, exitCode: code, durationMs });
    });
  });
}
