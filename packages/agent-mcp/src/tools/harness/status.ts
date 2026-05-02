/**
 * Get the live status of a harness — current iteration phase, recent
 * activity, in-flight work. Useful for "what is harness X doing right now?"
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  capability: 'harness:read',
  args: z.object({
    slug: z.string().min(1),
  }),
  async handler(args, ctx) {
    // Minimal v1: return project row + most recent audit_log entries
    // tagged with this harness as subject. Phase D may extend this with
    // live orchestrator state.
    const project = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT slug, status, updated_ts, spent_cents, budget_cents
        FROM harness_shared.projects
       WHERE slug = ${args.slug}
       LIMIT 1
    `;
    if (!project.length) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`harness ${args.slug} not found`],
      };
    }
    const recentActivity = await ctx.tx<
      Array<{ ts: number; action: string; actor: string; subject: string }>
    >`
      SELECT ts, action, actor, subject
        FROM harness_shared.audit_log
       WHERE subject = ${args.slug}
       ORDER BY ts DESC
       LIMIT 10
    `;
    return {
      data: {
        ...project[0],
        recentActivity,
      },
    };
  },
});
