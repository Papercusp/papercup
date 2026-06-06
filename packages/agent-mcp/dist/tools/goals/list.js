"use strict";
/**
 * List goals in the current workspace.
 *
 * Demonstrates the drizzle-zod pattern for MCP tools: response rows are
 * typed via `schemaOf(table).select` so the data sent back to the agent
 * matches the column shape declared in the migration — no hand-typed
 * `Record<string, unknown>`.
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
    name: 'goals:list',
    capability: 'goals:read',
    guidance: {
        when: 'User asks "what are we trying to do?", "what are my goals?", or you need a goal id before calling `goals:get`.',
        notWhen: 'For TASKS (concrete TODOs), use `tasks:list`. Goals are the higher-level intent; tasks are how you get there.',
        chaining: 'Pair with `goals:get` for the full body.',
    },
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        limit: zod_1.z.number().int().positive().max(200).default(50),
    }),
    // Output schema (token-efficient-tool-result-formats P-013) — flat scalar
    // array (default `summary` shape) → unlocks CSV + outputSchema advertisement.
    result: zod_1.z.array(zod_1.z.object({ id: zod_1.z.string(), title: zod_1.z.string() })),
    async handler(args, ctx) {
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const rows = (await txDb
            .select({
            id: goals.id,
            title: goals.title,
            body: goals.body,
            parent_id: goals.parentId,
            budget_cents: goals.budgetCents,
            created_at: goals.createdAt,
        })
            .from(goals)
            .orderBy((0, drizzle_orm_1.desc)(goals.createdAt))
            .limit(args.limit));
        if (args.detail === 'summary') {
            return { data: rows.map((r) => ({ id: r.id, title: r.title })) };
        }
        return { data: rows };
    },
});
