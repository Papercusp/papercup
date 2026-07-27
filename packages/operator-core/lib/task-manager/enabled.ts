/**
 * task-manager/enabled — the ONE authority on whether the task manager is live
 * (WI-6499, owner directive 2026-07-27: "put the task manager behind a testing
 * flag it isn't ready yet").
 *
 * Before this module the `papercusp-task-manager` flag was largely decorative: it
 * gated the PANE's two read surfaces and nothing else, while its own doc comment
 * claimed it gated "cgroup confinement at the spawn chokepoints, the 30s
 * reconcile, and the Task Manager pane". Turning it off still confined every
 * spawn, still wrote the ledger, still ran the reconciler, and still fired a
 * `systemd-run` probe at module import — the pane just went blank. A kill-switch
 * that only blanks the dashboard is worse than none, because it reads as safe.
 *
 * Two readers, because the spawn seams need two shapes:
 *
 *   ASYNC   `isTaskManagerEnabled()` — the real read. Anything that can await.
 *   SYNC    `taskManagerEnabledSync()` — a cached snapshot for `beginSyncEnrolment`,
 *           which is synchronous by design (see enroll-sync.ts's header) and cannot
 *           grow an await without changing every spawn seam on the box.
 *
 * FAILS CLOSED, deliberately — the opposite of the two call sites this replaces,
 * which both did `.catch(() => true)`. That bias was right for a finished
 * subsystem whose absence would be the outage; it is wrong for one the owner has
 * declared unready. If the flag backend is unreachable we must not silently
 * confine and ledger every process on the box. Unknown ⇒ off.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';

/** null = "not resolved yet", which reads as OFF for sync callers. */
let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

/**
 * Resolve the flag, refreshing the sync cache as a side effect.
 *
 * `distinctId` is the call site, matching the convention at the other getFlag
 * call sites in this tree — it is what makes a PostHog evaluation attributable
 * to the surface that asked.
 */
export async function isTaskManagerEnabled(distinctId = 'task-manager'): Promise<boolean> {
  const on = await getFlag(FLAGS.TASK_MANAGER, distinctId).catch(() => false);
  cached = on;
  return on;
}

/**
 * The last resolved answer, or `false` if none has landed yet.
 *
 * A spawn that happens in the window before the first resolve runs UNENROLLED.
 * That is the correct bias while the subsystem is off by default: an unenrolled
 * spawn is exactly the pre-feature behaviour, whereas a wrongly-enrolled one
 * confines a process into a cgroup the operator may not be ready to manage.
 */
export function taskManagerEnabledSync(): boolean {
  return cached === true;
}

/**
 * Kick off a resolve without awaiting it, for the sync seams' module-load path.
 * Coalesced — three separate spawn modules import this and warm it at load.
 */
export function warmTaskManagerFlag(): void {
  if (inflight) return;
  inflight = isTaskManagerEnabled('task-manager:warm').finally(() => {
    inflight = null;
  });
  void inflight.catch(() => {});
}

// A flip must not require an operator restart to take effect at the sync seams —
// otherwise "turn it off" is only true for the surfaces that re-read per request.
onFlagChange((key) => {
  if (key === null || key === FLAGS.TASK_MANAGER) {
    cached = null;
    warmTaskManagerFlag();
  }
});

/** Test seam — set the cached answer directly, or clear it with no argument. */
export function setTaskManagerEnabledForTest(value: boolean | null = null): void {
  cached = value;
  inflight = null;
}
