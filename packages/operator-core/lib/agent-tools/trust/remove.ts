/**
 * trust:remove — revoke trust in a GitHub user
 * (shared-hive-trust-admission-2026-06-14 / P-009). Their verified remote work
 * returns to per-item screening. Owner-scoped, local-only. Audited.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'trust:remove',
  profile: 'engineer',
  // Deletes the workspace-scoped trust row + writes the audit row via the admin
  // handle, scoping itself by the resolved workspace id (D-004 — never relies on RLS).
  crossWorkspace: true,
  description:
    "Remove a GitHub user id from the owner's LOCAL trust list — revokes the auto-run privilege; their verified remote work returns to per-item screening. Owner-scoped, local-only. Audited.",
  capability: 'audit:write',
  guidance: {
    when: 'The owner revokes trust in a GitHub user (their remote work should no longer auto-run).',
    notWhen: 'To grant trust use trust:add; to view the list use trust:list.',
    chaining: 'trust:list → trust:remove { githubUserId }.',
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    githubUserId: z.number().int().positive().describe('The GitHub numeric user id to un-trust.'),
  }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { removeTrustedUser } = await import('../../trust/user-trust-list');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const actor = ctx?.principal?.slug ?? 'agent';
    const { removed } = await removeTrustedUser(ws, args.githubUserId, actor);
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, workspaceId: ws, githubUserId: args.githubUserId, removed }, null, 2) },
      ],
    };
  },
});
