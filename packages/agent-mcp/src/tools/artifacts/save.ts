/**
 * artifacts:save — upsert a PG-canonical text artifact.
 *
 * Replaces the entire `content` for (harness_slug, rel_path). PG is
 * canonical (per the "PG-canonical, no FS mirrors" project rule); no
 * disk write happens here. If a consumer needs the content on disk
 * (orchestrator prompt assembly, harness-CLI), it should read from PG
 * via `artifacts:load` rather than tail a file.
 */

import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';

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
] as const;

function normalizeRelPath(rel: string): string {
  return rel.replace(/^\.papercusp\//, '');
}

export default defineTool({
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
  args: z.object({
    slug: z.string().min(1).regex(SLUG_RE).optional(),
    rel_path: z.string().min(1),
    content: z.string(),
  }),
  async handler(args, ctx) {
    const slug = args.slug ?? ctx.harnessSlug;
    if (!slug) {
      throw new Error('artifacts:save — `slug` required (no harnessSlug in spawn context)');
    }
    if (!SLUG_RE.test(slug)) {
      throw new Error(`artifacts:save — invalid slug ${JSON.stringify(slug)}`);
    }
    const key = normalizeRelPath(args.rel_path);
    const { sql } = getOrgPg();
    const now = Date.now();
    await sql`
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
