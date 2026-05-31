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
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { resolveCtxHarnessSlug } from './_ctx-opts';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { flipPlanFrontmatterStatus } from './set-plan-status';

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
    "Mark a plan as started so the orchestrator will pick features promoted from it. Starting is itself the approval signal — a still-draft plan is auto-advanced to 'ready'. Starting an already-started plan is a no-op. Use plans:pause to suspend work without losing started state.",
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
    const now = new Date().toISOString();

    const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
      return tx<{ status: string; updated_at: string }[]>`
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

    // Starting a plan IS the approval signal — if it's still a draft,
    // auto-advance the frontmatter to 'ready' so the lifecycle reflects
    // that work has been sanctioned. expectedCurrent='draft' makes this a
    // no-op for plans that are already approved (or legacy/no-frontmatter).
    let autoApproved = false;
    try {
      const flipResult = await withPlanLock<boolean>(
        ctx as never,
        {
          slug: args.slug,
          intent: 'plans:start → auto-approve draft',
          ...(harnessSlug ? { harnessSlug } : {}),
        },
        async (current) => {
          if (current === null) return { newBody: null, value: false };
          const flip = flipPlanFrontmatterStatus(current, 'ready', 'draft');
          if (flip.newBody === null) return { newBody: null, value: false };
          return { newBody: bumpUpdatedDate(flip.newBody), value: true };
        },
      );
      autoApproved = flipResult.kind === 'applied' && flipResult.value === true;
    } catch {
      /* best effort — the plan is started regardless of the status flip */
    }

    ctxAny.metadata?.({ slug: args.slug, harnessSlug, status: row?.status, autoApproved });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            slug: args.slug,
            harnessSlug,
            status: 'started',
            updatedAt: row?.updated_at,
            autoApproved,
          }),
        },
      ],
    };
  },
});
