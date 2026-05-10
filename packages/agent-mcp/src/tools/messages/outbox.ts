/**
 * Read a harness's outbox (messages it has sent). Useful for tracing
 * "what did harness X say recently?"
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  name: 'messages:outbox',
  capability: 'messages:read',
  args: z.object({
    slug: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
  }),
  async handler(args, ctx) {
    // The outbox is the union of per-harness messages tables filtered
    // by from_slug. We can use the consolidated audit_log as a proxy
    // (every executeAction including send_message audits there).
    if (!/^[a-z0-9._-]+$/i.test(args.slug)) {
      return {
        data: [],
        degraded: true,
        degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`],
      };
    }
    const rows = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT ts, action, subject, details
        FROM harness_shared.audit_log
       WHERE actor = ${args.slug} AND action = 'send_message'
       ORDER BY ts DESC
       LIMIT ${args.limit}
    `;
    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({
          ts: r.ts,
          subject: r.subject,
        })),
      };
    }
    return { data: rows };
  },
});
