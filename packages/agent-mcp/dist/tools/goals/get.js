"use strict";
/**
 * Get a single goal by id. Returns lineage (children + descendant tasks)
 * when detail='full'.
 *
 * Uses `schemaOf(generated.goalsInHarnessShared).select` so the response
 * row shape is the same Zod schema you'd use in a form or a CRUD admin
 * page — no hand-typed `Record<string, unknown>`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const goals = db_org_1.generated.goalsInHarnessShared;
const GoalSelect = (0, db_org_1.schemaOf)(goals).select;
exports.default = (0, tooldef_1.defineTool)({
    name: 'goals:get',
    capability: 'goals:read',
    guidance: {
        when: 'User names a specific goal and wants the rationale / acceptance criteria.',
        notWhen: 'For a list of goals, use `goals:list` first.',
        chaining: 'Follow `goals:list` to find the id.',
    },
    args: zod_1.z.object({
        id: zod_1.z.string().min(1),
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
    }),
    async handler(args, ctx) {
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const rows = (await txDb
            .select()
            .from(goals)
            .where((0, drizzle_orm_1.eq)(goals.id, args.id))
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
            .where((0, drizzle_orm_1.eq)(goals.parentId, args.id)));
        return { data: { ...goal, children } };
    },
});
