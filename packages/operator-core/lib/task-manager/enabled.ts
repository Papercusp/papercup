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
 * FAILS OPEN. This bias flipped on 2026-08-02 (WI-6844, owner-directed: "we put
 * it behind a testing flag. Remove that flag, we'll make it part of our standard
 * release"). The flag graduated out of DARK_FLAGS and now derives default-ON, so
 * the subsystem is shipped, not unready — and for a shipped subsystem it is the
 * ABSENCE that is the outage: an unreachable flag backend must not silently
 * un-confine and un-ledger every process on the box, leaving the reconciler with
 * nothing to reconcile and `processes:list` reporting disabled. Unknown ⇒ on,
 * which is what the two original call sites did (`.catch(() => true)`) before
 * WI-6499 inverted them for the testing window.
 *
 * The flag KEY deliberately survives as a runtime kill-switch: this subsystem
 * intercepts every spawn seam on the box, so an explicit OFF at /admin/features
 * must still restore the pre-feature behaviour byte-for-byte without a revert.
 * An explicit `false` from the backend is always honoured — only the UNKNOWN
 * case changed.
 */

import { FLAGS } from '@papercusp/flags';
import { getFlag, onFlagChange } from '@papercusp/flags/server';

/** null = "not resolved yet", which reads as ON for sync callers (fail-open). */
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
  const on = await getFlag(FLAGS.TASK_MANAGER, distinctId).catch(() => true);
  cached = on;
  return on;
}

/**
 * The last resolved answer, or `true` if none has landed yet (fail-open).
 *
 * A spawn in the window before the first resolve is ENROLLED. That is the
 * correct bias now that the subsystem ships default-ON: an unenrolled spawn is
 * invisible to the ledger FOREVER (enrolment binds at spawn and cannot be
 * applied retroactively), so a boot-window miss permanently punches a hole in
 * the no-escape property — whereas a spawn enrolled a moment before an explicit
 * OFF resolves is merely confined into a cgroup we then stop reconciling, which
 * the next reconcile tick closes out cleanly.
 */
export function taskManagerEnabledSync(): boolean {
  return cached !== false;
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
