/**
 * Get a single goal by id. Returns lineage (children + descendant tasks)
 * when detail='full'.
 *
 * Uses `schemaOf(generated.goalsInHarnessShared).select` so the response
 * row shape is the same Zod schema you'd use in a form or a CRUD admin
 * page — no hand-typed `Record<string, unknown>`.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { generated, schemaOf } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';
const goals = generated.goalsInHarnessShared;
const GoalSelect = schemaOf(goals).select;
export default defineTool({
    name: 'goals:get',
    capability: 'goals:read',
    guidance: {
        when: 'User names a specific goal and wants the rationale / acceptance criteria.',
        notWhen: 'For a list of goals, use `goals:list` first.',
        chaining: 'Follow `goals:list` to find the id.',
    },
    args: z.object({
        id: z.string().min(1),
        detail: z.enum(['summary', 'full']).default('summary'),
    }),
    async handler(args, ctx) {
        const txDb = drizzle(ctx.tx);
        const rows = (await txDb
            .select()
            .from(goals)
            .where(eq(goals.id, args.id))
            .limit(1));
        if (!rows.length) {
            return { data: null, degraded: true, degradedReasons: [`goal ${args.id} not found`] };
        }
        const goal = rows[0];
        if (args.detail === 'summary') {
            return { data: { id: goal.id, title: goal.title } };
        }
        const children = (await txDb
            .select({ id: goals.id, title: goals.title })
            .from(goals)
            .where(eq(goals.parentId, args.id)));
        return { data: { ...goal, children } };
    },
});
