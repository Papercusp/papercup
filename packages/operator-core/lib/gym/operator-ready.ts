/**
 * waitForOperatorReady — shared boot gate for the gym's dedicated operator
 * (EI-368). Replaces the per-runner `waitForHttp(…/llms.txt)` copies, which
 * accepted ANY HTTP response as "up": the hono listener binds BEFORE the DBOS
 * system-DB migration, so the probe could pass, the boot then abort
 * mid-migration (native Napi::Error), and the cycle's first pipeline call
 * surfaced only the downstream wreckage ("column was_forked_from does not
 * exist" on the half-migrated dbos schema) minutes later.
 *
 * Two legs:
 *  - READINESS, not liveness: poll GET /api/health/ready until the operator
 *    reports its configured shape is up (DBOS launched). A pinned checkout
 *    that predates the route (404) falls back to the legacy llms.txt liveness
 *    probe — never worse than before.
 *  - FAIL-FAST: the moment the spawned operator exits, reject with the exit
 *    code/signal + the boot-log tail, instead of polling out the timeout and
 *    letting a later pipeline call hit the corpse.
 */
import { readFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';

export interface WaitForOperatorReadyOpts {
  /** e.g. `http://127.0.0.1:3976` */
  baseUrl: string;
  /** The spawned gym-operator; omit when there is no process to watch. */
  child?: ChildProcess;
  timeoutMs: number;
  /** Boot log path — its tail rides every rejection message. */
  logPath?: string;
  pollMs?: number;
}

/** Last `lines` of the boot log, formatted for an error message ('' when unreadable). */
export function bootLogTail(logPath: string | undefined, lines = 15): string {
  if (!logPath) return '';
  try {
    const all = readFileSync(logPath, 'utf8').trimEnd().split('\n');
    return `\n--- boot log tail (${logPath}) ---\n${all.slice(-lines).join('\n')}`;
  } catch {
    return '';
  }
}

export async function waitForOperatorReady(opts: WaitForOperatorReadyOpts): Promise<void> {
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + opts.timeoutMs;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
    opts.child && opts.child.exitCode !== null ? { code: opts.child.exitCode, signal: null } : null;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = { code, signal };
  };
  opts.child?.once('exit', onExit);
  try {
    let readyRouteAbsent = false;
    for (;;) {
      if (exited) {
        throw new Error(
          `gym-operator exited during boot (code=${exited.code}, signal=${exited.signal ?? 'none'})${bootLogTail(opts.logPath)}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `gym-operator not ready on ${opts.baseUrl} within ${Math.round(opts.timeoutMs / 1000)}s${bootLogTail(opts.logPath)}`,
        );
      }
      try {
        if (readyRouteAbsent) {
          // Pinned checkout predates /api/health/ready — legacy liveness probe.
          const r = await fetch(`${opts.baseUrl}/llms.txt`, { signal: AbortSignal.timeout(3000) });
          if (r.status > 0) return;
        } else {
          const r = await fetch(`${opts.baseUrl}/api/health/ready`, { signal: AbortSignal.timeout(3000) });
          if (r.status === 404) {
            readyRouteAbsent = true;
            continue; // re-probe immediately via the fallback
          }
          if (r.ok) return;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    opts.child?.removeListener('exit', onExit);
  }
}
