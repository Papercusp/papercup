/**
 * substrate:revoke_contributor — MCP tool for OWNER-revocation of another contributor.
 *
 * Plan: non-collaborator-join-fork-pr-2026-06-02 D-001 (supersedes the old
 * substrate-revocation-v2 branch-delete design).
 *
 * OWNER action: revoke a bad-actor contributor by adding their device pubkeys to
 * the harness revocation set (the owner's own contributor-row `revoked_pubkeys`,
 * which federates and is honored by every peer's `read-admission` union). The
 * contributor is dropped from live federation on the next admission re-verify.
 * Replaces the old branch-delete, which is a no-op in the write-free model
 * (admission is gated on the attestation gist, not a repo branch).
 *
 * Requires repo-admin GitHub token (the harness-owner authority gate).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { revokeContributorViaGithub } from '../../sync/hyperbee/revoke-contributor';

export default defineTool({
  name: 'substrate:revoke_contributor',
  profile: 'engineer',
  description:
    "OWNER action: revoke another contributor from a shared harness by adding their device pubkeys to the harness revocation set (revoked_pubkeys). Every peer honors it on the next admission re-verify and drops them from live federation. Requires repo-admin token.",
  capability: 'intel:write',
  guidance: {
    when: "OWNER action: revoke ANOTHER contributor by adding their device pubkeys to the harness revocation set (requires repo-admin token). Every peer drops them on its next admission re-verify. Use when a contributor is a confirmed bad actor, their account is compromised, or they must be removed from the shared harness's federation entirely.",
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
        'The NUMERIC GitHub user id of the contributor to revoke (e.g. 12345). This is the stable id, not the login string. Their device pubkeys are added to the harness revocation set.',
      ),
  }),
  async handler(args) {
    const result = await revokeContributorViaGithub(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
});
