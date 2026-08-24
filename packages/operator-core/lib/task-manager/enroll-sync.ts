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
 * never lost. The write failure is also logged at this seam so the later residue
 * has an attributable cause. The reverse — a job that cannot start because the
 * ledger is down — would be the task manager causing the outages it diagnoses.
 */

import { readProcessIdentity } from '../process-identity';
import {
  buildTaskScopeArgvWithTransport,
  buildTaskServiceArgvWithTransport,
  type SecretEnvironmentTransport,
} from '../systemd-scope';
import {
  absCgroupDir,
  nodeCgroupFs,
  readCgroupProcs,
  readProcessCgroupPath,
  sampleCgroup,
  type CgroupFs,
} from './cgroup-read';
import { taskManagerEnabledSync } from './enabled';
import { scopeSupportKnown } from './managed-spawn';
import {
  bindAgentSessionTaskToLatestNativeSession,
  closeTask,
  markSpawned,
  registerTask,
} from './store';
import {
  deriveUserManagerRoot,
  newTaskId,
  serviceUnitForTask,
  scopeCgroupRelPath,
  scopeUnitForTask,
  sliceForClass,
  type TaskSpec,
  type TaskUnitKind,
} from './types';

/**
 * WHY a task ended up unconfined. `null` when it is confined.
 *
 * D-014 (process-lifecycle-no-orphans-2026-08-02): `confined:false` on its own
 * collapses four causes into one boolean, and they are not the same event —
 * three are permanent and expected, one is a transient race that nothing could
 * previously see:
 *
 *  - `flag-off`         the task manager flag is off. Deliberate (WI-6499):
 *                       byte-identical-to-pre-feature, unledgered spawn.
 *  - `caller-veto`      an explicit caller-side `confine:false` platform check.
 *  - `no-scope-support` this host genuinely cannot make user scopes (a
 *                       container, macOS). Permanent, and correct to report.
 *  - `probe-pending`    the scope probe has not landed yet — the first job
 *                       after boot. TRANSIENT: the same host will confine
 *                       normally seconds later.
 *
 * `probe-pending` is the one worth counting. Its symptom is identical to
 * `no-scope-support`, so a spawn that lost confinement to a boot-window race
 * has until now been indistinguishable from one on a host that never supported
 * confinement at all. A rising `probe-pending` rate means spawns are routinely
 * racing the probe, which is a real ordering problem and previously produced no
 * signal whatsoever.
 *
 * This is REPORTING ONLY — D-014 establishes that the behaviour itself is
 * correct and must not be "made symmetric". Both unknowns already fail in the
 * direction that preserves function: an unknown flag fails OPEN so the task is
 * still ledgered, and an unknown probe fails to unconfined so the spawn
 * degrades instead of dying on a `systemd-run` that cannot work.
 */
export type UnconfinedReason = 'flag-off' | 'caller-veto' | 'no-scope-support' | 'probe-pending';

export interface SyncEnrolment {
  taskId: string;
  confined: boolean;
  /** Why `confined` is false; null when confined. See {@link UnconfinedReason}. */
  unconfinedReason: UnconfinedReason | null;
  /** Bash jobs use a transient service; all other sync-enrolled classes use scopes. */
  unitKind: TaskUnitKind;
  scopeUnit: string | null;
  /** False when the task manager is flag-OFF: no ledger row will be written and
   *  `wrap` is the identity. Carried on the enrolment rather than re-read later so
   *  a flip mid-job cannot leave a half-written row (a `complete` with no
   *  `register`, or a `finish` closing a row that never existed). */
  enrolled: boolean;
  /** Set by `completeSyncEnrolment`; resolves after the ledger row is inserted.
   *  `finishSyncEnrolment` waits on this before closing so a fast child cannot win
   *  the INSERT-vs-UPDATE race. It intentionally covers registration only, not the
   *  later identity update: a terminal close may safely win against `markSpawned`'s
   *  `state = 'pending'` guard once the row exists. */
  registrationReady: Promise<void> | null;
  /** Release the memory-only payload environment, if wrap() created one. */
  releaseEnvironmentTransport: () => void;
  /** Wrap a resolved binary+argv into the task's scope. Identity when unconfined.
   *  `cwd` (EI-21229453838112711) is REQUIRED for correctness on the SERVICE
   *  path — a service payload is started by the user manager and defaults to
   *  $HOME, so passing the caller's cwd to `spawn` alone silently runs the job
   *  in the wrong directory. Optional because the scope path inherits cwd and
   *  genuinely does not need it. */
  wrap: (
    binary: string,
    argv: string[],
    env?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
  ) => { binary: string; argv: string[]; release?: () => void };
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
  const unitKind: TaskUnitKind = spec.class === 'bash-job' ? 'service' : 'scope';
  const scopeUnit = confined
    ? (unitKind === 'service' ? serviceUnitForTask(taskId) : scopeUnitForTask(taskId))
    : null;

