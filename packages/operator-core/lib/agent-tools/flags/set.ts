/**
 * flags:set - flip a Papercusp feature flag on or off in PostHog.
 *
 * High-tier tool: changes the live behavior of the entire app. Audited
 * via harness_shared.audit_log; agents are expected to provide a reason.
 *
 * Returns 4xx-like errors via the standard tool error shape if PostHog
 * is unconfigured, unreachable, or the flag does not yet exist in
 * PostHog. Flags must be pre-created in the PostHog UI before this tool
 * can flip them; that one-time setup lives in Phase 1 of the V1 plan.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { setFlag } from '@papercusp/flags/server';
import { publishFlagChange } from '../../flag-bus';
import './_register-backend';

const FlagKeySchema = z.enum(ALL_FLAG_KEYS as unknown as [FlagKey, ...FlagKey[]]);

export default defineTool({
  name: 'flags:set',
  profile: 'engineer',
  // P-062 Phase 4: an operator-level action; its only PG write is to the
  // operator audit_log (whose INSERT carries no workspace_id), so it runs on
  // the admin (rolbypassrls) handle rather than a workspace-scoped RLS tx.
  crossWorkspace: true,
  description:
    'Flip a Papercusp feature flag on or off in PostHog. High-risk: changes app-wide behavior. Provide a clear reason; it is recorded for audit.',
  capability: 'audit:write',
  guidance: {
    when: 'User explicitly asks to enable / disable a feature, OR Papercusp is being prepared for a release and the V1 ship state needs to be set.',
    notWhen: 'For ad-hoc testing of UI behavior, prefer the PostHog dashboard so changes are visible to other agents and humans.',
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  args: z.object({
    key: FlagKeySchema,
    enabled: z.boolean(),
    reason: z.string().min(8, 'Provide a short reason (>=8 chars) for the audit log.'),
  }),
  async handler(args, ctx) {
    const result = await setFlag(args.key, args.enabled);
    if (!result.ok) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, reason: result.reason, key: args.key }, null, 2),
          },
        ],
        isError: true,
      };
    }
    publishFlagChange(args.key);

    // EI-293: the prior inline INSERT omitted the NOT-NULL id + workspace_id
    // columns, so every flag audit silently failed in its try/catch (0
    // flag:set rows ever landed). recordFlagAudit writes the correct
    // full-column row (shared with the HTTP /api/flags/set path).
    const { recordFlagAudit } = await import('../../flag-audit');
    await recordFlagAudit(args.key, args.enabled, ctx?.principal?.slug ?? 'agent', {
      reason: args.reason,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, key: args.key, enabled: args.enabled }, null, 2),
        },
      ],
    };
  },
});
