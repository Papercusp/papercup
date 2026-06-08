/**
 * hive:get — the full state of one hive (hive-tool-namespace-2026-06-08 P-003,
 * D-001).
 *
 * The unified hive view: `resolveHive` (home harness + deployment + wake) joined
 * with the live fleet (bees with {doing, queued, load} via fleet:assignments) and
 * the frontier (todo work-items in the hive's harness). A pure aggregator — no
 * new state — composing the canonical readers rather than reimplementing them.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { groupByAgent, listFleetAssignments } from '../../fleet/assignments';
import { listWorkItems } from '../../work-items';
import { resolveHive } from './_resolve';
import { hiveFederationTopicHex } from '../../hive-identity';

export default defineTool({
  name: 'hive:get',
  profile: 'engineer',
  description:
    'The full state of one hive: its home harness + deployment + wake schedule (scheduled?, next/last fire, event subscriptions), its live bees with {doing, queued, load}, and its todo-work frontier depth. Composes resolveHive + fleet:assignments + work_items — the one call for "how is hive X doing".',
  guidance: {
    when: 'You want one hive in depth: is the Queen scheduled to wake, who are the bees and how loaded, how much work is queued.',
    notWhen: 'A list of all hives — hive:list. The raw per-agent fleet view across the workspace — fleet:assignments.',
    chaining:
      'hive:list to find the slug; pot:wake to fire the Queen now; pot:declare-wake to change the cadence; hive:dissolve to tear it down.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    slug: z.string().min(1).max(120).describe("The hive's home-harness slug (or its hiveId)."),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const hive = await resolveHive(args.slug, workspaceId);
    if (!hive) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'hive_not_found',
              message: `No kind:'hive' harness '${args.slug}' in this workspace. Use hive:list to see the hives.`,
            }),
          },
        ],
      };
    }

    // Bees: live agents (+ orphaned claims) in the hive's home harness, with their
    // ordered work-lists — the Queen's placement read, scoped to this hive.
    const rows = await listFleetAssignments({ workspaceId, harness: hive.slug });
    const agents = groupByAgent(rows).filter((a) => a.alive || a.claims.length > 0);
    const bees = agents.map((a) => ({
      agentId: a.agentId,
      label: a.label,
      name: a.name,
      alive: a.alive,
      intent: a.intent,
      doing: a.doing,
      queued: a.queued,
      load: a.load,
    }));

    // Frontier: todo work-items in the hive's harness — the queue depth the Queen
    // places from.
    const todo = await listWorkItems({ harness: hive.slug, state: 'todo', limit: 500 });

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            hive,
            // The hive's substrate federation topic (hex), derived from its pubkey
            // identity (shared-hive-federation P-003). null until the identity row
            // exists. The swarm-join call-site swap is the Phase-1 boundary.
            federationTopic: hive.pubkey ? hiveFederationTopicHex(hive.pubkey) : null,
            fleet: {
              bees,
              live: bees.filter((b) => b.alive).length,
              work_item_load: bees.reduce((n, b) => n + b.load, 0),
            },
            frontier: { todo_depth: todo.length },
          }),
        },
      ],
    };
  },
});
