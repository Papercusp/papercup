/**
 * artifacts:delete — remove a PG-canonical text artifact.
 *
 * Restricted to non-worker roles to keep workers from accidentally
 * dropping a sibling worker's notes mid-chunk. The legacy disk-mirror
 * lib intentionally does NOT unlink the on-disk file when the row is
 * deleted; this tool just drops the PG row. Anything still relying on
 * a stale on-disk copy will be addressed when the orchestrator's
 * prompt assembly is migrated to PG-direct reads.
 */

import { z } from 'zod';
import { getOrgPg } from '@restart/db-org';
import { defineTool } from '../../define-tool';

const SLUG_RE = /^[a-z0-9._-]+$/i;

function normalizeRelPath(rel: string): string {
  return rel.replace(/^\.harness\//, '');
}

export default defineTool({
  name: 'artifacts:delete',
  description: 'Delete a PG-canonical text artifact row by (harness_slug, rel_path). Restricted to architect/operator/curator roles.',
  capability: 'artifacts:write',
  requirePrincipal: false,
  roles: ['architect', 'operator', 'curator'],
  rolesQuota: {
    architect: { perRun: 20 },
    operator: { perRun: 100 },
    curator: { perRun: 50 },
  },
  args: z.object({
    slug: z.string().min(1).regex(SLUG_RE).optional(),
    rel_path: z.string().min(1),
  }),
  async handler(args, ctx) {
    const slug = args.slug ?? ctx.harnessSlug;
    if (!slug) {
      throw new Error('artifacts:delete — `slug` required (no harnessSlug in spawn context)');
    }
    if (!SLUG_RE.test(slug)) {
      throw new Error(`artifacts:delete — invalid slug ${JSON.stringify(slug)}`);
    }
    const key = normalizeRelPath(args.rel_path);
    const { sql } = getOrgPg();
    const result = await sql`
      DELETE FROM harness_shared.harness_text_artifacts
       WHERE harness_slug = ${slug} AND rel_path = ${key}
    `;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            slug,
            rel_path: key,
            deleted: result.count > 0,
          }),
        },
      ],
    };
  },
});
