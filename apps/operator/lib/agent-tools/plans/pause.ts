/**
 * plans:pause — suspend orchestrator feature-picking for a plan without losing started state.
 *
 * Per plans-central-harness-ux-2026-05-26 Phase 1 P-002.
 *
 * Sets status='paused' in harness_shared.harness_plan_status.
 * The plan's in-flight features are NOT cancelled — any running worker
 * turn finishes, but no new features are picked until the plan is
 * re-started via plans:start.
 *
 * Pausing a plan that was never started returns { notStarted: true }.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
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
  slug: z.string().min(1).describe('Plan slug to pause.'),
});

export default defineTool({
  name: 'plans:pause',
  description:
    "Suspend orchestrator feature-picking for a plan. In-flight worker turns finish; no new features are picked until plans:start is called again. Returns { notStarted: true } if the plan has no row in harness_plan_status.",
  guidance: {
    when: "User pauses work on a plan from the UI, or an agent needs to suspend a plan without marking it done.",
    notWhen:
      'The plan is done — use plans:set-run-status for run lifecycle. To mark the whole plan complete, update the frontmatter status to shipped.',
    chaining: 'plans:list to find the slug, then plans:pause { slug }. Resume with plans:start.',
  },
  capability: 'plans:write',
  requirePrincipal: false,
  roles: [...SU_ROLES],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const harnessSlug = resolveCtxHarnessSlug(ctx) ?? 'papercup';
    const now = new Date().toISOString();

    const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
      return tx<{ status: string; updated_at: string }[]>`
        UPDATE harness_shared.harness_plan_status
           SET status = 'paused', updated_at = ${now}
         WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
           AND harness_slug  = ${harnessSlug}
           AND plan_slug     = ${args.slug}
        RETURNING status, updated_at
      `;
    });

    ctxAny.metadata?.({ slug: args.slug, harnessSlug });

    if (rows.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              slug: args.slug,
              harnessSlug,
              notStarted: true,
              message: 'plan has no started/paused row — call plans:start first',
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            slug: args.slug,
            harnessSlug,
            status: 'paused',
            updatedAt: rows[0].updated_at,
          }),
        },
      ],
    };
  },
});
