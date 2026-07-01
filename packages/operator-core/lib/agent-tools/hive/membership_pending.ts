/**
 * hive:membership_pending — list a Hive's approval-mode pending-join requests
 * (Brief EN-3 / P-MEMBER, the owner approve/deny surface — read half).
 *
 * Under `membership: 'approval'`, a joiner's request lands in hive_pending_joins and
 * federates to the owner. This is the owner's queue view. Read-only; the decide half
 * is hive:membership_decide.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { listPendingJoins } from '../../hive-pending-joins-store';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'hive:membership_pending',
  profile: 'engineer',
  description:
    "List a Hive's pending-join requests (the approval-mode admission queue). Under membership:'approval' a joiner stays pending until the owner approves; this is the owner's review queue. Read-only — decide with hive:membership_decide.",
  guidance: {
    when: "The Hive's membership policy is 'approval' and you (the owner) want to see who's waiting to join. Pair with hive:membership_decide to approve/deny.",
    notWhen:
      'For the trust roster (already-admitted members) use hive:get / harness:membership. Setting the membership MODE is hive policy (the policy authoring surface), not this.',
    chaining: 'hive:membership_pending (review) → hive:membership_decide (approve/deny each).',
    seeAlso: [
      'hive:membership_decide (approve/deny each pending join)',
      'hive:add-member (add a member directly without a pending request)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z.string().min(1).max(120).describe("The Hive's home harness slug."),
    status: z
      .enum(['pending', 'approved', 'denied', 'all'])
      .optional()
      .describe("Filter by decision status (default 'pending' — the open queue). 'all' = full history."),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const status = args.status === 'all' ? null : args.status; // undefined ⇒ store default 'pending'
    const rows = await listPendingJoins(workspaceId, args.hive, { status });
    return text({ ok: true, hive: args.hive, count: rows.length, pending: rows });
  },
});
