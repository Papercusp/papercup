"use strict";
/**
 * artifacts:save — upsert a PG-canonical text artifact.
 *
 * Replaces the entire `content` for (harness_slug, rel_path). PG is
 * canonical (per the "PG-canonical, no FS mirrors" project rule); no
 * disk write happens here. If a consumer needs the content on disk
 * (orchestrator prompt assembly, harness-CLI), it should read from PG
 * via `artifacts:load` rather than tail a file.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zod_1 = require("zod");
const db_org_1 = require("@papercusp/db-org");
const tooldef_1 = require("@papercusp/tooldef");
const _slug_requires_1 = require("./_slug-requires");
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
    return rel.replace(/^\.papercusp\//, '');
}
exports.default = (0, tooldef_1.defineTool)({
    name: 'artifacts:save',
    description: 'Upsert a PG-canonical text artifact (harness_text_artifacts) by (harness_slug, rel_path). Replaces existing content.',
    capability: 'artifacts:write',
    guidance: {
        when: 'Persist a generated text artifact for later reads by other agents or future turns. Replaces existing content at the same (harness_slug, rel_path).',
        notWhen: 'For appending to an existing file, use `artifacts:append` — save fully replaces. For source code, write to the repo via filesystem tools, not artifacts.',
    },
    requirePrincipal: false,
    agentRoles: [...WRITE_ROLES],
    rolesQuota: {
        worker: { perChunk: 20 },
        architect: { perRun: 50 },
        tester: { perRun: 50 },
        scoper: { perRun: 50 },
        operator: { perRun: 200 },
    },
    args: zod_1.z.object({
        slug: zod_1.z.string().min(1).regex(_slug_requires_1.SLUG_RE).optional(),
        rel_path: zod_1.z.string().min(1),
        content: zod_1.z.string(),
    }),
    // Declarative preconditions (adopt-event-rules-engines requires:-half):
    // the former in-handler slug guards, lifted — see ./_slug-requires.
    requires: (0, _slug_requires_1.slugRequires)('artifacts:save'),
    async handler(args, ctx) {
        // Present + SLUG_RE-valid by the preconditions above.
        const slug = (args.slug ?? ctx.harnessSlug);
        const key = normalizeRelPath(args.rel_path);
        const { sql } = (0, db_org_1.getOrgPg)();
        const now = Date.now();
        await sql `
      INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at)
      VALUES (${slug}, ${key}, ${args.content}, ${now})
      ON CONFLICT (harness_slug, rel_path) DO UPDATE SET
        content    = EXCLUDED.content,
        updated_at = EXCLUDED.updated_at
    `;
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        slug,
                        rel_path: key,
                        bytes: args.content.length,
                        updated_at: now,
                    }),
                },
            ],
        };
    },
});
