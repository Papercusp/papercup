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
 */
import { getOrgPg } from '@papercusp/db-org';
import { registerSystemAction, type SystemActionCtx } from './system-actions';
import { getBrainSession } from '../../brain-pin';
import { wakeRecipients } from '../../agent-tools/coordination/inbox-wake';

export const WAKE_BRAIN_ACTION = 'wake-brain';

/**
 * Resolve the pinned brain session's live coord owner id (the inbox-wake target):
 * the brain pin holds the brain's NATIVE session uuid (brain-pin.ts), and
 * `adv_sessions.session_id` carries that same uuid (mig 115) joined to the
 * session's `coord_owner_id`. Returns null when no brain is pinned or it isn't
 * currently tracked (nothing to wake). Exported for unit testing.
 */
export async function resolveBrainOwner(): Promise<string | null> {
  const brainSessionId = await getBrainSession();
  if (!brainSessionId) return null;
  const { sql } = getOrgPg();
  const rows = await sql`
    SELECT coord_owner_id
    FROM harness_shared.adv_sessions
    WHERE session_id = ${brainSessionId} AND coord_owner_id IS NOT NULL
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return (rows[0] as { coord_owner_id?: string } | undefined)?.coord_owner_id ?? null;
}

registerSystemAction(WAKE_BRAIN_ACTION, async (ctx: SystemActionCtx) => {
  // OPT-IN: the autonomous Queen only fires under HIVE_AGENT_TABS. Off → no-op
  // (the brain remains a responsive engineer session). Dynamic import mirrors
  // harness-core.ts so flag eval never load-orders ahead of the flag bus.
  const { FLAGS } = await import('@papercusp/flags');
  const { getFlag } = await import('@papercusp/flags/server');
  if (!(await getFlag(FLAGS.HIVE_AGENT_TABS, 'system'))) return;

  const owner = await resolveBrainOwner();
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
