/**
 * flags:set - flip one OR many Papercusp feature flags on or off in PostHog.
 *
 * High-tier tool: changes the live behavior of the entire app. Audited
 * via harness_shared.audit_log; agents are expected to provide a reason.
 *
 * With PostHog configured the flip lands there (and any stale PG override for the key
 * is cleared so it can't shadow PostHog); without PostHog the flip lands
 * in the PG-backed override store (audit P-070, EI-76) — runtime flag
 * toggling on dev boxes with no PostHog and no process restart.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `{ key, enabled }` for
 * one or `items:[{ key, enabled }]` for several (per-key enabled is
 * heterogeneous, so it rides `items`) → { ok, results:[{ ok, key, enabled,
 * backend | error }], counts }. Each flip is audited + publishes its own
 * flag-change; a backend failure on one key fails ONLY that key (the rest still
 * flip), with the batch's top-level ok:true and counts.failed the truth signal.
 * `reason` is batch-level.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';

import { ALL_FLAG_KEYS, type FlagKey } from '@papercusp/flags';
import { setFlag, setFlagOverride } from '@papercusp/flags/server';
import { publishFlagChange } from '../../flag-bus';
import { runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import './_register-backend';

const FlagKeySchema = z.enum(ALL_FLAG_KEYS as unknown as [FlagKey, ...FlagKey[]]);
const FlagFlip = z.object({ key: FlagKeySchema, enabled: z.boolean() });

export default defineTool({
  name: 'flags:set',
  profile: 'engineer',
  // P-062 Phase 4: an operator-level action; its only PG write is to the
  // operator audit_log (whose INSERT carries no workspace_id), so it runs on
  // the admin (rolbypassrls) handle rather than a workspace-scoped RLS tx.
  crossWorkspace: true,
  description:
    'Flip one OR many Papercusp feature flags on or off in PostHog. High-risk: changes app-wide behavior. Pass `{ key, enabled }` for one or `items:[{ key, enabled }]` for several. Provide a clear reason; it is recorded for audit. Returns { ok, results:[{ ok, key, enabled, backend | error }], counts } — correlate by key, not position; a backend failure on one key fails only that key.',
  capability: 'audit:write',
  guidance: {
    when: 'User explicitly asks to enable / disable feature(s), OR Papercusp is being prepared for a release and the V1 ship state needs to be set. Flipping several at once? Pass them all via `items:[{ key, enabled }]`.',
    notWhen: 'For ad-hoc testing of UI behavior, prefer the PostHog dashboard so changes are visible to other agents and humans.',
    seeAlso: [
      'flags:get (read the current value first)',
      'flags:list (all flags + defaults)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'architect'],
  args: z
    .object({
      key: FlagKeySchema.optional().describe('a single flag key (n=1 shorthand; pair with `enabled`)'),
      enabled: z.boolean().optional().describe('the new value for the single `key` (n=1 shorthand)'),
      items: z.array(FlagFlip).min(1).max(100).optional().describe('flag flips to apply (1–100), each { key, enabled }'),
      reason: z.string().min(8, 'Provide a short reason (>=8 chars) for the audit log.'),
    })
    .refine((a) => Boolean(a.items?.length) || (Boolean(a.key) && a.enabled !== undefined), {
      message: 'pass `{ key, enabled }` (one) or `items:[{ key, enabled }]` (many)',
    }),
  async handler(args, ctx) {
    const flips = args.items?.length ? args.items : [{ key: args.key!, enabled: args.enabled! }];
    const actor = ctx?.principal?.slug ?? 'agent';
    const env = await runBulk(
      flips,
      async ({ key, enabled }) => {
        const result = await setFlag(key, enabled);
        if (result.ok) {
          // The flip lives in PostHog now — drop any PG override so it can't
          // shadow later PostHog changes.
          await setFlagOverride(key, null);
          publishFlagChange(key);
          const { recordFlagAudit } = await import('../../flag-audit');
          await recordFlagAudit(key, enabled, actor, { reason: args.reason, backend: 'posthog' });
          return { ok: true as const, key, enabled, backend: 'posthog' as const };
        }
        // Fallback to PG override if PostHog is not configured.
        if (result.reason === 'flag-backend-not-configured') {
          const override = await setFlagOverride(key, enabled);
          if (override.ok) {
            publishFlagChange(key);
            const { recordFlagAudit } = await import('../../flag-audit');
            await recordFlagAudit(key, enabled, actor, { reason: args.reason, backend: 'pg-override' });
            return { ok: true as const, key, enabled, backend: 'pg-override' as const };
          }
          return { ok: false as const, key, error: override.reason };
        }
        return { ok: false as const, key, error: result.reason };
      },
      { keyOf: ({ key }) => ({ key }) },
    );
    return bulkContent(env);
  },
});
