/**
 * task-manager/managed-spawn — the chokepoint every long-lived process is born
 * through (task-manager-no-escape-2026-07-27, P-007).
 *
 * Three things happen here, in this order, and the order is the design:
 *
 *   1. REGISTER the row as `pending` — BEFORE the fork. A crash in the window
 *      between register and spawn then leaves a visible pending row that the
 *      reconciler strands, instead of a process nobody recorded. Spawn-then-record
 *      loses the process entirely if the operator dies in the window.
 *   2. CONFINE into `pc-<taskId>.scope` under `papercusp-<class>.slice`. The scope
 *      NAME carries the ledger key, so reconciliation is a join; the slice makes
 *      every descendant enumerable no matter how it forked.
 *   3. STAMP the kernel identity (`linux:<bootId>:<startTicks>`) and flip to
 *      `running`, so nothing downstream ever has to trust a bare pid.
 *
 * FAILS SOFT, ALWAYS. If systemd cannot give us a scope — no bus, no binary, a
 * container, macOS — the process still spawns and is still ledgered, just with
 * `confined: false`. Degrading to "unconfined but accounted" is right; refusing to
 * spawn because the task manager is unavailable would make an observability
 * feature into an outage.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { readProcessIdentity } from '../process-identity';
import { buildTaskScopeArgv, SCOPE_LAUNCH_FAILURE_RE } from '../systemd-scope';
import { nodeCgroupFs, readProcessCgroupPath, type CgroupFs } from './cgroup-read';
import { closeTask, markSpawned, registerTask } from './store';
import { newTaskId, scopeUnitForTask, sliceForClass, type TaskRow, type TaskSpec } from './types';

export interface ManagedSpawnOptions {
  /** Anything `child_process.spawn` takes. `detached` is honoured — a detached
   *  child still cannot leave its cgroup, which is the point. */
  spawnOptions?: SpawnOptions;
  /** Force confinement off (tests, or a caller that knows it is unsupported). */
  confine?: boolean;
  workspaceId?: string;
  /** Injected for tests. */
  spawnFn?: typeof spawn;
  fs?: CgroupFs;
  /** Injected for tests — overrides the cached systemd probe. */
  scopeAvailable?: boolean;
}

export interface ManagedSpawnResult {
  taskId: string;
  row: TaskRow;
  child: ChildProcess;
  scopeUnit: string | null;
  confined: boolean;
  /** Set when confinement was requested but unavailable — surfaced so a caller
   *  (and the pane) can say WHY a task is unconfined rather than guessing. */
  confinementSkippedReason?: string;
}

// ── systemd availability probe ──────────────────────────────────────────────

let scopeProbe: Promise<{ ok: boolean; reason?: string }> | null = null;

/**
 * Probe ONCE per operator process whether transient user scopes can be created.
 *
 * A probe beats the alternative — launch into a scope, watch for a launch-failure
 * signature on stderr, then relaunch direct — because that alternative
 * double-spawns on every call on a host where it will never work, and because
 * "did the payload fail or did the SCOPE fail" is genuinely ambiguous to parse
 * (the existing seams carry a regex for exactly that ambiguity). One deterministic
 * probe answers it before any real work is at stake.
 */
export function probeScopeSupport(spawnFn: typeof spawn = spawn): Promise<{ ok: boolean; reason?: string }> {
  if (scopeProbe) return scopeProbe;
  scopeProbe = new Promise((resolve) => {
    if (process.platform !== 'linux') {
      resolve({ ok: false, reason: `platform ${process.platform} has no cgroup scopes` });
      return;
    }
    let settled = false;
    const done = (v: { ok: boolean; reason?: string }): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawnFn(
        'systemd-run',
        ['--user', '--scope', '--quiet', '--collect', '--', 'true'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => {
        stderr += String(d);
      });
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        done({ ok: false, reason: 'systemd-run probe timed out' });
      }, 10_000);
      timer.unref?.();
      child.on('error', (e) => {
        clearTimeout(timer);
        done({ ok: false, reason: `systemd-run unavailable: ${e.message}` });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) done({ ok: true });
        else done({ ok: false, reason: `systemd-run probe exited ${code}: ${stderr.trim().slice(0, 200)}` });
      });
    } catch (e) {
      done({ ok: false, reason: `systemd-run spawn threw: ${(e as Error).message}` });
    }
  });
  return scopeProbe;
}

