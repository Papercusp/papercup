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
const tooldef_1 = require("@papercusp/tooldef");
exports.default = (0, tooldef_1.defineTool)({
    name: 'audit:list',
    profile: 'engineer',
    capability: 'audit:read',
    guidance: {
        when: 'User asks "what happened recently?", "who did X?", or you need a forensic timeline of agent + user actions.',
        notWhen: 'For ACTIVE / in-flight work, use `harness:status` or `actions:recent`. Audit is a write-log, not a live view.',
    },
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        actor: zod_1.z.string().optional(),
        action: zod_1.z.string().optional(),
        sinceTs: zod_1.z.number().int().optional(),
        limit: zod_1.z.number().int().positive().max(500).default(100),
        // EI-61: consumed by the dispatch layer BEFORE the handler runs
        // (effectiveDispatchWorkspace, EI-30 — tx synthesis + ALS pin); the
        // handler itself ignores it. Declared here so the advertised
        // inputSchema (additionalProperties:false) lets unscoped superuser
        // clients discover + pass it instead of dying on workspace_required.
        workspace: zod_1.z
            .string()
            .optional()
            .describe('Per-call workspace scope for an UNSCOPED superuser session (workspaceId "*") — dispatches under this workspace. Ignored when the session is already workspace-scoped.'),
    }),
    // Output schema (token-efficient-tool-result-formats P-011): the default
    // `summary` shape is a flat array of scalar-only rows → unlocks CSV (the
    // densest format) and the MCP `outputSchema` advertisement. `detail: 'full'`
    // additionally returns a nested `details` per row; the serializer's runtime
    // flatness check downgrades those to TOON gracefully, so declaring the
    // summary shape is correct + lossless for both modes.
    result: zod_1.z.array(zod_1.z.object({
        id: zod_1.z.string(),
        ts: zod_1.z.number(),
        actor: zod_1.z.string(),
        action: zod_1.z.string(),
        subject: zod_1.z.string(),
    })),
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
