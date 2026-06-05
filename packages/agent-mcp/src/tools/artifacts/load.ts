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

import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { defineTool } from '@papercusp/tooldef';

const SLUG_RE = /^[a-z0-9._-]+$/i;
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
] as const;

function normalizeRelPath(rel: string): string {
  return rel.replace(/^\.papercusp\//, '');
}

export default defineTool({
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
  args: z.object({
    slug: z.string().min(1).regex(SLUG_RE).optional(),
    rel_path: z.string().min(1),
  }),
  async handler(args, ctx) {
    const slug = args.slug ?? ctx.harnessSlug;
    if (!slug) {
      throw new Error('artifacts:load — `slug` required (no harnessSlug in spawn context)');
    }
    if (!SLUG_RE.test(slug)) {
      throw new Error(`artifacts:load — invalid slug ${JSON.stringify(slug)}`);
    }
    const key = normalizeRelPath(args.rel_path);
    const { sql } = getOrgPg();
    const rows = await sql<{ content: string; updated_at: string }[]>`
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
