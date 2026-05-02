"use strict";
/**
 * List pending_events in the workspace. Summary-only — pending_events
 * is a queue and concierge agents are observers, never consumers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'pending_events:read',
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary']).default('summary'),
        kind: zod_1.z.string().optional(),
        targetRole: zod_1.z.string().optional(),
        limit: zod_1.z.number().int().positive().max(200).default(50),
    }),
    async handler(args, ctx) {
        const rows = await ctx.tx `
      SELECT id, kind, target_role, due_at, created_at, consumed_at
        FROM harness_shared.pending_events
       WHERE (${args.kind ?? null}::text IS NULL OR kind = ${args.kind ?? null})
         AND (${args.targetRole ?? null}::text IS NULL OR target_role = ${args.targetRole ?? null})
       ORDER BY created_at DESC
       LIMIT ${args.limit}
    `;
        return {
            data: rows.map((r) => ({
                id: r.id,
                kind: r.kind,
                targetRole: r.target_role,
                dueAt: r.due_at,
                createdAt: r.created_at,
                consumed: r.consumed_at != null,
            })),
        };
    },
});
