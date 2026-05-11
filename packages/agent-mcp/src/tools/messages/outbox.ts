/**
 * Read a harness's outbox (messages it has sent). Useful for tracing
 * "what did harness X say recently?"
 *
 * Typed via `schemaOf(audit_log).select` — outbox is audit_log filtered
 * by actor=slug + action='send_message'.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@restart/db-org';
import { defineTool } from '../../define-tool';

const audit = generated.auditLogInHarnessShared;
const AuditSelect = schemaOf(audit).select;
type AuditRow = z.infer<typeof AuditSelect>;

export default defineTool({
  name: 'messages:outbox',
  capability: 'messages:read',
  guidance: {
    when: 'User asks "what did I send?", "did the message go through?", or you need to confirm a recent send.',
    notWhen: 'For incoming, use `messages:inbox`.',
  },
  args: z.object({
    slug: z.string().min(1),
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
  }),
  async handler(args, ctx) {
    if (!/^[a-z0-9._-]+$/i.test(args.slug)) {
      return {
        data: [],
        degraded: true,
        degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`],
      };
    }
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select({ ts: audit.ts, action: audit.action, subject: audit.subject, details: audit.details })
      .from(audit)
      .where(and(eq(audit.actor, args.slug), eq(audit.action, 'send_message')))
      .orderBy(desc(audit.ts))
      .limit(args.limit)) as Array<Pick<AuditRow, 'ts' | 'action' | 'subject' | 'details'>>;
    if (args.detail === 'summary') {
      return {
        data: rows.map((r) => ({ ts: r.ts, subject: r.subject })),
      };
    }
    return { data: rows };
  },
});
