"use strict";
/**
 * Federated search across workspace state.
 *
 * v1: Postgres LIKE-based search across text columns. Phase E upgrades
 * to FTS via tsvector indexes. jsonb columns (audit details) are
 * excluded in v1; deferred to v1.5 with generated text columns.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const define_tool_1 = require("../../define-tool");
const KINDS = ['tasks', 'goals', 'projects', 'audit', 'messages'];
exports.default = (0, define_tool_1.defineTool)({
    capability: 'search:read',
    args: zod_1.z.object({
        query: zod_1.z.string().min(1),
        kinds: zod_1.z.array(zod_1.z.enum(KINDS)).optional(),
        limit: zod_1.z.number().int().positive().max(100).default(25),
    }),
    async handler(args, ctx) {
        const wantKind = (k) => !args.kinds || args.kinds.includes(k);
        const q = `%${args.query}%`;
        const hits = [];
        if (wantKind('tasks')) {
            const rows = await ctx.tx `
        SELECT harness_slug, feature_id, title, summary
          FROM harness_shared.harness_features_consolidated
         WHERE title ILIKE ${q} OR summary ILIKE ${q}
         LIMIT ${args.limit}
      `;
            for (const r of rows) {
                hits.push({
                    kind: 'tasks',
                    id: `${r.harness_slug}/${r.feature_id}`,
                    snippet: r.title || r.summary?.slice(0, 100) || '',
                    score: 1,
                });
            }
        }
        if (wantKind('goals')) {
            const rows = await ctx.tx `
        SELECT id, title, body FROM harness_shared.goals
         WHERE title ILIKE ${q} OR body ILIKE ${q}
         LIMIT ${args.limit}
      `;
            for (const r of rows)
                hits.push({ kind: 'goals', id: r.id, snippet: r.title, score: 1 });
        }
        if (wantKind('projects')) {
            const rows = await ctx.tx `
        SELECT id, slug, name FROM harness_shared.projects
         WHERE name ILIKE ${q} OR slug ILIKE ${q}
         LIMIT ${args.limit}
      `;
            for (const r of rows)
                hits.push({ kind: 'projects', id: r.slug ?? r.id, snippet: r.name, score: 1 });
        }
        if (wantKind('audit')) {
            const rows = await ctx.tx `
        SELECT id, subject, action FROM harness_shared.audit_log
         WHERE subject ILIKE ${q} OR action ILIKE ${q}
         LIMIT ${args.limit}
      `;
            for (const r of rows)
                hits.push({ kind: 'audit', id: r.id, snippet: `${r.action}: ${r.subject}`, score: 0.5 });
        }
        return {
            data: hits.slice(0, args.limit),
        };
    },
});
