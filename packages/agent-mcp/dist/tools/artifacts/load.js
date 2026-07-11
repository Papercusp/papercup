/**
 * artifacts:load — read one OR many PG-canonical text artifacts for a harness.
 *
 * Same store as `apps/operator/lib/text-artifacts.ts` (Migration 035):
 * `harness_shared.harness_text_artifacts`, keyed (harness_slug, rel_path).
 * Used for memory/*.md, supervisor-notes.md, issues.md, and other free-
 * form per-harness text. Role-gated; agents may read across harnesses
 * by passing an explicit `slug`.
 *
 * The `rel_path` may be passed with or without a leading `.papercusp/`;
 * it's normalised to the bare relative-to-harness-dir form for lookup.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21): the artifact key is the COMPOUND
 * `(slug, rel_path)` (slug defaults to the spawn ctx's harness). Pass a single
 * `{ slug?, rel_path }` for n=1, or `items:[{ slug?, rel_path }]` for many →
 * { ok, results:[{ ok, slug, rel_path, found, content, updated_at | error }],
 * counts }. Each result self-describes its (slug, rel_path); a missing-slug /
 * invalid-slug item fails only itself.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { SLUG_RE, slugRequires, resolveSlug } from './_slug-requires';
import { SU_ROLES } from '../../role-config';
// The bulk helpers' LEAF module — relative, NOT the '@papercusp/agent-mcp'
// barrel: the barrel re-exports through index.ts, an ESM circular-init that
// leaves runBulk/bulkContent undefined at runtime, AND the package-subpath
// self-reference fails the production build's `node` moduleResolution. The
// relative leaf resolves under both and dodges the cycle.
import { runBulk, bulkContent } from '../../_bulk';
// NB: 'tester' is not an AGENT_ROLES member and never was — the phantom
// entry gated nothing (audit P-047).
function normalizeRelPath(rel) {
    return rel.replace(/^\.papercusp\//, '');
}
const LoadItem = z.object({
    slug: z.string().min(1).regex(SLUG_RE).optional(),
    rel_path: z.string().min(1),
});
export default defineTool({
    name: 'artifacts:load',
    description: 'Read one OR many PG-canonical text artifacts (harness_text_artifacts) by (harness_slug, rel_path). Pass a single `{ slug?, rel_path }` or `items:[{ slug?, rel_path }]` for several. Returns { ok, results:[{ ok, slug, rel_path, found, content, updated_at | error }], counts } — correlate by (slug, rel_path), not by position; a missing / invalid-slug item fails only itself.',
    capability: 'artifacts:read',
    guidance: {
        when: 'You need to read a file the harness wrote earlier (notes, intermediate outputs, plans) by its harness_slug + rel_path. Pass every (slug, rel_path) at once via `items`.',
        notWhen: 'For SOURCE CODE in the user\'s repo, use the filesystem tools / gitnexus. Artifacts are harness-scoped PG-canonical text only.',
        chaining: 'Pair with `artifacts:save` to round-trip, `artifacts:append` to add to an existing one. Bulk: single { slug?, rel_path } | items[] → { ok, results, counts }; correlate by (slug, rel_path) not position; one failure never fails the rest.',
    },
    requirePrincipal: false,
    agentRoles: [...SU_ROLES],
    args: z
        .object({
        slug: z.string().min(1).regex(SLUG_RE).optional(),
        rel_path: z.string().min(1).optional(),
        items: z.array(LoadItem).min(1).max(100).optional().describe('artifact keys to read (1–100), each { slug?, rel_path }'),
    })
        .refine((a) => Boolean(a.items?.length) || Boolean(a.rel_path), {
        message: 'pass `rel_path` (one) or `items:[{ rel_path }]` (many)',
    }),
    // Declarative preconditions (adopt-event-rules-engines requires:-half):
    // the former in-handler slug guards, lifted — see ./_slug-requires. The bulk
    // (`items`) path re-asserts per-item slug presence/validity in the handler.
    requires: slugRequires('artifacts:load'),
    async handler(args, ctx) {
        const items = args.items?.length ? args.items : [{ slug: args.slug, rel_path: args.rel_path }];
        const env = await runBulk(items, async (item) => {
            const r = resolveSlug('artifacts:load', item.slug, ctx.harnessSlug);
            const key = normalizeRelPath(item.rel_path);
            if ('error' in r) {
                return { ok: false, slug: item.slug ?? null, rel_path: key, error: r.error };
            }
            const { slug } = r;
            // ctx.tx, NOT getOrgPg() — the workspace-scoped handle keeps reads
            // inside the caller's workspace via RLS (audit P-012, see save.ts).
            const rows = await ctx.tx `
          SELECT content, updated_at
            FROM harness_shared.harness_text_artifacts
           WHERE harness_slug = ${slug} AND rel_path = ${key}
           LIMIT 1
        `;
            const found = rows.length > 0;
            return {
                ok: true,
                slug,
                rel_path: key,
                found,
                content: found ? rows[0].content : null,
                updated_at: found ? Number(rows[0].updated_at) : null,
            };
        }, { keyOf: (item) => ({ slug: item.slug ?? null, rel_path: normalizeRelPath(item.rel_path) }) });
        return bulkContent(env);
    },
});
