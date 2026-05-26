/**
 * plans:start — mark a plan as started so the orchestrator picks its features.
 *
 * Per plans-central-harness-ux-2026-05-26 Phase 1 P-002.
 *
 * Upserts a row in harness_shared.harness_plan_status with status='started'.
 * If the plan was previously paused or done it is re-activated.
 * Starting an already-started plan is a no-op (idempotent).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withWorkspace } from '@restart/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { resolveCtxHarnessSlug } from './_ctx-opts';

const SU_ROLES = [
  'scoper',
  'architect',
  'worker',
  'validator',
  'reviewer',
  'debugger',
  'operator',
  'documenter',
  'curator',
] as const;

const argsSchema = z.object({
  slug: z.string().min(1).describe('Plan slug to start (filename without .md).'),
});

export default defineTool({
  name: 'plans:start',
  description:
    "Mark a plan as started so the orchestrator will pick features promoted from it. Starting an already-started plan is a no-op. Use plans:pause to suspend work without losing started state.",
  guidance: {
    when: "User clicks 'Start Plan' in the harness UI, or an agent is asked to begin work on a specific plan.",
    notWhen:
      'The plan is already started. Use plans:pause to suspend, plans:set-run-status for run lifecycle.',
    chaining: 'plans:list to find the slug, then plans:start { slug }.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  roles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const harnessSlug = resolveCtxHarnessSlug(ctx) ?? 'papercup';
    const now = new Date();

    const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
      return tx<{ status: string; updated_at: Date }[]>`
        INSERT INTO harness_shared.harness_plan_status
          (workspace_id, harness_slug, plan_slug, status, started_at, updated_at)
        VALUES
          (${DEFAULT_WORKSPACE_ID}, ${harnessSlug}, ${args.slug}, 'started', ${now}, ${now})
        ON CONFLICT (workspace_id, harness_slug, plan_slug)
        DO UPDATE SET
          status     = 'started',
          updated_at = ${now}
        RETURNING status, updated_at
      `;
    });

    const row = rows[0];
    ctxAny.metadata?.({ slug: args.slug, harnessSlug, status: row?.status });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            slug: args.slug,
            harnessSlug,
            status: 'started',
            updatedAt: row?.updated_at,
          }),
        },
      ],
    };
  },
});
