/**
 * plans:set-archived — archive (or restore) a plan
 * (owner-plans-single-pane-2026-07-17 P-008 follow-up, EI-15304).
 *
 * Writes `harness_shared.harness_plans.archived` (BOOLEAN NOT NULL DEFAULT
 * false) — the PG-canonical archive flag every plan read already honors
 * (`plans:list` / the plan-source readers filter `archived = false` unless
 * `includeArchived`). Archiving is therefore a FLAG FLIP, not a file move: the
 * `docs/plans/**` markdown is a projection, PG is the source of truth
 * (storage-policy: Postgres by default).
 *
 * The Plans face's stale-plan sweep calls this so an owner can clear sprawl in
 * one click; an archived plan drops out of every default list but stays fully
 * readable via `includeArchived`, so this is reversible (pass archived:false).
 *
 * ⚠ Deliberately does NOT touch `updated_at`. That column is "last REAL
 * activity on the plan" — the plan list renders it as recency and the Plans
 * face's stale detector (no activity ≥14d) keys on it. Bumping it here would
 * make every archived-then-restored plan look freshly worked. We bump the
 * operational `op_updated_at` instead, exactly as plans:set-priority does.
 */

import { z } from 'zod';
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { resolveEffectiveHarnessSlug } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { bulkContent, runBulk } from '../_bulk';

const setArchivedItemSchema = z.object({
  slug: z.string().min(1).describe('Plan slug to archive or restore.'),
  archived: z
    .boolean()
    .describe('true = archive (drops out of default plan lists); false = restore it to the live set.'),
});

const argsSchema = setArchivedItemSchema.extend({
  harness: harnessArg,
  items: z
    .array(setArchivedItemSchema)
    .min(1)
    .max(200)
    .optional()
    .describe('archive/restore many plans in one call'),
});

export default defineTool({
  name: 'plans:set-archived',
  description:
    'Archive a plan (or restore it). Archived plans drop out of every default plan list but stay readable via includeArchived, so this is reversible. Flips the PG-canonical harness_plans.archived flag — it does NOT move the plan file.',
  guidance: {
    when: 'Clearing plan sprawl — a finished or abandoned plan should stop showing in the plan lists. The Plans face\'s stale-plan sweep calls this.',
    notWhen:
      'To mark a plan SHIPPED/rejected use plans:set-plan-status (lifecycle, still listed). To stop a running plan use plans:pause. Do not archive a plan just because it is blocked.',
    chaining: 'plans:list { includeArchived: true } to see or find archived plans and restore one.',
    seeAlso: [
      'plans:set-plan-status (lifecycle flip — shipped/superseded, stays listed)',
      'plans:pause (stop an operationally-started plan)',
      'plans:list (includeArchived to see what is archived)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveEffectiveHarnessSlug(sctx);
    const items = args.items ?? [{ slug: args.slug, archived: args.archived }];
    const env = await runBulk(
      items,
      async (item) => {
        const now = new Date().toISOString();
        const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
          return tx<{ plan_slug: string }[]>`
            UPDATE harness_shared.harness_plans
               SET archived      = ${item.archived},
                   op_updated_at = ${now}
             WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
               AND harness_slug = ${harnessSlug}
               AND plan_slug    = ${item.slug}
            RETURNING plan_slug
          `;
        });
        // A slug that matches nothing is a caller error worth surfacing per-item
        // (runBulk keeps the rest of the batch going) rather than a silent no-op.
        if (!rows || rows.length === 0) {
          return {
            ok: false as const,
            slug: item.slug,
            harnessSlug,
            error: 'plan_not_found',
          };
        }
        return { ok: true as const, slug: item.slug, harnessSlug, archived: item.archived };
      },
      { keyOf: (item) => ({ slug: item.slug }) },
    );
    return bulkContent(env);
  },
});
