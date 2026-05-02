"use strict";
/**
 * List harnesses registered in the current workspace.
 *
 * Returns slug, status, and last-activity timestamp for each. Use to
 * answer "what harnesses do I have?" or to find a slug before calling
 * harness:get / harness:status.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'harness:read',
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        limit: zod_1.z.number().int().positive().max(200).default(50),
        cursor: zod_1.z.string().optional(),
    }),
    async handler(args, ctx) {
        const rows = await ctx.tx `
      SELECT slug, name, status, updated_ts
        FROM harness_shared.projects
       ORDER BY updated_ts DESC
       LIMIT ${args.limit}
    `;
        if (args.detail === 'summary') {
            return {
                data: rows.map((r) => ({ slug: r.slug, status: r.status })),
            };
        }
        return { data: rows };
    },
});
