"use strict";
/**
 * List harnesses registered in the current workspace.
 *
 * Returns slug, status, and last-activity timestamp for each. Use to
 * answer "what harnesses do I have?" or to find a slug before calling
 * harness:get / harness:status.
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
const ProjectSelect = (0, db_org_1.schemaOf)(projects).select;
exports.default = (0, tooldef_1.defineTool)({
    name: 'harness:list',
    profile: 'engineer',
    capability: 'harness:read',
    guidance: {
        when: 'User asks "what harnesses do I have?", "show me my projects", or you need a slug to feed into harness:get / harness:status.',
        notWhen: 'For ONE specific harness, use `harness:get`. For a single harness\'s live health (active/done counts), use `harness:status`.',
        chaining: 'Pair with `harness:get` (detail) or `harness:status` (live counts) once you have the slug.',
    },
    args: zod_1.z.object({
        detail: zod_1.z.enum(['summary', 'full']).default('summary'),
        limit: zod_1.z.number().int().positive().max(200).default(50),
        cursor: zod_1.z.string().optional(),
    }),
    async handler(args, ctx) {
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const rows = (await txDb
            .select({
            slug: projects.slug,
            name: projects.name,
            status: projects.status,
            updated_ts: projects.updatedTs,
        })
            .from(projects)
            .orderBy((0, drizzle_orm_1.desc)(projects.updatedTs))
            .limit(args.limit));
        if (args.detail === 'summary') {
            return { data: rows.map((r) => ({ slug: r.slug, status: r.status })) };
        }
        return { data: rows };
    },
});
