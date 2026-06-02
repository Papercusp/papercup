"use strict";
/**
 * Get a single feature by (harness slug, feature id).
 *
 * Returns the full row from `harness_shared.harness_features_consolidated`.
 * For agent use when prompt-injected feature history was capped or when
 * inspecting a non-current feature (cross-feature exploration).
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
const SLUG_RE = /^[a-z0-9._-]+$/i;
exports.default = (0, tooldef_1.defineTool)({
    name: 'features:get',
    profile: 'engineer',
    capability: 'features:read',
    guidance: {
        when: 'User names a specific feature ("the auth one", "F-AUTH-001") and you need its body / acceptance criteria.',
        notWhen: 'For a list of features in a harness, use `harness:list_features`. For changes over time, use `features:history`.',
        chaining: 'Follow `harness:list_features` or `features:search` to find the id.',
    },
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
        feature_id: zod_1.z.string().min(1),
    }),
    async handler(args, ctx) {
        if (!SLUG_RE.test(args.slug)) {
            return { data: null, degraded: true, degradedReasons: [`invalid slug ${JSON.stringify(args.slug)}`] };
        }
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const rows = (await txDb
            .select()
            .from(features)
            .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(features.harnessSlug, args.slug), (0, drizzle_orm_1.eq)(features.featureId, args.feature_id)))
            .limit(1));
        if (!rows.length) {
            return {
                data: null,
                degraded: true,
                degradedReasons: [`feature ${args.feature_id} not found in harness ${args.slug}`],
            };
        }
        return { data: rows[0] };
    },
});
