/**
 * severe-event-broadcast — a process-level watchdog's "tell every running agent" rail.
 *
 * The gap this closes: the pipeline stall watchdogs (green-stall-watchdog, git-sync-stall-
 * watchdog) alarmed only via `notifyAttention` — an OWNER-facing toast. If the owner isn't
 * looking, a SEVERE pipeline event (green-checkpoint not producing greens; git-sync firing but
 * not committing — code silently stranding for hours) sat unclaimed. A fleet of agents IS
 * running and any of them could green the gate / rescue the stranded work — but they never saw
 * it.
 *
 * This broadcasts the event to ALL running agents (`to:['*']`) INJECT-ONLY (no wake): every
 * agent sees it in its inbox on its NEXT turn (via the always-armed inbox rail), so someone
 * claims it — WITHOUT a storm of forced wake-ups mid-turn (owner-requested: wake=false). It is
 * the coordination-floor complement to the owner toast, not a replacement.
 *
 * Best-effort + fail-soft: a broadcast failure must NEVER break the watchdog sweep that calls it.
 */
import { sendMessage } from './agent-tools/coordination/messages';
import type { AgentIdentity } from './agent-tools/coordination/identity';

/** The system identity severe-event broadcasts are attributed to (mirrors the
 *  hive-owner-key-health escalation identity — a workspace-level system sender). */
const SEVERE_EVENT_IDENTITY: AgentIdentity = {
  ownerId: 'system-watchdog',
  ownerLabel: 'system-watchdog',
  source: 'static-client',
  workspaceId: null,
  userId: null,
};

export interface SevereEventBroadcast {
  /** One-line inbox summary — what's wrong + that it's claimable. */
  summary: string;
  /** Optional fuller body (evidence + the recommended first step). */
  body?: string;
  /** Ambient category for coord:inbox filtering (default 'severe-event'). */
  category?: string;
}

/**
 * Broadcast a SEVERE pipeline event to every running agent, inject-only (no wake). Seen on the
 * recipient's next turn so someone claims it. Never throws.
 */
export async function broadcastSevereEvent(ev: SevereEventBroadcast): Promise<boolean> {
  try {
    // No `wake` option ⇒ plain inject (the owner-requested wake=false): lands in every agent's
    // inbox for their next turn, no forced re-invoke storm.
    await sendMessage(SEVERE_EVENT_IDENTITY, {
      to: ['*'],
      summary: ev.summary,
      body: ev.body,
      category: ev.category ?? 'severe-event',
    });
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[severe-event-broadcast] failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
