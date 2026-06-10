/**
 * artifacts:append — append to a PG-canonical text artifact.
 *
 * Concatenates `suffix` to the existing `content`. If the row doesn't
 * exist yet, creates it with `suffix` as the initial content. Returns
 * the post-append byte length so callers can detect overflow without a
 * follow-up `load`.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/tooldef';
import { SLUG_RE, slugRequires } from './_slug-requires';

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
  args: z.object({
    slug: z.string().min(1).regex(SLUG_RE).optional(),
    rel_path: z.string().min(1),
    suffix: z.string().min(1),
  }),
  // Declarative preconditions (adopt-event-rules-engines requires:-half):
  // the former in-handler slug guards, lifted — see ./_slug-requires.
  requires: slugRequires('artifacts:append'),
  async handler(args, ctx) {
    // Present + SLUG_RE-valid by the preconditions above.
    const slug = (args.slug ?? ctx.harnessSlug)!;
    const key = normalizeRelPath(args.rel_path);
    const now = Date.now();
    // ctx.tx, NOT getOrgPg() — RLS-scoped write; workspace_id stamped from
    // the GUC for the policy's WITH CHECK (audit P-012, see save.ts).
    const rows = await ctx.tx<{ content: string }[]>`
      INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
      VALUES (${slug}, ${key}, ${args.suffix}, ${now},
              COALESCE(current_setting('app.workspace_id', true), ''))
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
