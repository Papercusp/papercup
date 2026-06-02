"use strict";
/**
 * Get a single harness by slug.
 *
 * Summary returns slug + status + name + last activity. Full returns
 * the entire `harness_shared.projects` row plus aggregate feature counts.
 *
 * Typed via `schemaOf(projects).select`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const projects = db_org_1.generated.projectsInHarnessShared;
const features = db_org_1.generated.harnessFeaturesConsolidatedInHarnessShared;
const ProjectSelect = (0, db_org_1.schemaOf)(projects).select;
exports.default = (0, tooldef_1.defineTool)({
    name: 'harness:get',
    profile: 'engineer',
    capability: 'harness:read',
    guidance: {
        when: 'User asks about a specific harness by name ("tell me about sheets", "what\'s the status of forms") and you need its row + feature counts.',
        notWhen: 'For a list of all harnesses, use `harness:list`. For LIVE health (escalated/blocked), prefer `harness:status` or `escalations:get` — `harness:get` is the static record.',
        chaining: 'Follow `harness:list` if you don\'t have the slug. Follow with `harness:status` if you also need live counts.',
    },
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
    }),
    async handler(args, ctx) {
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const rows = (await txDb
            .select()
            .from(projects)
            .where((0, drizzle_orm_1.eq)(projects.slug, args.slug))
            .limit(1));
        if (!rows.length) {
            return { data: null, degraded: true, degradedReasons: [`harness ${args.slug} not found`] };
        }
        const row = rows[0];
        if (args.detail === 'summary') {
            return {
                data: {
                    slug: row.slug,
                    name: row.name,
                    status: row.status,
                    updated_ts: row.updatedTs,
                },
            };
        }
        const counts = await txDb
            .select({ status: features.status, n: (0, drizzle_orm_1.count)() })
            .from(features)
            .where((0, drizzle_orm_1.eq)(features.harnessSlug, args.slug))
            .groupBy(features.status);
        const featureCounts = {};
        for (const c of counts) {
            if (c.status != null)
                featureCounts[c.status] = Number(c.n);
        }
        return { data: { ...row, featureCounts } };
    },
});
