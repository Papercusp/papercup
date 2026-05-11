/**
 * Get the live status of a harness — current iteration phase, recent
 * activity, in-flight work. Useful for "what is harness X doing right now?"
 *
 * Typed via `schemaOf(projects).select` and `schemaOf(audit_log).select`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@restart/db-org';
import { defineTool } from '../../define-tool';

const projects = generated.projectsInHarness_shared;
const audit = generated.audit_logInHarness_shared;
const ProjectSelect = schemaOf(projects).select;
const AuditSelect = schemaOf(audit).select;
type ProjectRow = z.infer<typeof ProjectSelect>;
type AuditRow = z.infer<typeof AuditSelect>;

export default defineTool({
  name: 'harness:status',
  capability: 'harness:read',
  args: z.object({
    slug: z.string().min(1),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const projectRows = (await txDb
      .select({
        slug: projects.slug,
        status: projects.status,
        updated_ts: projects.updated_ts,
        spent_cents: projects.spent_cents,
        budget_cents: projects.budget_cents,
      })
      .from(projects)
      .where(eq(projects.slug, args.slug))
      .limit(1)) as Array<Pick<ProjectRow, 'slug' | 'status' | 'updated_ts' | 'spent_cents' | 'budget_cents'>>;
    if (!projectRows.length) {
      return {
        data: null,
        degraded: true,
        degradedReasons: [`harness ${args.slug} not found`],
      };
    }
    const recentActivity = (await txDb
      .select({ ts: audit.ts, action: audit.action, actor: audit.actor, subject: audit.subject })
      .from(audit)
      .where(eq(audit.subject, args.slug))
      .orderBy(desc(audit.ts))
      .limit(10)) as Array<Pick<AuditRow, 'ts' | 'action' | 'actor' | 'subject'>>;
    return {
      data: {
        ...projectRows[0],
        recentActivity,
      },
    };
  },
});
