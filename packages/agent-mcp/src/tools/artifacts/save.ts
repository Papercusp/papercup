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
import { defineTool } from '@papercusp/tooldef';
import { SLUG_RE, slugRequires } from './_slug-requires';
// NB: 'tester' is not an AGENT_ROLES member and never was — the phantom
// entry gated nothing (audit P-047).
const WRITE_ROLES = [
  'scoper',
  'architect',
  'worker',
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
    scoper: { perRun: 50 },
    operator: { perRun: 200 },
  },
  args: z.object({
    slug: z.string().min(1).regex(SLUG_RE).optional(),
    rel_path: z.string().min(1),
    content: z.string(),
  }),
  // Declarative preconditions (adopt-event-rules-engines requires:-half):
  // the former in-handler slug guards, lifted — see ./_slug-requires.
  requires: slugRequires('artifacts:save'),
  async handler(args, ctx) {
    // Present + SLUG_RE-valid by the preconditions above.
    const slug = (args.slug ?? ctx.harnessSlug)!;
    const key = normalizeRelPath(args.rel_path);
    const now = Date.now();
    // ctx.tx, NOT getOrgPg() (audit P-012): the host picks the handle —
    // workspace-scoped (harness_app + app.workspace_id GUC, RLS-enforced)
    // for normal dispatch, admin only for superuser/cross-workspace
    // dispatch. The admin handle here bypassed harness_text_artifacts'
    // workspace-isolation policy. workspace_id is stamped from the GUC so
    // the policy's WITH CHECK holds; under the admin handle the GUC is
    // unset → legacy ''.
    await ctx.tx`
      INSERT INTO harness_shared.harness_text_artifacts (harness_slug, rel_path, content, updated_at, workspace_id)
      VALUES (${slug}, ${key}, ${args.content}, ${now},
              COALESCE(current_setting('app.workspace_id', true), ''))
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
