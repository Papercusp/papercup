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
const registry_read_1 = require("./registry-read");
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
            // EI-1834: harness:get is a PROJECT lookup — a registered HIVE (or any non-project
            // harness_kind) has no projects row, so a bare "not found" is AMBIGUOUS: it conflates
            // "no such harness" with "exists, but not as a project". That ambiguity once misled a
            // live diagnosis (a correct papercup→papercusp migration root-cause was retracted
            // because the newly-merged hive read as "not found"). Check the harness REGISTRY (the
            // store-of-record for WHICH harnesses exist, hives included) and, when the slug is
            // there, report its kind — so the caller never reads "not found" as "doesn't exist".
            // Best-effort: a registry read failure falls back to the plain miss.
            const ws = ctx.principal?.workspaceId ?? '';
            const reg = (await (0, registry_read_1.readRegistryProjects)(ctx.tx, ws).catch(() => [])).find((p) => p.slug === args.slug);
            if (reg) {
                const kind = reg.harness_kind ?? 'unknown';
                const surface = kind === 'hive' ? 'hives' : 'non-project harness kinds';
                const inspect = kind === 'hive' ? 'harness:list or pot:get' : 'harness:list';
                return {
                    data: null,
                    degraded: true,
                    degradedReasons: [
                        `harness '${args.slug}' EXISTS in the registry as harness_kind='${kind}', but has no projects row — ` +
                            `harness:get is a PROJECT lookup and does not surface ${surface}. It is registered; inspect it via ${inspect}. ` +
                            `Do NOT read this as "no such harness".`,
                    ],
                };
            }
            return {
                data: null,
                degraded: true,
                degradedReasons: [
                    `harness '${args.slug}' not found (no projects row and no harness registry entry). ` +
                        `harness:get is a PROJECT lookup; if you expect a hive or other non-project harness, confirm with harness:list.`,
                ],
            };
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
