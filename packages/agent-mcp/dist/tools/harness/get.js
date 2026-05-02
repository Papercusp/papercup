"use strict";
/**
 * Get a single harness by slug.
 *
 * Summary returns slug + status + name + last activity. Full returns
 * the entire `harness_shared.projects` row plus aggregate feature counts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'harness:read',
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
    }),
    async handler(args, ctx) {
        const rows = await ctx.tx `
      SELECT *
        FROM harness_shared.projects
       WHERE slug = ${args.slug}
       LIMIT 1
    `;
        if (!rows.length) {
            return { data: null, degraded: true, degradedReasons: [`harness ${args.slug} not found`] };
        }
        const row = rows[0];
        if (args.detail === 'summary') {
            return {
                data: {
                    slug: row.slug,
                    name: row.name,
                    status: row.status,
                    updated_ts: row.updated_ts,
                },
            };
        }
        // Full: include feature counts by status.
        const counts = await ctx.tx `
      SELECT status, COUNT(*)::bigint AS n
        FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${args.slug}
       GROUP BY status
    `;
        const featureCounts = {};
        for (const c of counts)
            featureCounts[c.status] = Number(c.n);
        return { data: { ...row, featureCounts } };
    },
});
