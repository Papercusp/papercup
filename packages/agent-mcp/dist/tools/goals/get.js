"use strict";
/**
 * Get a single goal by id. Returns lineage (children + descendant tasks)
 * when detail='full'.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'goals:read',
    args: zod_1.z.object({
        id: zod_1.z.string().min(1),
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
    }),
    async handler(args, ctx) {
        const rows = await ctx.tx `
      SELECT * FROM harness_shared.goals WHERE id = ${args.id} LIMIT 1
    `;
        if (!rows.length) {
            return { data: null, degraded: true, degradedReasons: [`goal ${args.id} not found`] };
        }
        const goal = rows[0];
        if (args.detail === 'summary') {
            return { data: { id: goal.id, title: goal.title } };
        }
        const children = await ctx.tx `
      SELECT id, title FROM harness_shared.goals WHERE parent_id = ${args.id}
    `;
        return { data: { ...goal, children } };
    },
});
