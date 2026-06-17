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
 * workspace's pin (a demo instance's pin can't be mistaken for the desktop's).
 *
 * EI-908 (dormant-brain revival): this routine MUST fire the inbox-wake for a
 * DORMANT brain — that is its whole purpose (see the header contract above and
 * the title of the bug: "fires but never re-invokes the dormant brain"). An
 * earlier liveness guard here gated on a fresh `coord_presence` heartbeat and,
 * when stale, CLEARED the pin and no-op'd. That defeated the routine: an
 * idle-but-alive brain's heartbeat only fires on tool boundaries, so a brain
 * dormant past STALE_MS (10m) — exactly the case the cadence exists to revive —
 * was treated as dead, the durable dock pin destroyed, and no wake fired. The
 * guard also duplicated, badly, liveness logic the wake-executor already owns:
 * the await-event pump is the single liveness authority and is liveness-ADAPTIVE
 * (live managed pty → inject; live psu-host socket → inject in place; process
 * exited → headless `claude --resume <uuid> -p` spawned DETACHED, server-side,
 * no shell; uninjectable → park + inbox nudge; gone → drop) AND owner-scoped
 * (never cross-injects a foreign session, EI-151). So firing the inbox-wake
 * revives the brain in every state without any launch machinery the cron lacks.
 * resolveBrainOwner therefore just resolves the pinned session to its coord
 * owner and lets the executor decide delivery — no heartbeat gate, no pin clear.
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getBrainSession } from '../../brain-pin';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';

export const WAKE_BRAIN_ACTION = 'wake-brain';

/**
 * Resolve the pinned brain session's coord owner id (the inbox-wake target) for
 * `workspaceId`: the brain pin holds the brain's NATIVE session uuid
 * (brain-pin.ts), and `adv_sessions.session_id` carries that same uuid (mig 115)
 * joined to the session's `coord_owner_id`.
 *
 * Liveness is NOT gated here (EI-908): the wake-executor is the single
 * liveness-adaptive authority (inject a live session / resume a dead one
 * headless server-side / park an uninjectable one), so we return the owner
 * whenever the pin resolves to a tracked session and let the executor decide
 * how to deliver. Returns null only when no brain is pinned for the workspace
 * or the pinned session isn't tracked yet (no adv row — nothing to wake; the
 * launcher's own resolve handles a never-started pin). Exported for unit testing.
 */
export async function resolveBrainOwner(workspaceId: string): Promise<string | null> {
  const brainSessionId = await getBrainSession(workspaceId);
  if (!brainSessionId) return null;
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT s.coord_owner_id AS coord_owner_id
    FROM harness_shared.adv_sessions s
    WHERE s.session_id = ${brainSessionId} AND s.coord_owner_id IS NOT NULL
    ORDER BY s.started_at DESC
    LIMIT 1
  `;
  const row = rows[0] as { coord_owner_id?: string } | undefined;
  return row?.coord_owner_id ?? null;
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
