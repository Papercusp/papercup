/**
 * substrate:revoke_contributor — MCP tool for OWNER-revocation of another contributor.
 *
 * Plan: substrate-revocation-v2 Component B / D-005.
 *
 * OWNER action: revoke a bad-actor contributor by deleting their GitHub
 * `user/<github_user_id>` branch (their Channel-2 binding artifact). Once
 * deleted, Component A's re-verify loop will detect the missing branch on its
 * next cycle and drop the contributor from live federation across all peers.
 *
 * Requires repo-admin GitHub token. DESTRUCTIVE — deletes a GitHub branch.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { revokeContributorViaGithub } from '@/lib/sync/hyperbee/revoke-contributor';

export default defineTool({
  name: 'substrate:revoke_contributor',
  profile: 'engineer',
  description:
    'OWNER action: revoke another contributor from a shared harness by deleting their GitHub user/<id> binding branch. The substrate drops them from live federation on its next channel-2 re-verify cycle. DESTRUCTIVE — requires repo-admin token.',
  capability: 'intel:write',
  guidance: {
    when: "OWNER action: revoke ANOTHER contributor by deleting their GitHub user/<id> binding branch (requires repo-admin token). The substrate then drops them on its next channel-2 re-verify. DESTRUCTIVE. Use when a contributor is a confirmed bad actor, their account is compromised, or they must be removed from the shared harness's federation entirely.",
    notWhen:
      'Revoking your OWN device — use `substrate:revoke_self_device` instead. Also not when the token does not have GitHub admin permissions on the shared repo.',
    chaining:
      "Resolve the contributor's githubUserId from the Contributors tab, `dev:dogfood_substrate_status`, or `harness:membership` first — githubUserId is the stable numeric GitHub user id, not the login.",
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger', 'architect'],
  args: z.object({
    workspaceId: z.string().min(1).describe('The workspace ID the harness belongs to.'),
    harnessSlug: z.string().min(1).describe('The harness slug to revoke the contributor from.'),
    githubUserId: z
      .number()
      .int()
      .positive()
      .describe(
        "The NUMERIC GitHub user id of the contributor to revoke (e.g. 12345). This is the stable id, not the login string. The branch deleted is 'user/<githubUserId>'.",
      ),
  }),
  async handler(args) {
    const result = await revokeContributorViaGithub(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
