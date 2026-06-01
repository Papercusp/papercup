/**
 * List audit log entries for the current workspace.
 *
 * v1 is COARSE high-tier: returns every audit row in the workspace.
 * Per-row capability filtering (where an agent sees only rows whose
 * underlying capability they hold) is deferred to v1.5; it requires a
 * `required_capability` column on every audit producer (substrate +
 * plugins), which is fan-out work. For v1, `audit:read` is gated as
 * high-tier in capability-tiers.ts, so the install-time consent prompt
 * surfaces this as substantial trust.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';

export default defineTool({
  name: 'audit:list',
  profile: 'engineer',
  capability: 'audit:read',
  guidance: {
    when: 'User asks "what happened recently?", "who did X?", or you need a forensic timeline of agent + user actions.',
    notWhen: 'For ACTIVE / in-flight work, use `harness:status` or `actions:recent`. Audit is a write-log, not a live view.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    actor: z.string().optional(),
    action: z.string().optional(),
    sinceTs: z.number().int().optional(),
    limit: z.number().int().positive().max(500).default(100),
  }),
  async handler(args, ctx) {
    const rows: Array<{ id: string; ts: number; actor: string; action: string; subject: string; details: unknown }> = await ctx.tx`
      SELECT id, ts, actor, action, subject, details
        FROM harness_shared.audit_log
       WHERE (${args.actor ?? null}::text IS NULL OR actor = ${args.actor ?? null})
         AND (${args.action ?? null}::text IS NULL OR action = ${args.action ?? null})
         AND (${args.sinceTs ?? null}::bigint IS NULL OR ts >= ${args.sinceTs ?? null})
       ORDER BY ts DESC
       LIMIT ${args.limit}
    `;
    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({
          id: r.id,
          ts: r.ts,
          actor: r.actor,
          action: r.action,
          subject: r.subject,
        })),
      };
    }
    return { data: rows };
  },
});
