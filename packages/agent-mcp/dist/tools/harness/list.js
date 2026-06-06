"use strict";
/**
 * List harnesses registered in the current workspace.
 *
 * Reads the **harness registry** (`harness_shared.harness_registry` — the
 * runtime store-of-record `harness:create` / the desktop "add project" route
 * write) merged with the org-level `harness_shared.projects` rows (status /
 * budget metadata, when a matching row exists). Before
 * autoloop-pot-operator-rebuild-2026-06-05 P-004 this tool read ONLY the
 * projects table, so registry harnesses — including every harness the Pot
 * creates via `harness:create` — were invisible to the operator's own
 * world-model. Registry entries report `source:'registry'`; org-project rows
 * with no registry entry are kept as `source:'project'` so the org view
 * doesn't disappear.
 *
 * Returns slug, status, and source for each. Use to answer "what harnesses
 * do I have?" or to find a slug before calling harness:get / harness:status.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const tooldef_1 = require("@papercusp/tooldef");
const registry_read_1 = require("./registry-read");
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
        workspace: zod_1.z
            .string()
            .min(1)
            .optional()
            .describe('Per-call workspace scope (superuser only). An unscoped superuser session (workspaceId "*") MUST pass this — the dispatch layer opens the workspace tx from it (EI-30). Scoped sessions ignore it (power-user callers have it clamped to their token workspace).'),
    }),
    async handler(args, ctx) {
        const tx = ctx.tx;
        const ws = ctx.principal?.workspaceId ?? '';
        const registry = await (0, registry_read_1.readRegistryProjects)(tx, ws);
        const projectRows = (await tx `
      SELECT slug, name, status, updated_ts
        FROM harness_shared.projects
       ORDER BY updated_ts DESC
       LIMIT 200
    `);
        const projBySlug = new Map(projectRows.map((r) => [r.slug, r]));
        const limit = args.limit ?? 50;
        const rows = [
            // The registry is the authoritative harness set; org-project rows enrich.
            ...registry.map((r) => {
                const p = projBySlug.get(r.slug);
                return {
                    slug: r.slug,
                    name: p?.name ?? r.slug,
                    status: p?.status ?? 'registered',
                    updated_ts: p?.updated_ts ?? null,
                    path: r.path ?? null,
                    source: 'registry',
                };
            }),
            // Org projects with no registry entry stay visible (the org/Pot view).
            ...projectRows
                .filter((p) => !registry.some((r) => r.slug === p.slug))
                .map((p) => ({
                slug: p.slug,
                name: p.name,
                status: p.status,
                updated_ts: p.updated_ts,
                path: null,
                source: 'project',
            })),
        ].slice(0, limit);
        if ((args.detail ?? 'summary') === 'summary') {
            return { data: rows.map((r) => ({ slug: r.slug, status: r.status, source: r.source })) };
        }
        return { data: rows };
    },
});
