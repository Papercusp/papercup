"use strict";
/**
 * features:get — fetch one OR many features by (harness slug, feature id).
 *
 * Returns the full row from `harness_shared.harness_features_consolidated`.
 * For agent use when prompt-injected feature history was capped or when
 * inspecting a non-current feature (cross-feature exploration).
 *
 * Typed via `schemaOf(harness_features_consolidated).select`.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the feature key is the COMPOUND
 * `(slug, feature_id)`. Pass a single `{ slug, feature_id }` for n=1, or
 * `items:[{ slug, feature_id }]` for many → { ok, results:[{ ok, slug,
 * feature_id, feature? | error }], counts }. Each result self-describes its
 * (slug, feature_id), so a not-found / invalid-slug item never poisons the rest
 * and the agent correlates by key (not array position).
 */
Object.defineProperty(exports, "__esModule", { value: true });
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel: the barrel re-exports through index.ts, an ESM circular-init that
// leaves runBulk/bulkContent undefined at runtime, AND the package-subpath
// self-reference fails the production build's `node` moduleResolution. The
// relative leaf resolves under both and dodges the cycle.
const _bulk_1 = require("../../_bulk");
const features = db_org_1.generated.harnessFeaturesConsolidatedInHarnessShared;
const FeatureSelect = (0, db_org_1.schemaOf)(features).select;
const SLUG_RE = /^[a-z0-9._-]+$/i;
const FeatureKey = zod_1.z.object({
    slug: zod_1.z.string().min(1),
    feature_id: zod_1.z.string().min(1),
});
exports.default = (0, tooldef_1.defineTool)({
    name: 'features:get',
    profile: 'engineer',
    capability: 'features:read',
    description: 'Fetch one OR many features by (harness slug, feature id) in ONE call — pass `{ slug, feature_id }` for one or `items:[{ slug, feature_id }]` for several. Returns { ok, results:[{ ok, slug, feature_id, feature? | error }], counts } — correlate each result by its (slug, feature_id), not by position; a missing / invalid-slug item comes back as that item\'s { ok:false } without failing the rest.',
    guidance: {
        when: 'User names a specific feature ("the auth one", "F-AUTH-001") and you need its body / acceptance criteria. Pass every (slug, feature_id) you need at once via `items`.',
        notWhen: 'For a list of features in a harness, use `harness:list_features`. For changes over time, use `features:history`.',
        chaining: 'Follow `harness:list_features` or `features:search` to find the id. Bulk: single { slug, feature_id } | items[] → { ok, results, counts }; correlate by (slug, feature_id) not position; one failure never fails the rest.',
    },
    args: zod_1.z
        .object({
        slug: zod_1.z.string().min(1).optional().describe('a single feature\'s harness slug (n=1 shorthand, paired with feature_id)'),
        feature_id: zod_1.z.string().min(1).optional().describe('a single feature id (n=1 shorthand, paired with slug)'),
        items: zod_1.z.array(FeatureKey).min(1).max(100).optional().describe('feature keys to fetch (1–100), each { slug, feature_id }'),
    })
        .refine((a) => Boolean(a.items?.length) || (Boolean(a.slug) && Boolean(a.feature_id)), {
        message: 'pass `{ slug, feature_id }` (one) or `items:[{ slug, feature_id }]` (many)',
    }),
    async handler(args, ctx) {
        const keys = args.items?.length
            ? args.items
            : [{ slug: args.slug, feature_id: args.feature_id }];
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const env = await (0, _bulk_1.runBulk)(keys, async ({ slug, feature_id }) => {
            if (!SLUG_RE.test(slug)) {
                return { ok: false, slug, feature_id, error: `invalid slug ${JSON.stringify(slug)}` };
            }
            const rows = (await txDb
                .select()
                .from(features)
                .where((0, drizzle_orm_1.and)((0, drizzle_orm_1.eq)(features.harnessSlug, slug), (0, drizzle_orm_1.eq)(features.featureId, feature_id)))
                .limit(1));
            if (!rows.length) {
                return { ok: false, slug, feature_id, error: `feature ${feature_id} not found in harness ${slug}` };
            }
            return { ok: true, slug, feature_id, feature: rows[0] };
        }, { keyOf: ({ slug, feature_id }) => ({ slug, feature_id }) });
        return (0, _bulk_1.bulkContent)(env);
    },
});
