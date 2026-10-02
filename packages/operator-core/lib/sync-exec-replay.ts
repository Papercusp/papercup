/**
 * WI-10005261: run a SYNCHRONOUS, exec-injected probe without blocking the event loop.
 *
 * Several read-only probes (`checkActiveCheckpointRun`, `currentCheckpointCandidate`, …) are
 * written as sync functions that take an injected `ExecSyncLike`. Handing them a `spawnSync`
 * exec from an operator tool handler blocks the main thread for every git/systemctl call: a
 * sentinel profile (stall-1790903715731, 2026-10-02T01:15Z) attributed 98.6% of one event-loop
 * stall to `realResolveGateCandidates` doing exactly that. Main-thread stalls are what the
 * sentinel wedge-kills the host for, dropping every MCP session on it.
 *
 * Record/replay instead of a rewrite: the probe runs unchanged against an exec that answers
 * ONLY from a cache. The first call it cannot answer is recorded and gets a placeholder
 * failure result; that pass's return value is discarded, the recorded call runs ASYNC
 * (`execFile`), and the probe re-runs from the top with one more answer cached. A pass that
 * makes no uncached call is a complete, faithful execution: every exec call in it returned the
 * real result, in the same order a sync run would have issued them.
 *
 * Preconditions (the caller's responsibility): the probe must be side-effect free apart from
 * its exec calls, because it runs once per distinct exec call. Read-only git/systemctl probes
 * qualify. Only the first miss per pass is fetched, because later calls in that pass branch on a
 * placeholder and may never be issued by a real run.
 */
import { execFile, type ExecSyncOptions } from 'node:child_process';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Structurally identical to release-checkpoint-launch's `ExecSyncLike`. */
export type ReplayExecSync = (cmd: string, args: string[], options?: ExecSyncOptions) => ExecResult;

export type AsyncExec = (cmd: string, args: string[], options?: ExecSyncOptions) => Promise<ExecResult>;

/** Generous bound: real probes issue ~2-8 distinct calls; a probe that keeps inventing new ones is a bug. */
export const SYNC_EXEC_REPLAY_MAX_PASSES = 32;

const PENDING: ExecResult = Object.freeze({ status: null, stdout: '', stderr: 'sync-exec-replay: result pending' });

export class SyncExecReplayExhaustedError extends Error {
  constructor(readonly maxPasses: number) {
    super(`sync-exec-replay: probe still issued uncached exec calls after ${maxPasses} passes`);
    this.name = 'SyncExecReplayExhaustedError';
  }
}

export interface SyncExecReplayResult<T> {
  value: T;
  /** Distinct exec calls actually run (async). */
  execCalls: number;
  /** Probe executions, including the final complete one. */
  passes: number;
}

function callKey(cmd: string, args: readonly string[]): string {
  return JSON.stringify([cmd, args]);
}

export async function runSyncWithAsyncExec<T>(
  probe: (exec: ReplayExecSync) => T,
  asyncExec: AsyncExec,
  opts: { maxPasses?: number } = {},
): Promise<SyncExecReplayResult<T>> {
  const cache = new Map<string, ExecResult>();
  const maxPasses = opts.maxPasses ?? SYNC_EXEC_REPLAY_MAX_PASSES;
  for (let pass = 1; pass <= maxPasses; pass++) {
    const misses: Array<{ cmd: string; args: string[]; options?: ExecSyncOptions }> = [];
    const exec: ReplayExecSync = (cmd, args, options) => {
      const hit = cache.get(callKey(cmd, args));
      if (hit) return hit;
      if (misses.length === 0) misses.push({ cmd, args: [...args], options });
      return PENDING;
    };
    let value: T;
    try {
      value = probe(exec);
    } catch (err) {
      // A throw on a placeholder result is an artefact of an incomplete pass; a throw on a
      // complete pass is the probe's real behaviour and must surface.
      if (misses.length === 0) throw err;
      value = undefined as T;
    }
    const miss = misses[0];
    if (!miss) return { value, execCalls: cache.size, passes: pass };
    cache.set(callKey(miss.cmd, miss.args), await asyncExec(miss.cmd, miss.args, miss.options));
  }
  throw new SyncExecReplayExhaustedError(maxPasses);
}

/**
 * Async exec with `spawnSync`-compatible result semantics: `status` is the exit code, or null
 * when the child was killed (timeout) or never started (ENOENT). Never rejects.
 */
export function execFileResult(cmd: string, args: string[], options: { timeout?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: 'utf8', timeout: options.timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ status: 0, stdout, stderr });
        const code = (err as { code?: unknown }).code;
        resolve({ status: typeof code === 'number' ? code : null, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}
