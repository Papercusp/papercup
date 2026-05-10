/**
 * Read a harness's inbox (messages addressed to it). Useful for
 * "what messages are pending for harness X?"
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

const SLUG_RE = /^[a-z0-9._-]+$/i;

export default defineTool({
  name: 'messages:inbox',
  capability: 'messages:read',
  args: z.object({
    slug: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
    status: z.enum(['pending', 'acknowledged', 'all']).default('pending'),
    limit: z.number().int().positive().max(200).default(50),
  }),
  async handler(args, ctx) {
    if (!SLUG_RE.test(args.slug)) {
      return {
        data: [],
        degraded: true,
        degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`],
      };
    }
    // Per-harness messages live in `harness_<slug>.messages`. Slug is
    // validated by SLUG_RE above; identifier embedding via ctx.tx() is
    // safe.
    const schemaIdent = ctx.tx(`harness_${args.slug}`);
    const statusFilter = args.status === 'all' ? null : args.status;
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = await ctx.tx<Array<Record<string, unknown>>>`
        SELECT id, ts, from_slug, kind, subject, body, status
          FROM ${schemaIdent}.messages
         WHERE (${statusFilter}::text IS NULL OR status = ${statusFilter})
         ORDER BY ts DESC
         LIMIT ${args.limit}
      `;
    } catch (err) {
      return {
        data: [],
        degraded: true,
        degradedReasons: [
          `harness_${args.slug}.messages not readable: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({
          id: r.id,
          from: r.from_slug,
          kind: r.kind,
          subject: r.subject,
        })),
      };
    }
    return { data: rows };
  },
});
