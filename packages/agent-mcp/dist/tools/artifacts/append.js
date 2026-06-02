"use strict";
/**
 * artifacts:append — append to a PG-canonical text artifact.
 *
 * Concatenates `suffix` to the existing `content`. If the row doesn't
 * exist yet, creates it with `suffix` as the initial content. Returns
 * the post-append byte length so callers can detect overflow without a
 * follow-up `load`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const SLUG_RE = /^[a-z0-9._-]+$/i;
const WRITE_ROLES = [
    'scoper',
    'architect',
    'worker',
    'tester',
    'debugger',
    'operator',
    'documenter',
    'curator',
];
function normalizeRelPath(rel) {
    return rel.replace(/^\.harness\//, '');
}
exports.default = (0, tooldef_1.defineTool)({
    name: 'artifacts:append',
    description: 'Append to a PG-canonical text artifact (harness_text_artifacts). Creates the row if absent.',
    capability: 'artifacts:write',
    guidance: {
        when: 'Add to an existing artifact without losing prior content — running notes, ongoing log, accumulating findings.',
        notWhen: 'For replacing the whole file, use `artifacts:save`. For ephemeral within-turn notes, just hold them in your reply.',
    },
    requirePrincipal: false,
    agentRoles: [...WRITE_ROLES],
    rolesQuota: {
        worker: { perChunk: 50 },
        architect: { perRun: 200 },
        tester: { perRun: 200 },
        scoper: { perRun: 200 },
        operator: { perRun: 500 },
    },
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1).regex(SLUG_RE).optional(),
        rel_path: zod_1.z.string().min(1),
        suffix: zod_1.z.string().min(1),
    }),
    async handler(args, ctx) {
        const slug = args.slug ?? ctx.harnessSlug;
        if (!slug) {
            throw new Error('artifacts:append — `slug` required (no harnessSlug in spawn context)');
        }
        if (!SLUG_RE.test(slug)) {
            throw new Error(`artifacts:append — invalid slug ${JSON.stringify(slug)}`);
        }
        const key = normalizeRelPath(args.rel_path);
        const { sql } = (0, db_org_1.getOrgPg)();
        const now = Date.now();
        const rows = await sql `
      INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at)
      VALUES (${slug}, ${key}, ${args.suffix}, ${now})
      ON CONFLICT (harness_slug, rel_path) DO UPDATE SET
        content    = harness_text_artifacts.content || EXCLUDED.content,
        updated_at = EXCLUDED.updated_at
      RETURNING content
    `;
        const merged = rows[0]?.content ?? args.suffix;
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        slug,
                        rel_path: key,
                        appended_bytes: args.suffix.length,
                        total_bytes: merged.length,
                        updated_at: now,
                    }),
                },
            ],
        };
    },
});
