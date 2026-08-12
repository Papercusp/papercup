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
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSidecarEnabledFromEnv } from '../process-supervision/sidecar-spawn-shared';

/** The shape every `RunGit` seam in the repo returns. */
export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The shape the STDIN seam returns — `stdout` is a **Buffer**, deliberately.
 *
 * `cat-file --batch` frames its output as
 * `<oid> SP <type> SP <size> LF <contents> LF`, so walking the frames needs
 * exact BYTE offsets; decoding to a string first shifts every offset on any
 * non-ASCII content and desynchronises the whole stream. Kept as a SEPARATE
 * type rather than widening `GitRunResult.stdout` to `string | Buffer`, which
 * would force every existing caller to narrow for a case it never sees.
 */
export interface GitStdinRunResult {
  code: number;
  stdout: Buffer;
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
  opts: { idleTimeoutMs?: number } = {},
): Promise<GitRunResult> {
  const { spawnSpawnerSidecar, getSpawnerIpcClient } = await loadSidecarModules();
  await spawnSpawnerSidecar();
  return getSpawnerIpcClient().call<GitRunResult>(
    'process:exec',
    { command: 'git', args, cwd, env, timeoutMs, idleTimeoutMs: opts.idleTimeoutMs },
    { timeoutMs: timeoutMs + 35_000 },
  );
}

/**
 * Per-process directory for the fd-handoff files (WI-6404).
 *
 * `/dev/shm` first (tmpfs — no disk write for a payload that is read and
 * unlinked immediately), falling back to `os.tmpdir()` where it is absent or
 * unwritable. Created 0700 and chmod'ed explicitly, because `mkdir`'s mode is
 * masked by umask and a pre-existing dir keeps its old mode: these files
 * briefly hold repo blob CONTENTS, so they must never be world-readable.
 *
 * Memoised, and never caches a failure — the same discipline
 * {@link loadSidecarModules} applies, and for the same reason: one transient
 * fault must not pin every later call onto the local-spawn fallback.
 */
let handoffDirPromise: Promise<string> | null = null;

function handoffDir(): Promise<string> {
  if (!handoffDirPromise) {
    handoffDirPromise = (async () => {
      const bases = ['/dev/shm', os.tmpdir()];
      let lastErr: unknown;
      for (const base of bases) {
        const dir = path.join(base, `papercusp-git-stdin-${process.pid}`);
        try {
          await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
          await fsp.chmod(dir, 0o700);
          return dir;
        } catch (e) {
          lastErr = e;
        }
      }
      throw new Error(`no writable handoff directory (tried ${bases.join(', ')}): ${String(lastErr)}`);
    })().catch((e) => {
      handoffDirPromise = null;
      throw e;
    });
  }
  return handoffDirPromise;
}

/** Monotonic suffix so concurrent calls in this process cannot collide. */
let handoffSeq = 0;

/**
 * Execute `git <args>` in the spawner sidecar with `stdin` fed to it and the
 * output returned as raw BYTES — the `cat-file --batch` / `--batch-check`
 * family (see {@link GitStdinRunResult} for why bytes).
 *
 * ## Why an fd handoff rather than the JSON line
 *
 * The RPC is line-delimited JSON in both directions, and this seam carries
 * multi-MB blob CONTENTS. Sending them inline would mean base64 (+33% plus
 * escaping) and a multi-MB `JSON.parse` on the MAIN THREAD at both ends —
 * plausibly a bigger stall than the ~165ms fork it removes, which would defeat
 * the entire point (this exists to stop blocking the event loop, so trading a
 * fork stall for a parse stall is self-defeating).
 *
 * So the JSON line stays CONTROL-ONLY (`stdinPath`/`stdoutPath` out;
 * `{ code, stderr, stdoutBytes }` back) and the payload travels out-of-band:
 * git reads and writes real fds at kernel level, and this side picks the
 * output up with an ASYNC `fs.readFile` on the libuv threadpool. Byte fidelity
 * is then structural rather than promised.
 *
 * Rejects on any sidecar problem — callers fall back to a local spawn, so a
 * fault here degrades performance, never correctness.
 */
export async function runGitStdinViaSpawnerSidecar(
  args: string[],
  cwd: string,
  stdin: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<GitStdinRunResult> {
  const { spawnSpawnerSidecar, getSpawnerIpcClient } = await loadSidecarModules();
  await spawnSpawnerSidecar();
  const dir = await handoffDir();
  const id = `${Date.now().toString(36)}-${(handoffSeq = (handoffSeq + 1) % 0xffffff).toString(36)}`;
  const stdinPath = path.join(dir, `${id}.in`);
  const stdoutPath = path.join(dir, `${id}.out`);
  try {
    // Pre-create BOTH 0600. The output file especially: if the sidecar created
    // it, its mode would follow the sidecar's umask, and it transiently holds
    // blob contents.
    await fsp.writeFile(stdinPath, stdin, { mode: 0o600 });
    await fsp.writeFile(stdoutPath, '', { mode: 0o600 });
    const res = await getSpawnerIpcClient().call<{
      code: number;
      stderr?: string;
      stdoutBytes?: number;
    }>(
      'process:exec',
      { command: 'git', args, cwd, env, timeoutMs, stdinPath, stdoutPath },
      { timeoutMs: timeoutMs + 35_000 },
    );
    const stdout = await fsp.readFile(stdoutPath);
    // A short read here would silently truncate a `--batch` stream and desync
    // the frame walk — which is exactly the corruption this design exists to
    // rule out, so it must fail loudly onto the local fallback, not quietly.
    if (typeof res.stdoutBytes === 'number' && res.stdoutBytes !== stdout.length) {
      throw new Error(
        `spawner sidecar handoff size mismatch: git wrote ${res.stdoutBytes} bytes, read back ${stdout.length}`,
      );
    }
    return { code: res.code, stdout, stderr: res.stderr ?? '' };
  } finally {
    // Never leave blob contents lying around, on success or failure.
    await fsp.rm(stdinPath, { force: true }).catch(() => {});
    await fsp.rm(stdoutPath, { force: true }).catch(() => {});
  }
}
