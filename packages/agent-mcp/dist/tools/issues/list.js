"use strict";
/**
 * List issues across the workspace. Issues are validator-filed
 * complaints against tasks (per spec §state). Summary returns id +
 * task_id + filed_by; full returns the body.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'issues:read',
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        taskId: zod_1.z.string().optional(),
        limit: zod_1.z.number().int().positive().max(200).default(50),
    }),
    async handler(args, ctx) {
        // Issues live in per-harness schemas (harness_<slug>.issues). v1
        // returns an empty list with degraded:true and a hint pointing the
        // caller at per-harness reads. Full implementation requires a
        // consolidated mirror table or a UNION view; deferred to Phase E.
        return {
            data: [],
            degraded: true,
            degradedReasons: [
                'issues:list reads per-harness; v1 has no cross-harness consolidation. ' +
                    'Use harness:status which surfaces recent issues per harness.',
            ],
        };
    },
});
