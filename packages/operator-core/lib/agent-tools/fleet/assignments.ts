/**
 * fleet:assignments — query the canonical fleet-assignment state (state-not-chat-
 * fleet-state-2026-06-05, D-002 / P-003).
 *
 * THE state query for "who's running / what is X doing / is anyone on plan P".
 * Reads harness_shared.fleet_assignment (presence + plan-item claims/assignments +
 * work-item claims, claim-primary with holder liveness joined in) — one query, no
 * message-replay. Want to be NOTIFIED of changes instead? Subscribe the
 * 'fleet_assignment' PG NOTIFY channel (lib/fleet-assignment-bus). The coord inbox
 * is for messages addressed to you — not for deriving fleet state (D-001).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import {
  groupByAgent,
  listFleetAssignments,
  orphanedClaims,
  summarizeOrphan,
} from '../../fleet/assignments';

export default defineTool({
  name: 'fleet:assignments',
  profile: 'engineer',
  description:
    'The canonical "who\'s on what" query: per-agent presence + plan-item claims + work-item claims unified (claim-primary, holder liveness joined in). Surfaces orphaned claims (live lease, dead holder = abandoned work) and declared-but-unclaimed intents.',
  guidance: {
    when: 'Answering "who\'s running / what is agent X doing / is anyone on plan P / is that work actually being worked". This is the state query — use it instead of scanning coord:inbox or replaying lifecycle messages.',
    notWhen:
      'You want to be notified of future changes (subscribe the fleet_assignment change-feed / your coord subscriptions) or you need full message history (coord:inbox).',
    chaining:
      'fleet:assignments { plan } → see an orphaned claim → work_items:release / plan_items:release to free it, or coord:send the holder. fleet:assignments { agent } before messaging an agent about its work.',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    agent: z
      .string()
      .max(120)
      .optional()
      .describe('Filter to one agent (ownerId or adopted agent-name) — "what is X doing".'),
    plan: z.string().max(200).optional().describe('Filter to one plan slug — "who\'s on P".'),
    harness: z.string().max(80).optional(),
    workspace: z.string().max(120).optional(),
    include_stale: z
      .boolean()
      .optional()
      .describe('Also list stale idle agents (no claims, old heartbeat). Default false. Orphaned claims always show regardless.'),
    include_lapsed: z
      .boolean()
      .optional()
      .describe('Include lapsed (expired, unreclaimed) plan-item leases. Default false.'),
  }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? null;
    const rows = await listFleetAssignments({
      workspaceId,
      agent: args.agent,
      plan: args.plan,
      harness: args.harness,
      activeOnly: !args.include_lapsed,
    });
    const agents = groupByAgent(rows).filter(
      (g) => args.include_stale || g.claims.length > 0 || g.alive,
    );
    const orphans = orphanedClaims(rows);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            summary: {
              agents: agents.length,
              alive: agents.filter((a) => a.alive).length,
              claims: rows.filter((r) => r.source !== 'presence').length,
              orphaned_claims: orphans.length,
              declared_unclaimed: agents.filter((a) => a.declaredUnclaimed).length,
            },
            // Abandoned work first — the reason this view is claim-primary.
            orphaned: orphans.map(summarizeOrphan),
            agents,
          }),
        },
      ],
    };
  },
});
