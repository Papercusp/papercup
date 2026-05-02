"use strict";
/**
 * Close a task — sets status to 'done' or 'cancelled'.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'tasks:write',
    args: zod_1.z.object({
        harnessSlug: zod_1.z.string().min(1),
        id: zod_1.z.string().min(1),
        outcome: zod_1.z.enum(['done', 'cancelled']),
        reason: zod_1.z.string().min(10),
    }),
    async handler(args, ctx) {
        const bearer = process.env.AGENT_MCP_BEARER ?? '';
        const base = process.env.OPERATOR_BASE_URL ?? 'http://localhost:3055';
        const r = await fetch(`${base}/api/admin/execute-action`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
            body: JSON.stringify({
                op: 'update_feature',
                harness_slug: args.harnessSlug,
                feature_id: args.id,
                status: args.outcome,
                reason: args.reason,
            }),
        });
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            return { data: null, degraded: true, degradedReasons: [`executeAction ${r.status}: ${text}`] };
        }
        return { data: await r.json().catch(() => ({})) };
    },
});