  // D-014: report WHICH of the four causes produced an unconfined spawn. Ordered
  // to match the short-circuit above, so the reason names the condition that
  // actually decided it rather than the first one that happens to be true.
  // `probe === null` (not landed) is deliberately distinguished from
  // `probe.ok === false` (host cannot do scopes) — that distinction is the whole
  // point, and `probe?.ok === true` erases it.
  const unconfinedReason: UnconfinedReason | null = confined
    ? null
    : !enrolled
      ? 'flag-off'
      : opts.confine === false
        ? 'caller-veto'
        : probe === null
          ? 'probe-pending'
          : 'no-scope-support';

  let environmentTransport: SecretEnvironmentTransport | null = null;
  const releaseEnvironmentTransport = (): void => {
    environmentTransport?.release();
    environmentTransport = null;
  };

  return {
    taskId,
    confined,
    unconfinedReason,
    unitKind,
    scopeUnit,
    enrolled,
    registrationReady: null,
    releaseEnvironmentTransport,
    wrap: (binary, argv, env, cwd) => {
      if (!confined) return { binary, argv };

      // A wrapper is normally built once, but release a prior payload first so
      // an accidental retry cannot leave an anonymous fd alive until its timer.
      releaseEnvironmentTransport();
      const built = (unitKind === 'service' ? buildTaskServiceArgvWithTransport : buildTaskScopeArgvWithTransport)(
        [binary, ...argv],
        {
          unit: scopeUnit!,
          slice: sliceForClass(spec.class),
          env,
          // Only the service builder reads this; the scope payload inherits
          // the client's cwd. See TaskScopeProperties.workingDirectory.
          workingDirectory: cwd,
          memoryMaxBytes: spec.memoryMaxBytes,
          cpuWeight: spec.cpuWeight,
          tasksMax: spec.tasksMax,
          runtimeMaxSec: spec.runtimeMaxSec,
        },
      );
      environmentTransport = built.transport;
      const wrapped: ReturnType<SyncEnrolment['wrap']> = {
        binary: built.argv[0]!,
        argv: built.argv.slice(1),
      };
      if (built.transport) wrapped.release = releaseEnvironmentTransport;
      return wrapped;
    },
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
  // Keep the registration promise on the enrolment. The spawn seam cannot await
  // this write, but its exit handler can await it indirectly; without this handoff
  // a fast child calls closeTask before the INSERT exists, and the late INSERT then
  // resurrects the already-finished task as `running`.
  const registrationReady = registerTask(spec, {
    taskId: enrolment.taskId,
    workspaceId: opts.workspaceId,
    reserveScope: enrolment.confined,
    unitKind: enrolment.unitKind,
  }).then(() => undefined);
  enrolment.registrationReady = registrationReady;

  void registrationReady
    .then(async () => {
      await markSpawned(enrolment.taskId, {
        pid,
        processIdentity: pid ? readProcessIdentity(pid) : null,
        scopeUnit: enrolment.scopeUnit,
        cgroupPath: pid ? readProcessCgroupPath(pid, fs) : null,
        confined: enrolment.confined,
        unconfinedReason: enrolment.unconfinedReason,
      });
      if (spec.class === 'agent-session') {
        try {
          await bindAgentSessionTaskToLatestNativeSession(enrolment.taskId);
        } catch (error) {
          // The bootstrap-side bulk binder is the other half of this race and
          // the reconciler keeps the task visible, so linking failure must not
          // turn a healthy spawn into a launch failure. It must still be loud:
          // an unlinked row cannot participate in session-end cleanup.
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(
            `[task-manager] native-session bind failed for task ${enrolment.taskId}: ${reason.slice(0, 500)}`,
          );
        }
      }
    })
    .catch((error: unknown) => {
      // Fail open — see the header — but never fail silently. The reconciler can
      // identify the scope later; this line preserves the causal error that made
      // the live process unaccounted in the first place.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[task-manager] sync enrollment failed for task ${enrolment.taskId}: ${reason.slice(0, 500)} — ` +
          'process continues unledgered and will surface as unaccounted',
      );
    });
}

