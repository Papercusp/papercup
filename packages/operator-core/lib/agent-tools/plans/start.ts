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
 *
 * Emits (start-hive-wake-orchestration-2026-06-09 P-001 / D-001): on a REAL
 * op_status transition (`transitioned: true` — not the idempotent re-start) a
 * `coord:emit` lifecycle notification fires to the plan's watchers. The Queen's
 * default wake subscription rides the same tool event (lib/hive/wake-defaults).
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { DEFAULT_WORKSPACE_ID } from '../../workspace-registry';
import { resolveCtxHarnessSlug, ctxToPlanSourceOpts } from './_ctx-opts';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { flipPlanFrontmatterStatus } from './set-plan-status';
import { readPlanBySlug } from './source';
import { isTerminalPlanStatus } from './plan-start-state';

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
  // Demand surfaces as an EVENT (start-hive-wake P-001 / D-001): a real
  // started-transition notifies the plan's watchers. The idempotent re-start
  // (`transitioned: false`) stays silent — no watcher value, no Queen demand.
  emits: [
    {
      fire: 'coord:emit',
      when: (e) => Boolean((e.result?.data as { transitioned?: boolean } | undefined)?.transitioned),
      render: (e) => {
        const data = e.result.data as {
          slug: string;
          harnessSlug?: string;
          previousOpStatus?: string | null;
          autoApproved?: boolean;
        };
        return {
          category: 'demand',
          summary: `plan started: ${data.slug}${data.previousOpStatus ? ` (was ${data.previousOpStatus})` : ''}`,
          ...(data.autoApproved ? { body: 'draft auto-approved → ready by the start' } : {}),
          plan_slug: data.slug,
          to: [`@plan:${data.slug}`],
        };
      },
    },
  ],
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
    // The locked self-join carries the PRIOR op_status out so the result can say
    // whether this start was a real transition (the emits/wake gate) or the
    // idempotent no-op re-start.
    const rows = await withWorkspace(DEFAULT_WORKSPACE_ID, async (tx) => {
      return tx<{ op_status: string; op_updated_at: string; prev_op_status: string | null }[]>`
        UPDATE harness_shared.harness_plans AS p
           SET op_status     = 'started',
               op_started_at = COALESCE(p.op_started_at, ${now}),
               op_updated_at = ${now}
          FROM (
            SELECT plan_slug, op_status AS prev_op_status
              FROM harness_shared.harness_plans
             WHERE workspace_id = ${DEFAULT_WORKSPACE_ID}
               AND harness_slug = ${harnessSlug}
               AND plan_slug    = ${args.slug}
               FOR UPDATE
          ) prev
         WHERE p.workspace_id = ${DEFAULT_WORKSPACE_ID}
           AND p.harness_slug = ${harnessSlug}
           AND p.plan_slug    = prev.plan_slug
        RETURNING p.op_status, p.op_updated_at, prev.prev_op_status
      `;
    });

    const row = rows[0];
    const transitioned = row ? row.prev_op_status !== 'started' : false;

    // Calibration bet at the natural moment (frontier P-041 / FB-13): a REAL
    // start is the starter's implicit claim the plan ships within the horizon.
    // Fire-and-forget; the seam is flag-gated + never-throw, so the start
    // path is unaffected. Idempotent re-starts (transitioned:false) stay silent.
    if (transitioned) {
      void Promise.all([
        import('../../calibration/capture'),
        import('../coordination/identity'),
      ])
        .then(([cal, ident]) =>
          cal.recordPrediction({
            predictor: ident.resolveAgentIdentity(ctx).ownerId,
            domain: 'plan-ship',
            subjectKind: 'plan',
            subjectId: args.slug,
            claim: `plan ${args.slug} reaches status shipped within the horizon of its start`,
          }),
        )
        .catch(() => {});
    }

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

    ctxAny.metadata?.({ slug: args.slug, harnessSlug, status: row?.op_status, autoApproved, transitioned });
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
            // True only when this call ACTUALLY flipped op_status to 'started'
            // (false on the idempotent re-start / missing row) — the gate the
            // emits rule + the Queen's wake subscription match on (P-001).
            transitioned,
            previousOpStatus: row?.prev_op_status ?? null,
          }),
        },
      ],
    };
  },
});
