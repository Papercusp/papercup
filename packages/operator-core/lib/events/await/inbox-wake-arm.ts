/**
 * armInboxWake / cancelInboxWake — the always-arm primitive
 * (turn-lifecycle-control-2026-06-08 D-001/D-002/D-003, P-002).
 *
 * Arming an agent's standing inbox-wake watch moves OUT of the agent's own
 * judgment (`coord:await-inbox`, "call this when idle") and INTO the harness
 * layer: the operator (re-)arms on every SessionStart so EVERY psu/Queen-
 * launched agent is wakeable even when it has no idea it will be woken. This is
 * pure composition over the shipped await primitive — `captureWakeHandleForOwner`
 * (the resume handle) + `upsertInboxWakeAwait` (idempotent registration on the
 * agent's own `coord:inbox-wake:<self>` key, the rendezvous a `coord:send
 * {wake:true}` fires). It builds no second wake pump.
 *
 * Idempotent by construction (D-002): re-arming refreshes the handle/floor/note
 * on the one standing row rather than duplicating, so calling it on every
 * lifecycle tick is safe. `coord:await-inbox` is now just an annotation on top
 * of this (D-005) — it refreshes the idle `note`, it is no longer the gate that
 * makes an agent wakeable.
 */

import { captureWakeHandleForOwner } from './handle';
import { upsertInboxWakeAwait, cancelInboxWakeAwaits } from './store';
import { startAwaitSweeper } from './engine';
import { inboxWakeKey } from '../../agent-tools/coordination/inbox-wake';

/** Standing inbox-wake floor (seconds): bursts of sends inside this window
 *  coalesce into one wake. Shares the watch primitive's env knob so the
 *  always-arm path and `coord:await-inbox` stay in lockstep. */
function idleWakeFloorSec(): number {
  const n = Number(process.env.PAPERCUSP_WATCH_MIN_SLEEP_SEC ?? 60);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}

export interface ArmInboxWakeResult {
  awaitId: number;
  eventKey: string;
  /** One line describing the captured wake-path quality (injectable/resumable
   *  vs inbox-degraded) — surfaced so a caller can log how good the wake is. */
  handleNote: string;
}

/**
 * (Re-)arm the standing inbox-wake watch for one agent. Safe to call on every
 * SessionStart / idle tick — it upserts the single standing row. Re-captures
 * the freshest resume handle each call (the native session id may only land in
 * adv_sessions shortly after the first arm; the executor also re-reads it at
 * fire time, so a null-handle first arm self-heals).
 */
export async function armInboxWake(input: {
  ownerId: string;
  note?: string | null;
  minSleepSec?: number | null;
  /** A plan run arming its own inbox-wake: the wake resumes the run via
   *  plans:resume instead of a session resume (overrides the captured handle). */
  planRunId?: number;
  workspaceId?: string;
}): Promise<ArmInboxWakeResult> {
  const key = inboxWakeKey(input.ownerId);
  startAwaitSweeper();
  const { handle, note: handleNote } = await captureWakeHandleForOwner(input.ownerId, {
    planRunId: input.planRunId,
  });
  const row = await upsertInboxWakeAwait({
    subscriberId: input.ownerId,
    eventKey: key,
    note: input.note ?? 'always-armed inbox-wake (turn-lifecycle-control)',
    wakeHandle: handle,
    minSleepSec: input.minSleepSec ?? idleWakeFloorSec(),
    workspaceId: input.workspaceId,
  });
  return { awaitId: row.id, eventKey: key, handleNote };
}

/** Cancel an agent's standing inbox-wake watch — SessionEnd hygiene (D-003:
 *  a deliberately-ended session is not a wake target). Returns rows cancelled. */
export async function cancelInboxWake(ownerId: string, workspaceId?: string): Promise<number> {
  return cancelInboxWakeAwaits(ownerId, workspaceId);
}
