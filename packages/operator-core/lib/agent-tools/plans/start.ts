/**
 * plans:start — mark a plan as started so the orchestrator picks its features.
 *
 * Per plans-central-harness-ux-2026-05-26 Phase 1 P-002.
 *
 * Sets op_status='started' on the plan's harness_shared.harness_plans row
 * (operational columns folded in from the retired harness_plan_status table —
 * plans-pg-canonical-migration-2026-06-03).
 * If the plan was previously paused or done it is re-activated.
 * Starting an already-started plan is a no-op (idempotent).
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { resolveCtxHarnessSlug, ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { flipPlanFrontmatterStatus } from './set-plan-status';
import { readPlanBySlug } from './source';
import { isTerminalPlanStatus } from './plan-start-state';

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
  harness: harnessArg,
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
  agentRoles: [...SU_ROLES, 'bee'],
  modality: ['text'],
  args: argsSchema,
  async handler(args, ctx) {
    const ctxAny = ctx as { metadata?: (d: Record<string, unknown>) => void };
    const sctx = harnessScopedCtx(args.harness, ctx);
    const harnessSlug = resolveCtxHarnessSlug(sctx) ?? 'papercup';
    const now = new Date().toISOString();

    // Cross-store invariant: refuse to start a plan that is already terminal
    // (shipped/superseded). Starting it would create the exact started+terminal
    // state the rest of this system works to make impossible. The lifecycle
    // status lives in git-canonical frontmatter, so we read it here rather than
    // rely on a (nonexistent) PG column. Legacy/missing frontmatter → draft →
    // not terminal → start proceeds.
    const read = await readPlanBySlug(args.slug, await ctxToPlanSourceOpts(sctx));
    const lifecycle = read?.parsed.frontmatter.status ?? null;
    if (isTerminalPlanStatus(lifecycle)) {
      ctxAny.metadata?.({ slug: args.slug, harnessSlug, refused: 'plan_terminal', status: lifecycle });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              slug: args.slug,
              harnessSlug,
              error: 'plan_terminal',
              status: lifecycle,
              message: `Plan is ${lifecycle}; reopen it (set status back to ready/draft) before starting.`,
            }),
          },
        ],
        isError: true,
      };
    }

    // op_status lives on the plan's own harness_plans row (folded from the
    // retired harness_plan_status table). Preserve the first-ever start time via
    // COALESCE so re-starting a paused/done plan keeps its original op_started_at.
    const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
      return tx<{ op_status: string; op_updated_at: string }[]>`
        UPDATE harness_shared.harness_plans
           SET op_status     = 'started',
               op_started_at = COALESCE(op_started_at, ${now}),
               op_updated_at = ${now}
         WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
           AND harness_slug = ${harnessSlug}
           AND plan_slug    = ${args.slug}
        RETURNING op_status, op_updated_at
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

    ctxAny.metadata?.({ slug: args.slug, harnessSlug, status: row?.op_status, autoApproved });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            slug: args.slug,
            harnessSlug,
            status: 'started',
            updatedAt: row?.op_updated_at,
            autoApproved,
          }),
        },
      ],
    };
  },
});
