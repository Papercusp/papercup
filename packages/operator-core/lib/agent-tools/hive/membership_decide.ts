/**
 * hive:membership_decide — OWNER approves or denies a pending-join request
 * (Brief EN-3 / P-MEMBER, the owner approve/deny surface — decide half).
 *
 * Approve → trust-admit the joiner (upsertHiveMember with the request's captured
 * devices) + mark 'approved' (federates the decision back). Deny → mark 'denied';
 * the joiner is NEVER trust-admitted.
 *
 * AUTHORITY: the OWNING SWARM (holds the Hive private key — loadHivePubkey != null),
 * the same keypair-native owner gate revokeHiveContributor / hive-policy-author use.
 * A claimed viewer on a non-owning Swarm cannot decide (it isn't the canonical owner).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { loadHivePubkey } from '../../identity/hive-keypair';
import { resolveLocalGithubIdentity } from '../../identity/resolve-local-github-identity';
import { approvePendingJoin, denyPendingJoin } from '../../hive-membership-admission';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'hive:membership_decide',
  profile: 'engineer',
  description:
    "OWNER decision on a pending-join request: approve (trust-admit the joiner + their captured devices) or deny (never admitted). Requires this Swarm to hold the Hive key (the owning Swarm). The approval flips a pending joiner into the trust set and federates; a denial is final until the owner approves later.",
  guidance: {
    when: 'A joiner is pending under approval-mode membership (see hive:membership_pending) and you (the owner) want to admit or reject them.',
    notWhen:
      'Banning an already-admitted member for abuse — use hive:ban_member (revoke + re-key teeth). Setting the membership mode itself — that is hive policy.',
    chaining: 'hive:membership_pending (review the queue) → hive:membership_decide (per joiner).',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z.object({
    hive: z.string().min(1).max(120).describe("The Hive's home harness slug."),
    githubUserId: z
      .number()
      .int()
      .positive()
      .describe('The pending joiner\'s numeric GitHub user id (from hive:membership_pending).'),
    decision: z.enum(['approve', 'deny']).describe('approve = trust-admit; deny = reject (never admitted).'),
    reason: z.string().max(2000).optional().describe('Optional note (e.g. a deny reason), federated back to the joiner.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    // Owner gate: only the Swarm that holds the Hive private key may decide.
    const ownerPubkey = await loadHivePubkey(workspaceId, args.hive).catch(() => null);
    if (!ownerPubkey) {
      return text({ ok: false, code: 'not_owner', detail: 'this Swarm does not hold the Hive private key' });
    }

    const identity = await resolveLocalGithubIdentity();
    const decidedBy = identity.kind === 'ok' ? identity.githubUserId : 0;
    if (!decidedBy) {
      return text({ ok: false, code: 'no_owner_identity', detail: 'could not resolve the local GitHub identity' });
    }

    const result =
      args.decision === 'approve'
        ? await approvePendingJoin(
            { workspaceId, hiveHomeSlug: args.hive, githubUserId: args.githubUserId, decidedByGithubUserId: decidedBy },
          )
        : await denyPendingJoin(
            {
              workspaceId,
              hiveHomeSlug: args.hive,
              githubUserId: args.githubUserId,
              decidedByGithubUserId: decidedBy,
              reason: args.reason ?? null,
            },
          );

    return text({ ...result });
  },
});
