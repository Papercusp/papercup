/**
 * plans:start — approve a plan and promote its items into work_items.
 *
 * Per plans-central-harness-ux-2026-05-26 Phase 1 P-002.
 *
 * ⚠ THE op_status WRITE IS GATED (retire-mug-kettle-su-only-2026-08-09 P-047 /
 * D-010). op_status ('started' | 'paused') is the OPERATIONAL axis — the
 * "pickable by the orchestrator" bit — and it retires with the Mug/Kettle tier.
 * P-068 DELETED `FLAGS.MUG_KETTLE_SYSTEM`, so the retirement is PERMANENT — there
 * is no flag left to flip. This tool does everything it always did EXCEPT write op_status:
 * terminal check, start gate, draft→'ready' auto-approve, and `promotePlanItems`
 * all still run. The verb is NOT refused, deliberately — promotion is what fills
 * the su queue, and gating the mechanism instead of the writer is exactly why
 * P-044 was dropped ("the cut was backwards").
 *
 * WHY THE WRITE IS THE HARMFUL HALF: op_status does not ENABLE anything for su.
 * `reservedPlanLaneExclusionSql` (work-items.ts) RESERVES a started/paused plan's
 * items FROM scheduler self-selection, because a DISPATCHER is meant to hand them
 * out. Retire the dispatcher and leave the writer, and every newly-started plan
 * silently strands its own items — reserved for nobody, presenting as "the queue
 * is empty". The READER half (dropping the op_status leg for already-reserved
 * plans) is P-048, deliberately NOT done here: D-055 measured 34 items across 6
 * plans behind it and requires the DBOS frontier to be settled in the same change.
 *
 * Sets op_status='started' on the plan's harness_shared.harness_plans row
 * (operational columns folded in from the retired harness_plan_status table —
 * plans-pg-canonical-migration-2026-06-03) when the tier IS enabled.
 * If the plan was previously paused or done it is re-activated.
 * Starting an already-started plan is a no-op (idempotent).
 *
 * Emits (start-hive-wake-orchestration-2026-06-09 P-001 / D-001): on a REAL
 * op_status transition (`transitioned: true` — not the idempotent re-start) a
 * `coord:emit` lifecycle notification fires to the plan's watchers. The Queen's
 * default wake subscription rides the same tool event (lib/hive/wake-defaults).
 * With the tier retired nothing transitions, so the demand event stays silent —
 * correct, since its subscriber is the retired Queen.
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
import { checkPlanStartable } from './plan-start-gate';
import { mugKettleSystemEnabled } from '../../pot/started';
import { bulkContent, mergeIds, runBulk } from '../_bulk';

/** Boolean that also accepts the exact wire strings 'true'/'false' — same
 * EI-302 manifest-pinned-schema tolerance as plans:new's `force`. */
const stringTolerantBool = z.preprocess(
  (v) => (v === 'true' ? true : v === 'false' ? false : v),
  z.boolean(),
);

const argsSchema = z.object({
  slug: z.string().min(1).optional().describe('Plan slug to start (filename without .md).'),
  slugs: z.array(z.string().min(1)).min(1).max(200).optional().describe('Plan slugs to start in one call.'),
  consulted: stringTolerantBool
    .optional()
    .describe(
      'Answer to a `consult_available` refusal (P-010 checkpoint consult). Pass true after actually consulting a listed candidate (name the consult in consult_reason), or false + consult_reason to proceed WITHOUT consulting (the reason is recorded). Omit on a first call — the checkpoint routing runs then. Applies to every slug in a bulk call. Accepts the wire strings "true"/"false" too.',
    ),
  consult_reason: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe('Why you are overriding (consulted: false) or what the consult concluded (consulted: true). Recorded.'),
  harness: harnessArg,
}).refine((a) => Boolean(a.slug) || (a.slugs?.length ?? 0) > 0, {
  message: 'pass `slug` or `slugs`',
}).refine((a) => a.consulted !== false || Boolean(a.consult_reason), {
  message: 'consulted: false requires consult_reason — state why you are proceeding without consulting (it is recorded)',
});

