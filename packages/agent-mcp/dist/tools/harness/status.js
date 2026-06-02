"use strict";
/**
 * Get the live status of a harness — current iteration phase, recent
 * activity, in-flight work. Useful for "what is harness X doing right now?"
 *
 * Typed via `schemaOf(projects).select` and `schemaOf(audit_log).select`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const postgres_js_1 = require("drizzle-orm/postgres-js");
const drizzle_orm_1 = require("drizzle-orm");
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const projects = db_org_1.generated.projectsInHarnessShared;
const audit = db_org_1.generated.auditLogInHarnessShared;
const ProjectSelect = (0, db_org_1.schemaOf)(projects).select;
const AuditSelect = (0, db_org_1.schemaOf)(audit).select;
exports.default = (0, tooldef_1.defineTool)({
    name: 'harness:status',
    profile: 'engineer',
    capability: 'harness:read',
    guidance: {
        when: 'User asks "what is harness X doing right now?", "is sheets active?", or you need recent-activity counts + phase.',
        notWhen: 'For "what\'s WRONG with X", use `issues:list` (problems-side view). For static facts about the harness, use `harness:get`.',
    },
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1),
    }),
    async handler(args, ctx) {
        const txDb = (0, postgres_js_1.drizzle)(ctx.tx);
        const projectRows = (await txDb
            .select({
            slug: projects.slug,
            status: projects.status,
            updated_ts: projects.updatedTs,
            spent_cents: projects.spentCents,
            budget_cents: projects.budgetCents,
        })
            .from(projects)
            .where((0, drizzle_orm_1.eq)(projects.slug, args.slug))
            .limit(1));
        if (!projectRows.length) {
            return {
                data: null,
                degraded: true,
                degradedReasons: [`harness ${args.slug} not found`],
            };
        }
        const recentActivity = (await txDb
            .select({ ts: audit.ts, action: audit.action, actor: audit.actor, subject: audit.subject })
            .from(audit)
            .where((0, drizzle_orm_1.eq)(audit.subject, args.slug))
            .orderBy((0, drizzle_orm_1.desc)(audit.ts))
            .limit(10));
        return {
            data: {
                ...projectRows[0],
                recentActivity,
            },
        };
    },
});
