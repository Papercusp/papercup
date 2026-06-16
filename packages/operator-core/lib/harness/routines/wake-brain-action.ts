/**
 * system:wake-brain — the autonomous-Queen cadence
 * (hive-agent-tabs-psu-tui-2026-06-09 P-005 / D-006 / D-002).
 *
 * The Queen IS the pinned `psu --brain` engineer session (D-006). This routine
 * makes it AUTONOMOUS without a parallel driver (D-002): on its cadence it WAKES
 * the EXISTING brain session — it does NOT spawn a fresh headless turn (that's the
 * agent-role routine path). The brain is always-armed at session start
 * (turn-lifecycle-control), so firing its inbox-wake re-invokes it for one
 * autonomous turn — exactly the shipped machinery a peer's `coord:send {wake:true}`
 * uses (`wakeRecipients` → `emitAwaitedEvent(coord:inbox-wake:<owner>)`).
 *
 * Flag-gated by HIVE_AGENT_TABS — OPT-IN. Flag-off → no-op (the brain stays a
 * responsive engineer session = current behavior; this protects the live fleet).
 * Re-run-safe (the handler runs as ONE durable step): a re-fired wake is
 * idempotent — it re-wakes a live brain or no-ops when none is live.
 *
 * EI-908: the brain pin is now workspace-scoped, so this reads its OWN
 * workspace's pin (a demo instance's pin can't be mistaken for the desktop's),
 * AND a liveness guard prefers re-pinning over waking a dormant ghost: if the
 * pinned session has no live `coord_presence` heartbeat it is treated as dead,
 * the stale pin is cleared so the next `psu --brain` mints fresh, and the tick
 * no-ops rather than waking a foreign/dead owner.
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getBrainSession, clearBrainSession } from '../../brain-pin';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';
import { STALE_MS } from '../../liveness';

export const WAKE_BRAIN_ACTION = 'wake-brain';

/**
 * Resolve the pinned brain session's live coord owner id (the inbox-wake target)
 * for `workspaceId`: the brain pin holds the brain's NATIVE session uuid
 * (brain-pin.ts), and `adv_sessions.session_id` carries that same uuid (mig 115)
 * joined to the session's `coord_owner_id`.
 *
 * EI-908 liveness guard: the owner is only returned when its `coord_presence`
 * heartbeat is fresher than STALE_MS (i.e. the session is genuinely live).
 * A pinned-but-dormant session (no presence row, or a heartbeat older than
 * STALE_MS) means the brain died — we CLEAR the stale pin (so the next
 * `psu --brain` mints a fresh re-pinning launch instead of resuming the dead
 * session) and return null. Returns null when no brain is pinned for the
 * workspace, the pinned session isn't tracked, or it is dormant. Exported for
 * unit testing.
 */
export async function resolveBrainOwner(workspaceId: string): Promise<string | null> {
  const brainSessionId = await getBrainSession(workspaceId);
  if (!brainSessionId) return null;
  const { sql } = getOrgPg();
  // Join coord_presence so we get the owner AND its heartbeat in one shot. A
  // tracked adv row with no presence row yields a null heartbeat → treated as
  // dormant (the session never came up, or its presence was reaped).
  const rows = await sql`
    SELECT s.coord_owner_id AS coord_owner_id,
           p.heartbeat_at   AS heartbeat_at
    FROM harness_shared.adv_sessions s
    LEFT JOIN harness_shared.coord_presence p ON p.owner_id = s.coord_owner_id
    WHERE s.session_id = ${brainSessionId} AND s.coord_owner_id IS NOT NULL
    ORDER BY s.started_at DESC
    LIMIT 1
  `;
  const row = rows[0] as { coord_owner_id?: string; heartbeat_at?: string | Date | null } | undefined;
  const owner = row?.coord_owner_id ?? null;
  if (!owner) {
    // Pinned but not tracked at all (no adv row): not a confirmed-dead session,
    // just nothing to wake — leave the pin (the launcher's own resolve handles it).
    return null;
  }

  const heartbeatMs = row?.heartbeat_at ? new Date(row.heartbeat_at).getTime() : NaN;
  const live = Number.isFinite(heartbeatMs) && Date.now() - heartbeatMs < STALE_MS;
  if (!live) {
    // Dormant/stale ghost: the pinned session is dead. Clear the stale pin so
    // the next launch re-pins a fresh brain rather than resuming the corpse,
    // and no-op this tick (don't wake a dead/foreign owner). Best-effort —
    // a clear failure must not throw the routine.
    try {
      await clearBrainSession(workspaceId);
    } catch {
      // swallow — the next live tick / launcher resolve will retry
    }
    return null;
  }
  return owner;
}

registerSystemAction(WAKE_BRAIN_ACTION, async (ctx: SystemActionCtx) => {
  // OPT-IN: the autonomous Queen only fires under HIVE_AGENT_TABS. Off → no-op
  // (the brain remains a responsive engineer session). Dynamic import mirrors
  // harness-core.ts so flag eval never load-orders ahead of the flag bus.
  const { FLAGS } = await import('@papercusp/flags');
  const { getFlag } = await import('@papercusp/flags/server');
  if (!(await getFlag(FLAGS.HIVE_AGENT_TABS, 'system'))) return;

  const owner = await resolveBrainOwner(ctx.workspaceId);
  if (!owner) return; // no pinned/live brain → nothing to wake

  const kickoff =
    typeof ctx.payloadTemplate?.kickoff === 'string' && ctx.payloadTemplate.kickoff.trim()
      ? ctx.payloadTemplate.kickoff
      : 'Autonomous Queen cadence tick — supervise the fleet and pick up the next work (hive-agent-tabs P-005).';
  await wakeRecipients([owner], {
    summary: kickoff,
    source: 'system:wake-brain',
    workspaceId: ctx.workspaceId,
  });
});
