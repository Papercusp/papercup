"use strict";
/**
 * harness:status — live status of one OR many harnesses (current iteration
 * phase, recent activity, in-flight work). "What is harness X doing right now?"
 *
 * Resolves each slug against the **harness registry** first (the runtime
 * store-of-record `harness:create` writes), falling back to the org-level
 * `harness_shared.projects` row for status/budget when one exists. Before
 * autoloop-pot-operator-rebuild-2026-06-05 P-004 this tool read ONLY the
 * projects table, so a freshly-created harness's own read-back returned
 * "not found" — the Pot could create a harness it then couldn't see.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `slug` for one or
 * `slugs` for several → { ok, results:[{ ok, slug, ...status | error }], counts }.
 * Each result self-describes its slug, so a not-found harness never poisons the
 * rest and the Queen/overwatch polling all members reads by slug (not array
 * position). The registry is read ONCE for the whole batch.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const tooldef_1 = require("@papercusp/tooldef");
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel (the barrel forms an ESM circular init leaving the symbols undefined,
// and the package-subpath self-ref fails the production `node` moduleResolution).
const _bulk_1 = require("../../_bulk");
const registry_read_1 = require("./registry-read");
exports.default = (0, tooldef_1.defineTool)({
    name: 'harness:status',
    profile: 'engineer',
    capability: 'harness:read',
    description: 'Read the live status of one OR many harnesses in ONE call — pass `slug` for one or `slugs` for several. Each result carries current phase, status, budget/spend, and recent-activity. Returns { ok, results:[{ ok, slug, status, recentActivity, ... | error }], counts } — correlate each result by its slug, not by position; a not-found harness comes back as that item\'s { ok:false } without failing the rest.',
    guidance: {
        when: 'User asks "what is harness X doing right now?", "is sheets active?", or you need recent-activity counts + phase. Polling all hive members? Pass every slug at once via `slugs` instead of calling per harness.',
        notWhen: 'For "what\'s WRONG with X", use `work_items:list` (problems-side view). For static facts about the harness, use `harness:get`. Bulk: single `slug` | `slugs[]` → { ok, results, counts }; correlate by slug not position; one not-found never fails the rest.',
    },
    args: zod_1.z
        .object({
        slug: zod_1.z.string().min(1).optional().describe('a single harness slug (n=1 shorthand for slugs:[slug])'),
        slugs: zod_1.z.array(zod_1.z.string().min(1)).min(1).max(100).optional().describe('harness slugs to read (1–100)'),
    })
        .refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
        message: 'pass `slug` (one) or `slugs` (many)',
    }),
    async handler(args, ctx) {
        const tx = ctx.tx;
        const ws = ctx.principal?.workspaceId ?? '';
        const slugs = (0, _bulk_1.mergeIds)(args.slug, args.slugs);
        // Read the registry ONCE for the whole batch (it returns the full project list).
        const registry = await (0, registry_read_1.readRegistryProjects)(tx, ws);
        const regBySlug = new Map(registry.map((r) => [r.slug, r]));
        const env = await (0, _bulk_1.runBulk)(slugs, async (slug) => {
            const regEntry = regBySlug.get(slug) ?? null;
            const projectRows = (await tx `
          SELECT slug, status, updated_ts, spent_cents, budget_cents
            FROM harness_shared.projects
           WHERE slug = ${slug}
           LIMIT 1
        `);
            const proj = projectRows[0] ?? null;
            if (!regEntry && !proj) {
                return { ok: false, slug, error: `harness ${slug} not found` };
            }
            const recentActivity = (await tx `
          SELECT ts, action, actor, subject
            FROM harness_shared.audit_log
           WHERE subject = ${slug}
           ORDER BY ts DESC
           LIMIT 10
        `);
            return {
                ok: true,
                slug,
                status: proj?.status ?? 'registered',
                updated_ts: proj?.updated_ts ?? null,
                spent_cents: proj?.spent_cents ?? null,
                budget_cents: proj?.budget_cents ?? null,
                path: regEntry?.path ?? null,
                source: regEntry ? 'registry' : 'project',
                recentActivity,
            };
        }, { keyOf: (slug) => ({ slug }) });
        return (0, _bulk_1.bulkContent)(env);
    },
});
