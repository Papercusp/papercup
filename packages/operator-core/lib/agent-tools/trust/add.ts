/**
 * trust:add — trust a GitHub user so their VERIFIED remote work auto-runs
 * (shared-hive-trust-admission-2026-06-14 / P-009, D-001). A SECURITY GRANT: only the
 * owner should call it. Owner-scoped, local-only, never federated. Audited.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  name: 'trust:add',
  profile: 'engineer',
  // Writes the workspace-scoped trust row + audit row via the admin handle,
  // scoping itself by the resolved workspace id (D-004 — never relies on RLS).
  crossWorkspace: true,
  description:
    "Add a GitHub user id to the owner's LOCAL trust list — a SECURITY GRANT: a VERIFIED-author remote work item from this user may then auto-run on the owner's install (across every hive the owner is in), bypassing per-item screening. Owner-scoped, local-only, never federated. Audited.",
  capability: 'audit:write',
  guidance: {
    when: "The owner deliberately trusts a GitHub user so their verified remote work auto-runs without screening. Pass the numeric github_user_id (matches hive_members.github_user_id).",
    notWhen:
      'To see who is trusted use trust:list; to revoke use trust:remove. This grants auto-run privilege — only the owner grants trust (an unverified or self-claimed author is never auto-admitted regardless).',
    chaining: 'trust:list (who is trusted) → trust:add { githubUserId, note? }.',
  },
  requirePrincipal: false,
  agentRoles: ['operator'],
  args: z.object({
    githubUserId: z
      .number()
      .int()
      .positive()
      .describe('The GitHub numeric user id to trust (matches hive_members.github_user_id / the verified-author id).'),
    note: z.string().max(200).optional().describe('Optional human note, e.g. "alice@acme — co-maintainer". Diagnostic only.'),
  }),
  async handler(args, ctx) {
    const { activeWorkspaceId } = await import('../../workspace-registry');
    const { addTrustedUser } = await import('../../trust/user-trust-list');
    const principalWs = ctx?.principal?.workspaceId;
    const ws = principalWs && principalWs !== '*' ? principalWs : activeWorkspaceId();
    const actor = ctx?.principal?.slug ?? 'agent';
    try {
      const trusted = await addTrustedUser(ws, {
        githubUserId: args.githubUserId,
        note: args.note ?? null,
        actor,
        nowMs: Date.now(),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, workspaceId: ws, trusted }, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: (err as Error)?.message ?? 'add_failed' }, null, 2) }],
        isError: true,
      };
    }
  },
});
