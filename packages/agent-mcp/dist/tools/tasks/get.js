"use strict";
/**
 * Get a single task by (harnessSlug, id). Summary returns id+title+status;
 * full returns the row.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'tasks:read',
    args: zod_1.z.object({
        harnessSlug: zod_1.z.string().min(1),
        id: zod_1.z.string().min(1),
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
    }),
    async handler(args, ctx) {
        const rows = await ctx.tx `
      SELECT *
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${args.harnessSlug} AND feature_id = ${args.id}
       LIMIT 1
    `;
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
                data: { harnessSlug: r.harness_slug, id: r.feature_id, title: r.title, status: r.status },
            };
        }
        return { data: rows[0] };
    },
});
