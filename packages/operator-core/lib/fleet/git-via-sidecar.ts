/**
 * Run `git` in the SPAWNER SIDECAR instead of forking it from this process.
 *
 * ## Why this exists (EI-18808838427010743 — measured, not theorised)
 *
 * `fork()` must copy the calling process's page tables, so the parent-side cost
 * of `child_process.spawn` scales with the PARENT's RSS — and it is charged as
 * SYNCHRONOUS system time on the main thread, i.e. it blocks the event loop.
 * Measured on this box, 50× `git rev-parse` while varying only parent RSS:
 *
 * | parent RSS | parent cost per spawn | user | sys    |
 * |------------|-----------------------|------|--------|
 * | 105 MB     | 3.44 ms               | 0.99 | 2.45   |
 * | 575 MB     | 15.92 ms              | 0.79 | 15.13  |
 * | 1621 MB    | 56.23 ms              | 0.84 | 55.39  |
 * | 3194 MB    | 126.37 ms             | 1.16 | 125.21 |
 *
 * ≈ **40 ms of blocked event loop per GB of parent RSS**, essentially all
 * kernel time. The bg-host runs at ~4.2 GB, so every `git` call there cost
 * ~165 ms of dead loop — for commands git itself completes in ~4 ms (~97%
 * pure overhead, imposed by the caller's own footprint).
 *
 * A 150s CPU profile of the live bg-host showed the consequence: bursts at 98%
 * main-thread busy with **83% of it inside `spawn()`**, 32% duty cycle, and
 * multi-second stretches where the loop was effectively dead. That is what was
 * killing p2p peer sockets mid-transfer (EI-18808621019872598): UDX/hyperswarm
 * keepalives and timers cannot fire while the loop is blocked.
 *
 * Routing through the sidecar removes the fork from the big process entirely:
 * the sidecar is a small, long-lived process, so ITS fork is cheap (~3 ms), and
 * the caller pays only a Unix-socket round-trip. The child `git` runs exactly
 * as before — same argv, same cwd, same env, same output.
 *
 * ## Why here
 *
 * `harness/git-sync/run-git-sync.ts` already did this for the git-sync runner;
 * `sync/pot-git/storage.ts` did not, which is why the p2p path kept paying the
 * tax. Rather than fork the helper into a second copy, it is lifted here so
 * there is ONE implementation both import (repo convention: reuse-first —
 * extend, don't fork).
 */
import { isSidecarEnabledFromEnv } from '../process-supervision/sidecar-spawn-shared';

/** The shape every `RunGit` seam in the repo returns. */
export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Memoised module handles.
 *
 * The dynamic `import()`s MUST NOT be re-done per call. Under `tsx` a dynamic
 * import goes through the ESM loader hooks and blocks on a SYNCHRONOUS
 * loader-thread round-trip (`makeSyncRequest`) — measured at 7.09% of the
 * bg-host main thread in the same profile that found the fork cost. Re-importing
 * on every git call would hand back a slice of the very stall this module
 * exists to remove.
 */
let sidecarModulesPromise: Promise<{
  spawnSpawnerSidecar: () => Promise<unknown>;
  getSpawnerIpcClient: () => {
    call<T>(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  };
}> | null = null;

function loadSidecarModules(): NonNullable<typeof sidecarModulesPromise> {
  if (!sidecarModulesPromise) {
    sidecarModulesPromise = (async () => {
      const [{ spawnSpawnerSidecar }, { getSpawnerIpcClient }] = await Promise.all([
        import('./spawner-sidecar-spawn'),
        import('./spawner-ipc-client'),
      ]);
      return { spawnSpawnerSidecar, getSpawnerIpcClient } as never;
    })().catch((e) => {
      // Never cache a failed load — a transient failure must not permanently
      // pin every future call onto the local-spawn fallback.
      sidecarModulesPromise = null;
      throw e;
    });
  }
  return sidecarModulesPromise;
}

/**
 * Is the spawner sidecar enabled for this caller?
 *
 * `explicitVar` is the caller's own opt-in/opt-out override (checked before the
 * shared enable var), letting one subsystem be switched independently of the
 * others while a change is being rolled out or bisected.
 */
export function gitSidecarEnabled(
  explicitVar?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isSidecarEnabledFromEnv(
    {
      enableVar: 'PAPERCUSP_SPAWNER_SIDECAR',
      modeVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
      explicitVar,
    },
    env,
  );
}

/**
 * Execute `git <args>` inside the spawner sidecar. Rejects if the sidecar is
 * unreachable — every caller is expected to fall back to a local spawn, so a
 * sidecar problem degrades performance rather than breaking git.
 *
 * The sidecar owns the real kill-timeout; the client timeout is deliberately
 * slack so it cannot race a legitimate timeout RESPONSE coming back.
 */
export async function runGitViaSpawnerSidecar(
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<GitRunResult> {
  const { spawnSpawnerSidecar, getSpawnerIpcClient } = await loadSidecarModules();
  await spawnSpawnerSidecar();
  return getSpawnerIpcClient().call<GitRunResult>(
    'process:exec',
    { command: 'git', args, cwd, env, timeoutMs },
    { timeoutMs: timeoutMs + 35_000 },
  );
}
