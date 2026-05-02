"use strict";
/**
 * Get the live status of a harness — current iteration phase, recent
 * activity, in-flight work. Useful for "what is harness X doing right now?"
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'harness:read',
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
    }),
    async handler(args, ctx) {
        // Minimal v1: return project row + most recent audit_log entries
        // tagged with this harness as subject. Phase D may extend this with
        // live orchestrator state.
        const project = await ctx.tx `
      SELECT slug, status, updated_ts, spent_cents, budget_cents
        FROM harness_shared.projects
       WHERE slug = ${args.slug}
       LIMIT 1
    `;
        if (!project.length) {
            return {
                data: null,
                degraded: true,
                degradedReasons: [`harness ${args.slug} not found`],
            };
        }
        const recentActivity = await ctx.tx `
      SELECT ts, action, actor, subject
        FROM harness_shared.audit_log
       WHERE subject = ${args.slug}
       ORDER BY ts DESC
       LIMIT 10
    `;
        return {
            data: {
                ...project[0],
                recentActivity,
            },
        };
    },
});
