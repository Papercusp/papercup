/**
 * task-manager/enroll-sync — enrolment for spawn seams that cannot become async
 * (task-manager-no-escape-2026-07-27, P-008).
 *
 * `capability:bash`'s `startBackground` is synchronous and returns a job handle,
 * and both of its production callers plus a large test file depend on that shape.
 * Making it async to await a PG insert would be a wide, risky change to the single
 * most-used spawn seam on the box — for no behavioural gain, because none of the
 * enrolment work needs to complete before the child starts.
 *
 * So enrolment splits in two:
 *
 *   SYNCHRONOUS   mint the task id and decide confinement (a cached probe answer),
 *                 which is all the caller needs to build its argv.
 *   ASYNCHRONOUS  write the ledger rows, fire-and-forget.
 *
 * The failure mode is deliberately one-directional: if the ledger write fails or
 * lags, the job still runs and the reconciler still SEES it (it is inside our
 * cgroup slice), where it surfaces as `unaccounted` — visible, attributed late,
 * never lost. The reverse — a job that cannot start because the ledger is down —
 * would be the task manager causing the outages it exists to diagnose.
 */

import { readProcessIdentity } from '../process-identity';
import { buildTaskScopeArgv } from '../systemd-scope';
import { nodeCgroupFs, readProcessCgroupPath, type CgroupFs } from './cgroup-read';
import { taskManagerEnabledSync } from './enabled';
import { scopeSupportKnown } from './managed-spawn';
import { closeTask, markSpawned, registerTask } from './store';
import { newTaskId, scopeUnitForTask, sliceForClass, type TaskSpec } from './types';

export interface SyncEnrolment {
  taskId: string;
  confined: boolean;
  scopeUnit: string | null;
  /** False when the task manager is flag-OFF: no ledger row will be written and
   *  `wrap` is the identity. Carried on the enrolment rather than re-read later so
   *  a flip mid-job cannot leave a half-written row (a `complete` with no
   *  `register`, or a `finish` closing a row that never existed). */
  enrolled: boolean;
  /** Wrap a resolved binary+argv into the task's scope. Identity when unconfined. */
  wrap: (binary: string, argv: string[]) => { binary: string; argv: string[] };
}

/**
 * Decide confinement and mint the id — synchronously, before the fork.
 *
 * `confined:false` here is never an error. It means the task manager is flag-OFF,
 * or the probe has not landed yet (first job after boot), or this host cannot make
 * user scopes at all (a container, macOS).
 */
export function beginSyncEnrolment(
  spec: Pick<TaskSpec, 'class'> & Partial<TaskSpec>,
  opts: {
    /** Caller-side veto (a platform check). `false` never confines; `true`/omitted
     *  still defers to the flag and then the probe. */
    confine?: boolean;
  } = {},
): SyncEnrolment {
  const taskId = newTaskId();
  // WI-6499: the flag gates ENROLMENT ITSELF, not just confinement. OFF must mean
  // byte-identical-to-pre-feature behaviour — an unconfined, unledgered spawn —
  // because a ledger the reconciler is not running to maintain is just an
  // ever-growing table of rows nothing ever closes.
  const enrolled = taskManagerEnabledSync();
  const probe = scopeSupportKnown();
  const confined = enrolled && opts.confine !== false && probe?.ok === true;
  const scopeUnit = confined ? scopeUnitForTask(taskId) : null;

  return {
    taskId,
    confined,
    scopeUnit,
    enrolled,
    wrap: (binary, argv) =>
      confined
        ? {
            binary: 'systemd-run',
            argv: buildTaskScopeArgv([binary, ...argv], {
              unit: scopeUnit!,
              slice: sliceForClass(spec.class),
              memoryMaxBytes: spec.memoryMaxBytes,
              cpuWeight: spec.cpuWeight,
              tasksMax: spec.tasksMax,
              runtimeMaxSec: spec.runtimeMaxSec,
            }).slice(1),
          }
        : { binary, argv },
  };
}

/**
 * Write the ledger rows. Fire-and-forget: never awaited by the spawn path, never
 * allowed to reject into it.
 */
export function completeSyncEnrolment(
  enrolment: SyncEnrolment,
  spec: TaskSpec,
  pid: number | null,
  opts: { workspaceId?: string; fs?: CgroupFs } = {},
): void {
  if (!enrolment.enrolled) return;
  const fs = opts.fs ?? nodeCgroupFs;
  void (async () => {
    await registerTask(spec, {
      taskId: enrolment.taskId,
      workspaceId: opts.workspaceId,
      reserveScope: enrolment.confined,
    });
    await markSpawned(enrolment.taskId, {
      pid,
      processIdentity: pid ? readProcessIdentity(pid) : null,
      scopeUnit: enrolment.scopeUnit,
      cgroupPath: pid ? readProcessCgroupPath(pid, fs) : null,
      confined: enrolment.confined,
    });
  })().catch(() => {
    // Swallowed on purpose — see the header. A lost enrolment degrades to an
    // `unaccounted` row on the next reconcile, which is exactly the alarm that
    // classification exists to raise.
  });
}

/** Close an enrolled row when the job ends. Fire-and-forget, same contract. */
export function finishSyncEnrolment(
  enrolment: SyncEnrolment,
  outcome: { state: 'exited' | 'killed' | 'timed_out'; exitCode?: number | null; exitReason?: string | null },
): void {
  if (!enrolment.enrolled) return;
  void closeTask(enrolment.taskId, outcome).catch(() => {});
}