export default defineTool({
  name: 'plans:start',
  description:
    "Approve a plan and start its item-promotion path. Starting IS the approval signal — a draft plan is auto-advanced to 'ready'. Re-starting is a no-op. The retired op_status axis is never written (P-068 deleted the flag). Runs the plan-start CHECKPOINT consult (min:1): the plan body is routed through the relevance router; any selectable live peer — floor-qualified or best-available below the floor — nudge-refuses once with `consult_available` + labeled candidates (override: consulted + consult_reason).",
  guidance: {
    when: 'An agent is asked to begin work on a specific plan — this starts its item-promotion path into work-items.',
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
        // WI-7259 (sibling of WI-7246): a scheduled-run snapshot copies its
        // parent plan's body verbatim, frontmatter included — reading
        // frontmatter here would gate on the PARENT's lifecycle, not this
        // row's. `row.status` is the canonical column for the slug actually
        // being started.
        const lifecycle = read?.row.status ?? read?.parsed.frontmatter.status ?? null;
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

        // P-006 start gate. `start` is gated even though it only flips status
        // (D-008 Q1): a started plan is one the orchestrator may pick promoted
        // features from, so it IS an execution signal. Gating the earliest door means
        // a plan missing its arguments is caught here rather than by whichever
        // downstream thing eventually tries to run it.
        const gate = await checkPlanStartable(slug, await ctxToPlanSourceOpts(sctx));
        if (!gate.ok) {
          ctxAny.metadata?.({ slug, harnessSlug, refused: gate.refusal.code });
          // The refusal already carries `slug`; only harnessSlug is additive here.
          return { ok: false as const, harnessSlug, ...gate.refusal };
        }

        // P-010 (get-feedback-relevance-consults-2026-08-16) as amended by
        // consult-min-max-and-rubric-vetting-2026-08-17 P-002 (D-001 §2): the
        // plan-start CHECKPOINT consult runs with min:1 — a plan never
        // promotes with zero feedback merely because nobody cleared the
        // relevance floor. The ROUTING is mandatory (the plan body is the
        // system-authored query); a wake is not. ANY selectable live/parked
        // candidate — floor-qualified or best-available minimum fill, labeled
        // via:'floor'|'minimum' (D-002) — nudge-refuses ONCE (override:
        // consulted:false + consult_reason — the similar_exists/force shape);
        // a floor-qualified-but-all-dead set injects transcript excerpts
        // instead (retrieval, not consult); the proceed verdicts survive only
        // where the minimum is physically unfillable (D-003:
        // no_live_responder / no_qualified_responder — recorded, not silent).
        // NUDGE, never a hard block: any router/infra fault proceeds.
        let checkpointConsult: Record<string, unknown> | undefined;
        if (args.consulted !== undefined) {
          // Override / acknowledgement path: routing already ran on the
          // refused call — record the caller's disposition durably (the
          // tool_invocations ledger via ctx.metadata + the result) and start.
          checkpointConsult = {
            overridden: true,
            consulted: args.consulted,
            ...(args.consult_reason ? { reason: args.consult_reason } : {}),
          };
          ctxAny.metadata?.({
            slug,
            harnessSlug,
            consultOverride: args.consulted,
            ...(args.consult_reason ? { consultReason: args.consult_reason } : {}),
          });
        } else if (read?.row.content) {
          try {
            const [
              { getOrgPg },
              { routeConsult },
              { buildQueryEmbedder },
              { resolveSessionStates },
              consult,
              { resolveAgentIdentity },
            ] = await Promise.all([
              import('@papercusp/db-org'),
              import('../../consult/relevance-router'),
              import('../search/embedder'),
              import('../coordination/liveness-oracle'),
              import('../../consult/plan-start-consult'),
              import('../coordination/identity'),
            ]);
            const embed = await buildQueryEmbedder();
            const outcome = await consult.planStartConsult(
              {
                workspaceId: startWorkspaceId,
                requesterId: resolveAgentIdentity(ctx).ownerId,
                planSlug: slug,
                planContent: read.row.content,
              },
              {
                route: (params) =>
                  routeConsult(params, {
                    getSql: () => getOrgPg().sql,
                    embed,
                    getLiveness: async (ownerIds) => {
                      const verdicts = await resolveSessionStates(
                        ownerIds.map((ownerId) => ({ ownerId })),
                        { hydratePerId: true },
                      );
                      return Object.fromEntries(
                        [...verdicts.values()].map((v) => [v.ownerId, v.sessionState]),
                      );
                    },
                  }),
                getExcerpts: (refs) => consult.fetchTurnExcerpts(getOrgPg().sql, startWorkspaceId, refs),
              },
            );
            ctxAny.metadata?.({
              slug,
              harnessSlug,
              checkpointConsult: outcome.outcome,
              ...(outcome.outcome === 'proceed' ? { checkpointVerdict: outcome.verdict } : {}),
            });
            if (outcome.outcome === 'nudge') {
              const hasMinimumFill = outcome.selection.selected.some((s) => s.via === 'minimum');
              return {
                ok: false as const,
                slug,
                harnessSlug,
                error: 'consult_available' as const,
                candidates: outcome.candidates,
                selection: outcome.selection,
                hint:
                  'Peers with relevant transcript history were selected for this plan — `selection.selected` labels each: via "floor" = cleared the router\'s precision floor on real evidence; via "minimum" = best-available LIVE peer BELOW the floor, selected because the plan-step consult carries a minimum of 1 (a plan never promotes with zero feedback merely because nobody cleared the threshold; a wrong plan assumption multiplies across every promoted item, so this is the cheapest moment to check it). ' +
                  (hasMinimumFill
                    ? 'A via:"minimum" candidate should review from FIRST PRINCIPLES — their selection is best-available, not evidence-matched. '
                    : '') +
                  'Review the candidates + their evidence turns; consult via get_feedback { question } — its default minResponders:1 reaches at least the best-available live peer. ' +
                  'Then re-call plans:start with consulted: true (+ consult_reason naming what the consult concluded), or consulted: false + consult_reason to proceed without consulting — the override always works; this is a nudge, never a gate.',
              };
            }
            if (outcome.outcome === 'proceed' && outcome.verdict === 'no_live_responder') {
              // Not silent (P-002): a candidate pool existed but only liveness
              // kept everyone out — record the honest verdict on the result.
              checkpointConsult = {
                verdict: 'no_live_responder',
                note:
                  'The plan-start consult found candidate peer history, but no LIVE candidate exists to consult (min:1 physically unfillable) — the start proceeded. Consider get_feedback later if a relevant peer comes alive.',
              };
            }
            if (outcome.outcome === 'proceed_with_excerpts') {
              checkpointConsult = {
                verdict: 'routed_dead_context',
                note:
                  'The router found above-floor peer history for this plan, but every candidate context is dead — no wake is possible, so their matched transcript excerpts are injected here instead (retrieval, not consult). Read them before fanning out.',
                candidates: outcome.candidates.map((c) => ({
                  ownerId: c.ownerId,
                  score: c.score,
                  liveness: c.liveness,
                })),
                excerpts: outcome.excerpts,
              };
            }
          } catch {
            /* nudge, never block — a router/infra fault must not stop a start */
          }
        }

        // P-047 / D-010: the op_status axis retires with the Mug/Kettle tier.
        // Fail-CLOSED via mugKettleSystemEnabled (an unreadable flag resolves to
        // retired) — a false `true` re-reserves a plan's items for a dispatcher
        // that is not running, which is the failure this gate exists to stop.
        const axisLive = await mugKettleSystemEnabled();

        type StartRow = { op_status: string | null; op_updated_at: string | null; prev_op_status: string | null };
        // RETIRED branch: READ the row instead of writing it, on the SAME
        // (workspace, harness, slug) key the UPDATE used — so the plan_not_found
        // detection below (WI-5825) keeps working identically. `prev_op_status`
        // mirrors the current value, so `transitioned` is false by construction.
        const rows: StartRow[] = !axisLive
          ? await withWorkspace(startWorkspaceId, async (tx) => {
              return tx<StartRow[]>`
                SELECT op_status, op_updated_at, op_status AS prev_op_status
                  FROM harness_shared.harness_plans
                 WHERE workspace_id = ${startWorkspaceId}
                   AND harness_slug = ${harnessSlug}
                   AND plan_slug    = ${slug}
                 LIMIT 1
              `;
            })
          : await withWorkspace(startWorkspaceId, async (tx) => {
              return tx<StartRow[]>`
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
        // `axisLive &&` is load-bearing, not belt-and-braces: in the retired
        // branch prev_op_status is the row's CURRENT value, so a never-started
        // plan would otherwise score `null !== 'started'` = transitioned and fire
        // the demand event for a start that never happened.
        const transitioned = axisLive && row.prev_op_status !== 'started';

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
          // NOT 'started' while retired — reporting a status the row does not
          // carry is precisely the "announced a start that never happened" bug
          // WI-5825 fixed one layer down.
          status: axisLive ? 'started' : null,
          updatedAt: row?.op_updated_at,
          autoApproved,
          transitioned,
          previousOpStatus: row?.prev_op_status ?? null,
          ...(checkpointConsult ? { checkpointConsult } : {}),
          ...(axisLive
            ? {}
            : {
                opStatusRetired: true as const,
                message:
                  'Plan approved. Item promotion runs asynchronously; verify claimable work-items before launching a fleet. The operational started axis is PERMANENTLY RETIRED ' +
                  '(P-068 DELETED papercusp-mug-kettle-system — there is no flag to flip and no ' +
                  'toggle in /admin/features), so op_status was not written — su agents self-select ' +
                  'these items via scheduler:get_next instead of waiting for a dispatcher.',
              }),
        };
      },
      { keyOf: (slug) => ({ slug }) },
    );

    return bulkContent(env);
  },
});