/** Close an enrolled row when the job ends. Fire-and-forget, same contract. */
export function finishSyncEnrolment(
  enrolment: SyncEnrolment,
  outcome: { state: 'exited' | 'killed' | 'timed_out'; exitCode?: number | null; exitReason?: string | null },
  opts: { scopeCgroupPath?: string | null; fs?: CgroupFs } = {},
): void {
  if (!enrolment.enrolled) return;
  // `systemd-run --scope` forks the payload away from the client process. A
  // synchronous spawn seam cannot await the ledger insert, so its client exit
  // handler must not close the row while the scope still holds the real work;
  // doing so turns the live scope into `unaccounted` and removes the safe
  // taskId/scope cleanup handle. This mirrors managedSpawn's WI-37509 guard.
  if (enrolment.confined && opts.scopeCgroupPath && scopeHasProcesses(opts.scopeCgroupPath, opts.fs ?? nodeCgroupFs)) {
    const message =
      `[task-manager] sync-enrolled task ${enrolment.taskId}: the systemd-run client exited ` +
      'but its scope still holds processes — leaving the row live for the reconciler to close (WI-37509).';
    // Code 0 is the normal systemd-run handoff; reserve warnings for an
    // abnormal client ending while the payload is still alive.
    if (outcome.state === 'exited' && outcome.exitCode === 0) console.info(message);
    else console.warn(message);
    return;
  }
  const close = () => {
    enrolment.releaseEnvironmentTransport();
    void closeTask(enrolment.taskId, outcome).catch(() => {});
  };
  // `completeSyncEnrolment` is deliberately fire-and-forget for synchronous spawn
  // callers, so the INSERT may still be in flight here. UPDATE-before-INSERT is a
  // lost close: the row is then inserted and marked running forever. Wait only for
  // registration; `markSpawned` remains independently best-effort and its pending
  // state guard makes a close that wins after insertion safe.
  if (enrolment.registrationReady) {
    void enrolment.registrationReady.then(close, () => {});
  } else {
    close();
  }
}

/** True only on a positive cgroup read; an unreadable/empty scope may close normally. */
function scopeHasProcesses(scopeCgroupPath: string, fs: CgroupFs): boolean {
  const abs = absCgroupDir(scopeCgroupPath);
  if (readCgroupProcs(abs, fs).length > 0) return true;
  const pidsCurrent = sampleCgroup(abs, fs).pidsCurrent;
  return pidsCurrent != null && pidsCurrent > 0;
}

/** Derive a confined sync task's cgroup path without reading the forked client pid. */
export function syncEnrolmentScopePath(
  enrolment: SyncEnrolment,
  taskClass: TaskSpec['class'],
  fs: CgroupFs = nodeCgroupFs,
): string | null {
  if (!enrolment.confined || !enrolment.scopeUnit) return null;
  return scopeCgroupRelPath(
    deriveUserManagerRoot(readProcessCgroupPath(process.pid, fs)),
    taskClass,
    enrolment.scopeUnit,
  );
}
