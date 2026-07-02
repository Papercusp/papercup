/**
 * hive:report — any admitted MEMBER files a moderation report against content or
 * another member (Brief EN-3 / P-MOD, the report endpoint). The report federates to
 * the owner's moderation queue (hive:moderation_queue).
 *
 * Gated on the owner having ENABLED reporting (policy.moderation.reportable === true) —
 * absent ⇒ reporting off ⇒ today's behavior, unchanged (the brief's default).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { getHivePolicy } from '../../hive-policy-store';
import { resolveLocalGithubIdentity } from '../../identity/resolve-local-github-identity';
import { fileReport } from '../../hive-reports-store';
import { getHiveMember } from '../../hive-membership-store';
import { softText, clampText, LIMITS } from '../limits';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'hive:report',
  profile: 'engineer',
  description:
    "File a moderation report against content or a member in a Hive. The report federates to the owner's moderation queue. Requires the owner to have enabled reporting (moderation.reportable in the Hive policy); otherwise reporting is off and this no-ops.",
  guidance: {
    when: 'You are a member of a Hive with reporting enabled and want to flag abusive content or a member to the owner.',
    notWhen:
      'You ARE the owner taking action — use hive:takedown (hide content) / hive:ban_member (ban a member). Reporting is the member→owner signal, not the owner action.',
    chaining: 'hive:report (member flags) → owner reviews hive:moderation_queue → hive:moderation_resolve / hive:takedown / hive:ban_member.',
    seeAlso: [
      'hive:moderation_queue (where the owner reviews your flag)',
      'hive:takedown (owner action: hide the content)',
      'hive:ban_member (owner action: ban the member)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    hive: z.string().min(1).max(120).describe("The Hive's home harness slug."),
    targetKind: z.enum(['content', 'member']).describe("What's being reported: 'content' (a feature/work-item ref) or 'member'."),
    targetRef: z
      .string()
      .min(1)
      .max(200)
      .describe("The content ref (feature/work-item id) or the reported member's numeric github id."),
    reason: softText(LIMITS.ANNOTATION).optional().describe('Why — the reporter\'s free-text reason. Auto-truncated to 2000 chars if longer.'),
    workspace: z.string().max(120).optional().describe('Workspace id (default: ctx / active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();

    // Gate: reporting must be enabled by the owner-signed policy.
    const resolved = await getHivePolicy(workspaceId, args.hive).catch(() => null);
    if (!resolved?.policy.moderation?.reportable) {
      return text({ ok: false, code: 'reporting_not_enabled', detail: 'the Hive owner has not enabled reporting' });
    }

    const identity = await resolveLocalGithubIdentity();
    if (identity.kind !== 'ok') {
      return text({ ok: false, code: 'no_reporter_identity', detail: 'could not resolve the local GitHub identity' });
    }

    // WI-567 (report-after-leave abuse vector): a departed/never-joined member must not
    // be able to file reports — "any admitted MEMBER" is the doc contract, but nothing
    // previously checked it. Fail closed on a lookup error (never let an unresolvable
    // membership check silently admit the report).
    const member = await getHiveMember(workspaceId, args.hive, identity.githubUserId).catch(() => null);
    if (!member) {
      return text({
        ok: false,
        code: 'not_a_member',
        detail: 'you are not an admitted member of this Hive (left, banned, or never joined) — only admitted members may file reports',
      });
    }

    const report = await fileReport({
      workspaceId,
      hiveHomeSlug: args.hive,
      reporterGithubUserId: identity.githubUserId,
      reporterGithubUsername: identity.githubLogin,
      targetKind: args.targetKind,
      targetRef: args.targetRef,
      reportReason: clampText(args.reason, LIMITS.ANNOTATION) ?? null,
    });
    return text({ ok: true, report });
  },
});
