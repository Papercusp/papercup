/**
 * fleet:drain — signal a running bee to gracefully wind down (local-hive-orchestration
 * P-051 / D-006).
 *
 * GRACEFUL EXIT (distinct from fleet:cancel's hard kill): send a message to a bee
 * asking it to checkpoint state, release resource locks + work-item claims, return
 * its work-list to the queue, and end its turn. The bee can comply or request a
 * deferral (propose/dispose). The Queen then waits bounded time before reclaiming
 * the slot.
 *
 * Mechanics:
 * - Sends coord:send with a "drain cue" message to the target bee.
 * - The bee's handler reads the cue and cooperates: commits work, releases locks,
 *   returns work-items to the unassigned pool, exits cleanly.
 * - The Queen monitors the bee's slot (fleet:assignments) and reclaims it when
 *   the occupant is gone.
 * - If the bee doesn't comply within a timeout (default 2 min), the Queen escalates
 *   or falls back to fleet:cancel (hard kill).
 *
 * NOT a new tool-endpoint; it reuses coord:send with a structured message. The bee's
 * handler (via a hook or reactive rule) detects the drain cue and acts.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';

export default defineTool({
  name: 'fleet:drain',
  description:
    'Signal one OR many running bees to gracefully wind down (checkpoint, release locks/claims, return work-list, exit). Pass `bee_id` for one or `bee_ids` for several. Distinct from fleet:cancel (hard kill). The bee can cooperate or request deferral (propose/dispose); the Queen waits bounded time before reclaiming the slot. Returns immediately; the drain is async. Returns { ok, results:[{ ok, bee_id, msg_id, … | error }], counts } — correlate by bee_id, not position; one failure never fails the rest.',
  guidance: {
    when: 'You (the Queen) want to reclaim bee slot(s): the occupant has low-priority work, is blocked, or the priorities have shifted. Send a drain cue to give each bee a chance to hand off cleanly. Reclaiming several at once? Pass them all via `bee_ids`.',
    notWhen:
      'The bee is actively running a high-priority task (let it finish naturally). Or if immediate slot reclaim is critical (use fleet:cancel). Or if the bee is unresponsive (use fleet:cancel after a timeout).',
    chaining: 'fleet:drain { bee_id } | { bee_ids:[…] } → (later, bounded) fleet:assignments { agent: bee_id } → fleet:spawn fresh. Bulk: correlate by bee_id, not position; one failure never fails the rest.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      bee_id: z.string().min(1).optional()
        .describe('Owner ID of one bee to drain (spawn_id or session id; n=1 shorthand for bee_ids:[id]).'),
      bee_ids: z.array(z.string().min(1)).min(1).max(100).optional()
        .describe('Owner IDs of the bees to drain (1–100).'),
      timeout_sec: z.number().int().positive().default(120)
        .describe('How long to wait for each bee to comply before escalation (seconds; default 120; batch-level).'),
      reason: z.string().optional()
        .describe('Why the slot is being reclaimed (for the audit log + the bee\'s acknowledgment; batch-level).'),
    })
    .refine((a) => Boolean(a.bee_id) || (a.bee_ids?.length ?? 0) > 0, {
      message: 'pass `bee_id` (one) or `bee_ids` (many)',
    }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const beeIds = mergeIds(args.bee_id, args.bee_ids);
    const summary = `Graceful drain cue: release your slot`;
    const body =
      `You are being asked to gracefully wind down and release your slot so the Queen can place higher-priority work.\n\n` +
      `**What to do:**\n` +
      `1. Checkpoint your state (commit any pending edits, save work-in-progress notes).\n` +
      `2. Release all locks (any files you have claimed via \`locks:acquire\`).\n` +
      `3. Unclaim your work-items (any items you are currently assigned to — return them to the pool via \`work_items:release\`).\n` +
      `4. End your turn cleanly (print \`DONE\` or \`IDLE\`; the Queen will let you sleep).\n\n` +
      `**Timeline:** The Queen will wait ~${args.timeout_sec} seconds for you to complete. If you need more time or can't comply (e.g., you're at a critical checkpoint), escalate with a brief message.\n\n` +
      (args.reason ? `**Reason:** ${args.reason}\n\n` : '') +
      `**Propose/dispose:** You own your timing. If you're in the middle of something checkpoint-safe, you may defer — reply with your status and the Queen will decide whether to wait or escalate.`;

    const env = await runBulk(
      beeIds,
      async (bee_id) => {
        // One drain cue PER bee — never a single broadcast: each bee must be the
        // sole recipient so its handler reacts to its own slot.
        const sent = await sendMessage(identity, { to: [bee_id], summary, body });
        return {
          ok: true as const,
          bee_id,
          msg_id: sent.msg_id,
          ts: sent.ts,
          timeout_sec: args.timeout_sec,
          next: `Monitor fleet:assignments to see when the bee releases its slot. On timeout, escalate or use fleet:cancel { spawn_id } if the bee doesn't comply.`,
        };
      },
      { keyOf: (bee_id) => ({ bee_id }) },
    );
    return bulkContent(env);
  },
});
