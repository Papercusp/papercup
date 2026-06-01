/**
 * List harnesses registered in the current workspace.
 *
 * Returns slug, status, and last-activity timestamp for each. Use to
 * answer "what harnesses do I have?" or to find a slug before calling
 * harness:get / harness:status.
 *
 * Typed via `schemaOf(projects).select`.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';

const projects = generated.projectsInHarnessShared;
const ProjectSelect = schemaOf(projects).select;
type ProjectRow = z.infer<typeof ProjectSelect>;

export default defineTool({
  name: 'harness:list',
  profile: 'engineer',
  capability: 'harness:read',
  guidance: {
    when: 'User asks "what harnesses do I have?", "show me my projects", or you need a slug to feed into harness:get / harness:status.',
    notWhen: 'For ONE specific harness, use `harness:get`. For a single harness\'s live health (active/done counts), use `harness:status`.',
    chaining: 'Pair with `harness:get` (detail) or `harness:status` (live counts) once you have the slug.',
  },
  args: z.object({
    detail: z.enum(['summary', 'full']).default('summary'),
    limit: z.number().int().positive().max(200).default(50),
    cursor: z.string().optional(),
  }),
  async handler(args, ctx) {
    const txDb = drizzle(ctx.tx);
    const rows = (await txDb
      .select({
        slug: projects.slug,
        name: projects.name,
        status: projects.status,
        updated_ts: projects.updatedTs,
      })
      .from(projects)
      .orderBy(desc(projects.updatedTs))
      .limit(args.limit));
    if (args.detail === 'summary') {
      return { data: rows.map((r) => ({ slug: r.slug, status: r.status })) };
    }
    return { data: rows };
  },
});
