/**
 * List pending_events in the workspace. Summary-only — pending_events
 * is a queue and concierge agents are observers, never consumers.
 *
 * Typed via `schemaOf(pending_events).select`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@restart/db-org';
import { defineTool } from '../../define-tool';

const pe = generated.pending_eventsInHarness_shared;
const PESelect = schemaOf(pe).select;
type PERow = z.infer<typeof PESelect>;

export default defineTool({
  name: 'pending_events:list',
  capability: 'pending_events:read',
  guidance: {
    when: 'User asks "what\'s queued up?", "what events are pending?", or you need to inspect the hook-event backlog.',
    notWhen: 'For approvals (plan reviews, escalations awaiting user yes/no), use `pending_reviews_list`. Pending EVENTS are hook plumbing; pending REVIEWS are user-facing decisions.',
  },
  args: z.object({
    detail: z.enum(['summary']).default('summary'),
    kind: z.string().optional(),
    targetRole: z.string().optional(),
    limit: z.number().int().positive().max(200).default(50),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const preds = [
      args.kind ? eq(pe.kind, args.kind) : undefined,
      args.targetRole ? eq(pe.target_role, args.targetRole) : undefined,
    ].filter((p): p is NonNullable<typeof p> => p !== undefined);
    const rows = (await txDb
      .select({
        id: pe.id,
        kind: pe.kind,
        target_role: pe.target_role,
        due_at: pe.due_at,
        created_at: pe.created_at,
        consumed_at: pe.consumed_at,
      })
      .from(pe)
      .where(preds.length ? and(...preds) : undefined)
      .orderBy(desc(pe.created_at))
      .limit(args.limit)) as Array<
      Pick<PERow, 'id' | 'kind' | 'target_role' | 'due_at' | 'created_at' | 'consumed_at'>
    >;
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
