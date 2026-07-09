/**
 * pot:report — any admitted MEMBER files a moderation report against content or
 * another member (Brief EN-3 / P-MOD, the report endpoint). The report federates to
 * the owner's moderation queue (pot:moderation_queue).
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
import { fileReport, countReportsSince } from '../../hive-reports-store';
import { getHiveMember } from '../../hive-membership-store';
import { softText, clampText, LIMITS } from '../limits';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

// WI-567 (report-spam abuse vector): cap how many reports one reporter can file in a
// Hive within a rolling window. Fixed, generous constants (not policy-configurable —
// no brief calls for owner tuning) so a scripted report-flood can't drown a real
// moderation queue; a legitimate reporter filing a handful of distinct reports never
// hits this.
const REPORT_RATE_LIMIT_MAX = 20;
const REPORT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export default defineTool({
  name: 'pot:report',
  profile: 'engineer',
  description:
    "File a moderation report against content or a member in a Hive. The report federates to the owner's moderation queue. Requires the owner to have enabled reporting (moderation.reportable in the Hive policy); otherwise reporting is off and this no-ops.",
  guidance: {
    when: 'You are a member of a Hive with reporting enabled and want to flag abusive content or a member to the owner.',
    notWhen:
      'You ARE the owner taking action — use pot:takedown (hide content) / pot:ban_member (ban a member). Reporting is the member→owner signal, not the owner action.',
    chaining: 'pot:report (member flags) → owner reviews pot:moderation_queue → pot:moderation_resolve / pot:takedown / pot:ban_member.',
    seeAlso: [
      'pot:moderation_queue (where the owner reviews your flag)',
      'pot:takedown (owner action: hide the content)',
      'pot:ban_member (owner action: ban the member)',
    ],
  },
  capability: 'harness:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    pot: z.string().min(1).max(120).describe("The Hive's home harness slug."),
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
    const resolved = await getHivePolicy(workspaceId, args.pot).catch(() => null);
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
    const member = await getHiveMember(workspaceId, args.pot, identity.githubUserId).catch(() => null);
    if (!member) {
      return text({
        ok: false,
        code: 'not_a_member',
        detail: 'you are not an admitted member of this Hive (left, banned, or never joined) — only admitted members may file reports',
      });
    }

    // WI-567 (report-spam abuse vector): rate-gate before writing. Fail OPEN on a
    // count-lookup error (never let a transient store fault block a legitimate
    // report — this is an abuse guard, not a correctness gate).
    const recentCount = await countReportsSince(
      workspaceId,
      args.pot,
      identity.githubUserId,
      Date.now() - REPORT_RATE_LIMIT_WINDOW_MS,
    ).catch(() => 0);
    if (recentCount >= REPORT_RATE_LIMIT_MAX) {
      return text({
        ok: false,
        code: 'rate_limited',
        detail: `you have filed ${recentCount} reports in this Hive in the last ${REPORT_RATE_LIMIT_WINDOW_MS / 60000} minutes (limit ${REPORT_RATE_LIMIT_MAX}) — wait before filing more`,
      });
    }

    const report = await fileReport({
      workspaceId,
      hiveHomeSlug: args.pot,
      reporterGithubUserId: identity.githubUserId,
      reporterGithubUsername: identity.githubLogin,
      targetKind: args.targetKind,
      targetRef: args.targetRef,
      reportReason: clampText(args.reason, LIMITS.ANNOTATION) ?? null,
    });
    return text({ ok: true, report });
  },
});
