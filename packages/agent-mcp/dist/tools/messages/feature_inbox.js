"use strict";
/**
 * Read messages addressed to a specific feature within a harness.
 *
 * Used by:
 *   - The orchestrator's `feature-history.ts` for prompt injection of
 *     pending feature-addressed messages.
 *   - Agents that want to inspect a non-current feature's inbox via
 *     explicit MCP call.
 *
 * Visibility rule: the caller can ask about any (slug, feature) pair
 * they have `messages:read` for; the tool does not enforce
 * "only-your-own-feature" because the harness-level capability
 * already gates which workspaces a principal can read.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const tooldef_1 = require("@papercusp/tooldef");
const SLUG_RE = /^[a-z0-9._-]+$/i;
const FEATURE_ID_RE = /^[A-Z][A-Z0-9-]+(-[A-Z0-9-]+)?$/;
exports.default = (0, tooldef_1.defineTool)({
    name: 'messages:feature_inbox',
    guidance: {
        when: 'You need messages scoped to a specific feature thread — incoming on that feature.',
        notWhen: 'For your general inbox, use `messages:inbox`. For ALL feature threads, fetch each feature\'s id and call this per feature.',
    },
    capability: 'messages:read',
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
        feature_id: zod_1.z.string().regex(FEATURE_ID_RE, 'feature_id must match F-XXX[-NNN]'),
        /** Filter by status. 'all' returns every message (incl. archived). Default 'pending'. */
        status: zod_1.z.enum(['pending', 'acknowledged', 'archived', 'all']).default('pending'),
        limit: zod_1.z.number().int().positive().max(200).default(50),
    }),
    async handler(args, ctx) {
        if (!SLUG_RE.test(args.slug)) {
            return { data: [], degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`] };
        }
        const schemaIdent = ctx.tx(`harness_${args.slug.replace(/-/g, '_')}`);
        const statusFilter = args.status === 'all' ? null : args.status;
        let rows = [];
        try {
            rows = await ctx.tx `
        SELECT id, created_at, from_slug, from_feature_id, to_role, kind,
               subject, body, status, parent_message_id
          FROM ${schemaIdent}.messages
         WHERE to_feature_id = ${args.feature_id}
           AND (${statusFilter}::text IS NULL OR status = ${statusFilter})
         ORDER BY created_at DESC
         LIMIT ${args.limit}
      `;
        }
        catch (err) {
            return {
                data: [],
                degraded: true,
                degradedReasons: [`messages:feature_inbox query failed: ${err.message.slice(0, 200)}`],
            };
        }
        return { data: rows };
    },
});
