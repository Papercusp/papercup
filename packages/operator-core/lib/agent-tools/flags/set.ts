/**
 * flags:set - flip a Papercusp feature flag on or off in PostHog.
 *
 * High-tier tool: changes the live behavior of the entire app. Audited
 * via harness_shared.audit_log; agents are expected to provide a reason.
 *
 * With PostHog configured the flip lands there (and any stale PG override for the key
 * is cleared so it can't shadow PostHog); without PostHog the flip lands
 * in the PG-backed override store (audit P-070, EI-76) — runtime flag
 * toggling on dev boxes with no PostHog and no process restart.
 *
 * Returns success via either backend; errors if both fail.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { setFlag, setFlagOverride } from '@papercusp/flags/server';
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
    if (result.ok) {
      // The flip lives in PostHog now — drop any PG override so it can't
      // shadow later PostHog changes.
      await setFlagOverride(args.key, null);
      publishFlagChange(args.key);
      const { recordFlagAudit } = await import('../../flag-audit');
      await recordFlagAudit(args.key, args.enabled, ctx?.principal?.slug ?? 'agent', {
        reason: args.reason,
        backend: 'posthog',
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, key: args.key, enabled: args.enabled, backend: 'posthog' }, null, 2),
          },
        ],
      };
    }

    // Fallback to PG override if PostHog is not configured
    if (result.reason === 'flag-backend-not-configured') {
      const override = await setFlagOverride(args.key, args.enabled);
      if (override.ok) {
        publishFlagChange(args.key);
        const { recordFlagAudit } = await import('../../flag-audit');
        await recordFlagAudit(args.key, args.enabled, ctx?.principal?.slug ?? 'agent', {
          reason: args.reason,
          backend: 'pg-override',
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, key: args.key, enabled: args.enabled, backend: 'pg-override' }, null, 2),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: false, reason: override.reason, key: args.key }, null, 2),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: false, reason: result.reason, key: args.key }, null, 2),
        },
      ],
      isError: true,
    };
  },
});
