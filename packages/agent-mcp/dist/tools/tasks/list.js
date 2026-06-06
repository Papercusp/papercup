"use strict";
/**
 * List tasks across the workspace, optionally filtered by status, goal,
 * or harness. Summary returns id + title + status; full returns the row.
 *
 * Typed via `schemaOf(harness_features_consolidated).select` — response
 * row shape matches the column definition; no hand-typed Record.
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
    name: 'tasks:list',
    capability: 'tasks:read',
    guidance: {
        when: 'User asks "what tasks do I have?", "what\'s on my plate", or you need a task id before calling `tasks:get`/`tasks:update`/`tasks:close`.',
        notWhen: 'For ONE task by id, use `tasks:get`. For creating a task, use `tasks:create`. For PROJECTS / FEATURES (work the harness is doing), use `harness:*` — tasks are separate from harness features.',
        chaining: 'Pair with `tasks:get` for detail on a specific row.',
    },
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        status: zod_1.z.string().optional(),
        goalId: zod_1.z.string().optional(),
        harnessSlug: zod_1.z.string().optional(),
        limit: zod_1.z.number().int().positive().max(200).default(50),
        cursor: zod_1.z.string().optional(),
    }),
    // Output schema (token-efficient-tool-result-formats P-013) — flat scalar
    // array (default `summary` shape) → unlocks CSV + outputSchema advertisement.
    result: zod_1.z.array(zod_1.z.object({
        harnessSlug: zod_1.z.string().nullable(),
        id: zod_1.z.string(),
        title: zod_1.z.string(),
        status: zod_1.z.string().nullable(),
    })),
    async handler(args, ctx) {
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const preds = [
            args.harnessSlug ? (0, drizzle_orm_1.eq)(features.harnessSlug, args.harnessSlug) : undefined,
            args.status ? (0, drizzle_orm_1.eq)(features.status, args.status) : undefined,
            args.goalId ? (0, drizzle_orm_1.eq)(features.goalId, args.goalId) : undefined,
        ].filter((p) => p !== undefined);
        const rows = (await txDb
            .select({
            harness_slug: features.harnessSlug,
            feature_id: features.featureId,
            title: features.title,
            summary: features.summary,
            status: features.status,
            updated_ts: features.updatedTs,
            attempts: features.attempts,
            kind: features.kind,
            project_id: features.projectId,
            expected_cost_cents: features.expectedCostCents,
            goal_id: features.goalId,
        })
            .from(features)
            .where(preds.length ? (0, drizzle_orm_1.and)(...preds) : undefined)
            .orderBy((0, drizzle_orm_1.desc)(features.updatedTs))
            .limit(args.limit));
        if (args.detail === 'summary') {
            return {
                data: rows.map((r) => ({
                    harnessSlug: r.harness_slug,
                    id: r.feature_id,
                    title: r.title,
                    status: r.status,
                })),
            };
        }
        return { data: rows };
    },
});
