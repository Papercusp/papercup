"use strict";
/**
 * List goals in the current workspace.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'goals:read',
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        limit: zod_1.z.number().int().positive().max(200).default(50),
    }),
    async handler(args, ctx) {
        const rows = await ctx.tx `
      SELECT id, title, body, parent_id, budget_cents, created_at
        FROM harness_shared.goals
       ORDER BY created_at DESC
       LIMIT ${args.limit}
    `;
        if (args.detail === 'summary') {
            return { data: rows.map((r) => ({ id: r.id, title: r.title })) };
        }
        return { data: rows };
    },
});
