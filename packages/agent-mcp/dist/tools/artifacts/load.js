"use strict";
/**
 * artifacts:load — read a PG-canonical text artifact for a harness.
 *
 * Same store as `apps/operator/lib/text-artifacts.ts` (Migration 035):
 * `harness_shared.harness_text_artifacts`, keyed (harness_slug, rel_path).
 * Used for memory/*.md, supervisor-notes.md, issues.md, and other free-
 * form per-harness text. Role-gated; agents may read across harnesses
 * by passing an explicit `slug`.
 *
 * The `rel_path` may be passed with or without a leading `.papercusp/`;
 * it's normalised to the bare relative-to-harness-dir form for lookup.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const _slug_requires_1 = require("./_slug-requires");
const ALL_ROLES = [
    'scoper',
    'architect',
    'worker',
    'validator',
    'tester',
    'reviewer',
    'debugger',
    'operator',
    'documenter',
    'curator',
];
function normalizeRelPath(rel) {
    return rel.replace(/^\.papercusp\//, '');
}
exports.default = (0, tooldef_1.defineTool)({
    name: 'artifacts:load',
    description: 'Read a PG-canonical text artifact (harness_text_artifacts) by (harness_slug, rel_path).',
    capability: 'artifacts:read',
    guidance: {
        when: 'You need to read a file the harness wrote earlier (notes, intermediate outputs, plans) by its harness_slug + rel_path.',
        notWhen: 'For SOURCE CODE in the user\'s repo, use the filesystem tools / gitnexus. Artifacts are harness-scoped PG-canonical text only.',
        chaining: 'Pair with `artifacts:save` to round-trip, `artifacts:append` to add to an existing one.',
    },
    requirePrincipal: false,
    agentRoles: [...ALL_ROLES],
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1).regex(_slug_requires_1.SLUG_RE).optional(),
        rel_path: zod_1.z.string().min(1),
    }),
    // Declarative preconditions (adopt-event-rules-engines requires:-half):
    // the former in-handler slug guards, lifted — see ./_slug-requires.
    requires: (0, _slug_requires_1.slugRequires)('artifacts:load'),
    async handler(args, ctx) {
        // Present + SLUG_RE-valid by the preconditions above.
        const slug = (args.slug ?? ctx.harnessSlug);
        const key = normalizeRelPath(args.rel_path);
        const { sql } = (0, db_org_1.getOrgPg)();
        const rows = await sql `
      SELECT content, updated_at
        FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = ${slug} AND rel_path = ${key}
       LIMIT 1
    `;
        const found = rows.length > 0;
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        slug,
                        rel_path: key,
                        found,
                        content: found ? rows[0].content : null,
                        updated_at: found ? Number(rows[0].updated_at) : null,
                    }),
                },
            ],
        };
    },
});
