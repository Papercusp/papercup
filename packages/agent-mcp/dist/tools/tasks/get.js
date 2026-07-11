/**
 * Get a single task by (harnessSlug, id). Summary returns id+title+status;
 * full returns the row.
 *
 * Typed via `schemaOf(harness_features_consolidated).select`.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';
const features = generated.harnessFeaturesConsolidatedInHarnessShared;
const FeatureSelect = schemaOf(features).select;
export default defineTool({
    name: 'tasks:get',
    capability: 'tasks:read',
    guidance: {
        when: 'User names a specific task ("the auth task", "task ABC-123") and you need its full body.',
        notWhen: 'For a list of tasks, use `tasks:list` first. Don\'t call `tasks:get` speculatively across many ids — list returns enough for most "what\'s the gist" questions.',
        chaining: 'Follow `tasks:list` to find the id.',
    },
    args: z.object({
        harnessSlug: z.string().min(1),
        id: z.string().min(1),
        detail: z.enum(['summary', 'full']).default('summary'),
    }),
    async handler(args, ctx) {
        const txDb = drizzle(ctx.tx);
        const rows = (await txDb
            .select()
            .from(features)
            .where(and(eq(features.harnessSlug, args.harnessSlug), eq(features.featureId, args.id)))
            .limit(1));
        if (!rows.length) {
            return {
                data: null,
                degraded: true,
                degradedReasons: [`task ${args.harnessSlug}/${args.id} not found`],
            };
        }
        if (args.detail === 'summary') {
            const r = rows[0];
            return {
                data: { harnessSlug: r.harnessSlug, id: r.featureId, title: r.title, status: r.status },
            };
        }
        return { data: rows[0] };
    },
});
