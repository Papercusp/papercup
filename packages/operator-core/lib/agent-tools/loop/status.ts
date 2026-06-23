/**
 * loop:status — read the loop on your own session (or another owner's): is it
 * active, its interval, whether its turn is in flight (parked), the next/last
 * fire, and the cost-cap (loop-routines-interval-recurrence-2026-06-20, B-LOOP-5).
 * The targeted "observe a loop" read; fleet:assignments shows the work the loop
 * is creating, and the routine fire-history shows each wake.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolveAgentIdentity } from '../coordination/identity';
import { getLoopStatus } from '../../harness/routines/loop';
import {
  probeWakeReachability,
  type WakeReachabilityVerdict,
} from '../../events/await/wake-reachability';

export default defineTool({
  name: 'loop:status',
  profile: 'engineer',
  description:
    "Inspect the loop on your own session (or another owner's, with `ownerId`): active?, interval, parked (turn in flight), next/last fire, cost-cap. Returns null when no loop exists for the owner.",
  guidance: {
    when: 'Check whether your loop is still armed + when it next fires, or inspect another agent\'s loop.',
    notWhen: 'See the WORK a loop is producing — that is fleet:assignments (the self-assigned work_items). Whole-engine health — autoloop:status.',
    chaining: 'loop:arm to start; loop:end to stop.',
  },
  capability: 'routines:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    ownerId: z
      .string()
      .max(120)
      .optional()
      .describe('Inspect the loop for this owner id (default: yourself).'),
  }),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const ownerId = args.ownerId ?? identity.ownerId;
    const status = await getLoopStatus(ownerId);

    // WI-655 — surface LIVE wake-reachability alongside the loop row: an active loop
    // whose owner can't receive a wake (the `no-session-now` black-hole) reads as a loud
    // `reachable:false` here rather than only as a stale lastDeliveryOutcome. Best-effort.
    let reachability: WakeReachabilityVerdict | null = null;
    if (status?.active) {
      reachability = await probeWakeReachability(ownerId).catch(() => null);
    }
    const reachabilityOut = reachability
      ? {
          reachable: reachability.reachable,
          channel: reachability.channel,
          durableWhileAlive: reachability.durableWhileAlive,
          summary: reachability.summary,
          ...(reachability.warning ? { warning: reachability.warning } : {}),
        }
      : null;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, ownerId, loop: status, reachability: reachabilityOut }),
        },
      ],
    };
  },
});