/** Test seam — forget the cached probe. */
export function resetScopeProbe(): void {
  scopeProbe = null;
}

// ── the chokepoint ──────────────────────────────────────────────────────────

/**
 * Spawn `command` with `args` as a ledgered, (where possible) cgroup-confined task.
 *
 * The returned `child` is a normal ChildProcess with normal stdio — confinement
 * uses `--scope`, not `--unit`, precisely so callers keep piped stdio and
 * process-group semantics and nothing downstream has to change.
 */
export async function managedSpawn(
  command: string,
  args: readonly string[],
  spec: TaskSpec,
  opts: ManagedSpawnOptions = {},
): Promise<ManagedSpawnResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const fs = opts.fs ?? nodeCgroupFs;
  const taskId = newTaskId();
  const wantConfine = opts.confine !== false;

  let scopeOk = false;
  let skippedReason: string | undefined;
  if (wantConfine) {
    if (opts.scopeAvailable !== undefined) {
      scopeOk = opts.scopeAvailable;
      if (!scopeOk) skippedReason = 'confinement disabled by caller';
    } else {
      const probe = await probeScopeSupport(spawnFn);
      scopeOk = probe.ok;
      skippedReason = probe.reason;
    }
  } else {
    skippedReason = 'confine: false';
  }

  const argvSpec: TaskSpec = { ...spec, argv: [command, ...args] };
  const row = await registerTask(argvSpec, {
    taskId,
    workspaceId: opts.workspaceId,
    reserveScope: scopeOk,
  });

  const scopeUnit = scopeOk ? scopeUnitForTask(taskId) : null;
  const launchArgv = scopeOk
    ? buildTaskScopeArgv([command, ...args], {
        unit: scopeUnit!,
        slice: sliceForClass(spec.class),
        memoryMaxBytes: spec.memoryMaxBytes,
        cpuWeight: spec.cpuWeight,
        tasksMax: spec.tasksMax,
        runtimeMaxSec: spec.runtimeMaxSec,
      })
    : [command, ...args];

  let child: ChildProcess;
  try {
    child = spawnFn(launchArgv[0]!, launchArgv.slice(1), opts.spawnOptions ?? {});
  } catch (e) {
    // The row already exists; close it honestly rather than leaving a pending
    // row the reconciler will later strand with a vaguer reason.
    await closeTask(taskId, {
      state: 'exited',
      exitCode: null,
      exitReason: `spawn threw: ${(e as Error).message}`,
    });
    throw e;
  }

  const pid = child.pid ?? null;
  await markSpawned(taskId, {
    pid,
    processIdentity: pid ? readProcessIdentity(pid) : null,
    scopeUnit,
    cgroupPath: pid ? readProcessCgroupPath(pid, fs) : null,
    confined: scopeOk,
  });

  wireExit(child, taskId, scopeOk);

  return {
    taskId,
    row,
    child,
    scopeUnit,
    confined: scopeOk,
    confinementSkippedReason: scopeOk ? undefined : skippedReason,
  };
}

/**
 * Close the row on exit — and distinguish the ways a process can end, because a
 * pane that reports every ending as "exited" is a pane that cannot tell you your
 * build was OOM-killed.
 */
function wireExit(child: ChildProcess, taskId: string, confined: boolean): void {
  let closed = false;
  const close = (state: 'exited' | 'killed', code: number | null, reason: string | null): void => {
    if (closed) return;
    closed = true;
    void closeTask(taskId, { state, exitCode: code, exitReason: reason }).catch(() => {
      // A close that loses its race with the reconciler's strand verdict is fine:
      // closeTask is idempotent on `ended_at`, so first writer wins and we never
      // overwrite a real exit code with a guess (or vice versa).
    });
  };

  child.on('exit', (code, signal) => {
    if (signal) {
      close('killed', code, `signal ${signal}`);
    } else {
      close('exited', code, null);
    }
  });

  child.on('error', (e) => {
    const msg = e.message ?? String(e);
    // A scope that could not start is NOT a payload failure — record it as such
    // so a box that has quietly lost its user bus is diagnosable from the ledger.
    const scopeFailed = confined && SCOPE_LAUNCH_FAILURE_RE.test(msg);
    close('exited', null, scopeFailed ? `scope launch failed: ${msg}` : `spawn error: ${msg}`);
  });
}
