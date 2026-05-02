"use strict";
/**
 * List audit log entries for the current workspace.
 *
 * v1 is COARSE high-tier: returns every audit row in the workspace.
 * Per-row capability filtering (where an agent sees only rows whose
 * underlying capability they hold) is deferred to v1.5; it requires a
 * `required_capability` column on every audit producer (substrate +
 * plugins), which is fan-out work. For v1, `audit:read` is gated as
 * high-tier in capability-tiers.ts, so the install-time consent prompt
 * surfaces this as substantial trust.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
exports.default = (0, define_tool_1.defineTool)({
    capability: 'audit:read',
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        actor: zod_1.z.string().optional(),
        action: zod_1.z.string().optional(),
        sinceTs: zod_1.z.number().int().optional(),
        limit: zod_1.z.number().int().positive().max(500).default(100),
    }),
    async handler(args, ctx) {
        const rows = await ctx.tx `
      SELECT id, ts, actor, action, subject, details
        FROM harness_shared.audit_log
       WHERE (${args.actor ?? null}::text IS NULL OR actor = ${args.actor ?? null})
         AND (${args.action ?? null}::text IS NULL OR action = ${args.action ?? null})
         AND (${args.sinceTs ?? null}::bigint IS NULL OR ts >= ${args.sinceTs ?? null})
       ORDER BY ts DESC
       LIMIT ${args.limit}
    `;
        if (args.detail === 'summary') {
            return {
                data: rows.map((r) => ({
                    id: r.id,
                    ts: r.ts,
                    actor: r.actor,
                    action: r.action,
                    subject: r.subject,
                })),
            };
        }
        return { data: rows };
    },
});
