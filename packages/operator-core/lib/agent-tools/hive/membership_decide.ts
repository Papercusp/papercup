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
import { runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText, LIMITS } from '../limits';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

const Decision = z.object({
  githubUserId: z.number().int().positive().describe("The pending joiner's numeric GitHub user id (from hive:membership_pending)."),
  decision: z.enum(['approve', 'deny']).describe('approve = trust-admit; deny = reject (never admitted).'),
  reason: softText(LIMITS.ANNOTATION).optional().describe('Optional note (e.g. a deny reason), federated back to the joiner. Auto-truncated to 2000 chars if longer.'),
});

export default defineTool({
  name: 'hive:membership_decide',
  profile: 'engineer',
  description:
    "OWNER decision on one OR many pending-join requests for a Hive: approve (trust-admit the joiner + their captured devices) or deny (never admitted). Pass a single `{ githubUserId, decision, reason? }` for one or `items:[{ githubUserId, decision, reason? }]` for several. Requires this Swarm to hold the Hive key (the owning Swarm). Returns { ok, results:[{ ok, githubUserId, … | error }], counts } — correlate by githubUserId, not position; one failure never fails the rest.",
  guidance: {
    when: 'Joiner(s) are pending under approval-mode membership (see hive:membership_pending) and you (the owner) want to admit or reject them. Clearing a queue? Pass them all via `items:[{ githubUserId, decision }]`.',
    notWhen:
      'Banning an already-admitted member for abuse — use hive:ban_member (revoke + re-key teeth). Setting the membership mode itself — that is hive policy.',
    chaining: 'hive:membership_pending (review the queue) → hive:membership_decide (per joiner, or all at once via items[]). Bulk: correlate by githubUserId, not position; one failure never fails the rest.',
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: ['operator', 'architect', 'debugger'],
  args: z
    .object({
      hive: z.string().min(1).max(120).describe("The Hive's home harness slug (batch-level — one Hive per call)."),
      githubUserId: z.number().int().positive().optional().describe('n=1: a single pending joiner id (pair with decision).'),
      decision: z.enum(['approve', 'deny']).optional().describe('n=1: the decision for the single githubUserId.'),
      reason: softText(LIMITS.ANNOTATION).optional().describe('n=1: optional note for the single decision. Auto-truncated to 2000 chars if longer.'),
      items: z.array(Decision).min(1).max(100).optional().describe('decisions to apply (1–100), each { githubUserId, decision, reason? }'),
      workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.githubUserId) && Boolean(a.decision)), {
      message: 'pass `{ githubUserId, decision }` (one) or `items:[{ githubUserId, decision }]` (many)',
    }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    // Owner gate (once for the batch): only the Swarm that holds the Hive private key may decide.
    const ownerPubkey = await loadHivePubkey(workspaceId, args.hive).catch(() => null);
    if (!ownerPubkey) {
      return text({ ok: false, code: 'not_owner', detail: 'this Swarm does not hold the Hive private key' });
    }
    const identity = await resolveLocalGithubIdentity();
    const decidedBy = identity.kind === 'ok' ? identity.githubUserId : 0;
    if (!decidedBy) {
      return text({ ok: false, code: 'no_owner_identity', detail: 'could not resolve the local GitHub identity' });
    }

    const decisions = args.items?.length
      ? args.items
      : [{ githubUserId: args.githubUserId!, decision: args.decision!, reason: args.reason }];
    const env = await runBulk(
      decisions,
      async ({ githubUserId, decision, reason }) => {
        const result =
          decision === 'approve'
            ? await approvePendingJoin({ workspaceId, hiveHomeSlug: args.hive, githubUserId, decidedByGithubUserId: decidedBy })
            : await denyPendingJoin({ workspaceId, hiveHomeSlug: args.hive, githubUserId, decidedByGithubUserId: decidedBy, reason: clampText(reason, LIMITS.ANNOTATION) ?? null });
        // approvePendingJoin/denyPendingJoin return their own { ok, … }; surface it
        // verbatim, keyed by githubUserId.
        return { ...result, ok: (result as { ok?: boolean }).ok !== false, githubUserId };
      },
      { keyOf: ({ githubUserId }) => ({ githubUserId }) },
    );
    return bulkContent(env);
  },
});
