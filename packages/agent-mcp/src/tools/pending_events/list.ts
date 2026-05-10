/**
 * List pending_events in the workspace. Summary-only — pending_events
 * is a queue and concierge agents are observers, never consumers.
 */

import { z } from 'zod';
import { defineTool } from '../../define-tool';

export default defineTool({
  name: 'pending_events:list',
  capability: 'pending_events:read',
  args: z.object({
    detail: z.enum(['summary']).default('summary'),
    kind: z.string().optional(),
    targetRole: z.string().optional(),
    limit: z.number().int().positive().max(200).default(50),
  }),
  async handler(args, ctx) {
    const rows = await ctx.tx<Array<Record<string, unknown>>>`
      SELECT id, kind, target_role, due_at, created_at, consumed_at
        FROM harness_shared.pending_events
       WHERE (${args.kind ?? null}::text IS NULL OR kind = ${args.kind ?? null})
         AND (${args.targetRole ?? null}::text IS NULL OR target_role = ${args.targetRole ?? null})
       ORDER BY created_at DESC
       LIMIT ${args.limit}
    `;
    return {
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        targetRole: r.target_role,
        dueAt: r.due_at,
        createdAt: r.created_at,
        consumed: r.consumed_at != null,
      })),
    };
  },
});
