"use strict";
/**
 * Get a single task by (harnessSlug, id). Summary returns id+title+status;
 * full returns the row.
 *
 * Typed via `schemaOf(harness_features_consolidated).select`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const features = db_org_1.generated.harnessFeaturesConsolidatedInHarnessShared;
const FeatureSelect = (0, db_org_1.schemaOf)(features).select;
exports.default = (0, tooldef_1.defineTool)({
    name: 'tasks:get',
    capability: 'tasks:read',
    guidance: {
        when: 'User names a specific task ("the auth task", "task ABC-123") and you need its full body.',
        notWhen: 'For a list of tasks, use `tasks:list` first. Don\'t call `tasks:get` speculatively across many ids — list returns enough for most "what\'s the gist" questions.',
        chaining: 'Follow `tasks:list` to find the id.',
    },
    args: zod_1.z.object({
        harnessSlug: zod_1.z.string().min(1),
        id: zod_1.z.string().min(1),
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
    }),
    async handler(args, ctx) {
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const rows = (await txDb
            .select()
            .from(features)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(features.harnessSlug, args.harnessSlug), (0, drizzle_orm_1.eq)(features.featureId, args.id)))
            .limit(1));
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
                data: { harnessSlug: r.harnessSlug, id: r.featureId, title: r.title, status: r.status },
            };
        }
        return { data: rows[0] };
    },
});
