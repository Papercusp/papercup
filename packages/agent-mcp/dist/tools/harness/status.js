"use strict";
/**
 * Get the live status of a harness — current iteration phase, recent
 * activity, in-flight work. Useful for "what is harness X doing right now?"
 *
 * Resolves the slug against the **harness registry** first (the runtime
 * store-of-record `harness:create` writes), falling back to the org-level
 * `harness_shared.projects` row for status/budget when one exists. Before
 * autoloop-pot-operator-rebuild-2026-06-05 P-004 this tool read ONLY the
 * projects table, so a freshly-created harness's own read-back returned
 * "not found" — the Pot could create a harness it then couldn't see.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const tooldef_1 = require("@papercusp/tooldef");
const registry_read_1 = require("./registry-read");
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
        const tx = ctx.tx;
        const ws = ctx.principal?.workspaceId ?? '';
        const registry = await (0, registry_read_1.readRegistryProjects)(tx, ws);
        const regEntry = registry.find((r) => r.slug === args.slug) ?? null;
        const projectRows = (await tx `
      SELECT slug, status, updated_ts, spent_cents, budget_cents
        FROM harness_shared.projects
       WHERE slug = ${args.slug}
       LIMIT 1
    `);
        const proj = projectRows[0] ?? null;
        if (!regEntry && !proj) {
            return {
                data: null,
                degraded: true,
                degradedReasons: [`harness ${args.slug} not found`],
            };
        }
        const recentActivity = (await tx `
      SELECT ts, action, actor, subject
        FROM harness_shared.audit_log
       WHERE subject = ${args.slug}
       ORDER BY ts DESC
       LIMIT 10
    `);
        return {
            data: {
                slug: args.slug,
                status: proj?.status ?? 'registered',
                updated_ts: proj?.updated_ts ?? null,
                spent_cents: proj?.spent_cents ?? null,
                budget_cents: proj?.budget_cents ?? null,
                path: regEntry?.path ?? null,
                source: regEntry ? 'registry' : 'project',
                recentActivity,
            },
        };
    },
});
