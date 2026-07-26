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
import { defineTool, AGENT_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { ctxToPlanSourceOpts } from './_ctx-opts';
import { resolvePlanWriteScope } from './_write-scope';
import { harnessArg, harnessScopedCtx } from '../_harness-scope';
import { withPlanLock, bumpUpdatedDate } from './with-plan-lock';
import { flipPlanFrontmatterStatus } from './set-plan-status';
import { readPlanBySlug } from './source';
import { isTerminalPlanStatus } from './plan-start-state';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

const argsSchema = z.object({
  slug: z.string().min(1).optional().describe('Plan slug to start (filename without .md).'),
  slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to start in one call.'),
  harness: harnessArg,
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
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
    seeAlso: [
      'plans:launch (have an agent autonomously advance the started plan)',
      'plans:set-status (manually move items along once started)',
      'plans:pause (suspend a started plan)',
    ],
  },
  capability: 'plans:write',
  requirePrincipal: false,
  agentRoles: [...AGENT_ROLES],
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
    // ⚠ WI-5125 / EI-16183 / WI-5825 class — resolved ONCE for the whole call
    // (the harness is a single arg) from the SAME authority the readers use.
    // This handler reads the plan via readPlanBySlug(ctxToPlanSourceOpts(sctx))
    // and then writes its harness_plans row, so deriving the write key on a
    // second path is precisely how the two come to disagree. See
    // resolvePlanWriteScope's doc comment for the three generations of this bug.
    // Never activeWorkspaceId(), never a DEFAULT_WORKSPACE_ID literal, never the
    // un-collapsed ctx slug.
    const { workspaceId: startWorkspaceId, harnessSlug } = await resolvePlanWriteScope(sctx);
    const slugs = mergeIds(args.slug, args.slugs);
    const env = await runBulk(
      slugs,
      async (slug) => {
        const now = new Date().toISOString();

        const read = await readPlanBySlug(slug, await ctxToPlanSourceOpts(sctx));
        const lifecycle = read?.parsed.frontmatter.status ?? null;
        if (isTerminalPlanStatus(lifecycle)) {
          ctxAny.metadata?.({ slug, harnessSlug, refused: 'plan_terminal', status: lifecycle });
          return {
            ok: false as const,
            slug,
            harnessSlug,
            error: 'plan_terminal',
            status: lifecycle,
            message: `Plan is ${lifecycle}; reopen it (set status back to ready/draft) before starting.`,
          };
        }

        const rows = await withWorkspace(startWorkspaceId, async (tx) => {
          return tx<{ op_status: string; op_updated_at: string; prev_op_status: string | null }[]>`
            UPDATE harness_shared.harness_plans AS p
               SET op_status     = 'started',
                   op_started_at = COALESCE(p.op_started_at, ${now}),
                   op_updated_at = ${now}
              FROM (
                SELECT plan_slug, op_status AS prev_op_status
                  FROM harness_shared.harness_plans
                 WHERE workspace_id = ${startWorkspaceId}
                   AND harness_slug = ${harnessSlug}
                   AND plan_slug    = ${slug}
                   FOR UPDATE
              ) prev
             WHERE p.workspace_id = ${startWorkspaceId}
               AND p.harness_slug = ${harnessSlug}
               AND p.plan_slug    = prev.plan_slug
            RETURNING p.op_status, p.op_updated_at, prev.prev_op_status
          `;
        });

        const row = rows[0];
        // WI-5825: 0 rows means no such plan in this (workspace, harness) —
        // report it. This handler used to return ok:true / status:'started'
        // regardless of rows affected, so a mis-scoped UPDATE announced a start
        // that never happened (and then emitted the `plan started` demand event
        // on it). A write that matched nothing is a failure, not a start.
        if (!row) {
          ctxAny.metadata?.({ slug, harnessSlug, refused: 'plan_not_found' });
          return {
            ok: false as const,
            slug,
            harnessSlug,
            error: 'plan_not_found',
            message: `no plan '${slug}' in ${startWorkspaceId}/${harnessSlug}`,
          };
        }
        const transitioned = row.prev_op_status !== 'started';

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
                subjectId: slug,
                claim: `plan ${slug} reaches status shipped within the horizon of its start`,
                harnessSlug: harnessSlug ?? null,
              }),
            )
            .catch(() => {});
        }

        let autoApproved = false;
        try {
          const flipResult = await withPlanLock<boolean>(
            ctx as never,
            {
              slug,
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

        ctxAny.metadata?.({ slug, harnessSlug, status: row?.op_status, autoApproved, transitioned });

        const promoWorkspaceId = startWorkspaceId;
        void import('../../plan-workitem-promotion-run')
          .then(async (m) => {
            const { resolveAgentIdentity } = await import('../coordination/identity');
            await m.promotePlanItems({
              workspaceId: promoWorkspaceId,
              harnessSlug,
              planSlug: slug,
              createdBy: resolveAgentIdentity(ctx).ownerId,
            });
          })
          .catch(() => {});

        return {
          ok: true as const,
          slug,
          harnessSlug,
          status: 'started',
          updatedAt: row?.op_updated_at,
          autoApproved,
          transitioned,
          previousOpStatus: row?.prev_op_status ?? null,
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    return bulkContent(env);
  },
});
