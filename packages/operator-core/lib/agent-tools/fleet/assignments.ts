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
import { activeWorkspaceId } from '../../workspace-registry';
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
    'The canonical "who\'s on what" query: per-agent presence + plan-item claims + work-item claims unified (claim-primary, holder liveness joined in). Each live agent carries its ordered work-list — `doing` (head-of-line), `queued` (items in rank order), `load` (work-item count) — the externalized per-bee TodoWrite the Queen reads for placement (load → warm-inject vs fresh slot; head-of-line → evict judgment; the ordered plan → affinity). Surfaces orphaned claims (live lease, dead holder = abandoned work) and declared-but-unclaimed intents.',
  guidance: {
    when: 'Answering "who\'s running / what is agent X doing / what is X\'s ordered work-list / how loaded is X / is anyone on plan P". This is the state query AND the placement-decision read — use it instead of scanning coord:inbox or replaying lifecycle messages.',
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
    // A READ — identity is used only to default the optional workspace filter
    // (null = all workspaces). Resolve it SOFTLY so a bare loopback caller (the
    // pui bee-dossier pane, the IPC sys:http bridge) can read the state without
    // an attributable coord identity — this is not a coordination write.
    let actorWorkspace: string | null = null;
    try {
      actorWorkspace = resolveAgentIdentity(ctx).workspaceId ?? null;
    } catch {
      actorWorkspace = null;
    }
    // F-M1 (workspace-data-isolation-leaks): when neither an explicit workspace nor
    // a resolved identity is present, default to the ACTIVE workspace rather than
    // null (= ALL workspaces), so a bare loopback caller no longer reads every
    // workspace's fleet state. The data layer still ORs in GLOBAL + the plan-store
    // DEFAULT_WORKSPACE_ID scope (EI-295), so claim rows are preserved.
    const workspaceId = args.workspace ?? actorWorkspace ?? activeWorkspaceId();
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
              // P-021: total work-item load across live agents (the warm-inject signal).
              work_item_load: agents.reduce((n, a) => n + a.load, 0),
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
