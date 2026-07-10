/**
 * pot:survey — the Mug's plan-aware placement survey
 * (queen-autonomous-execution-2026-06-13 B-08 / P-010, P-012).
 *
 * One call returns BOTH ranked views of the Pot's work (autonomy-policy D-013),
 * ranked by the ONE placement registry (lib/pot/placement-ranker.ts):
 *   - `plans`    — every STARTED plan across the Pot's MEMBER harnesses, ranked
 *                  "which plan to pour cups into" (the plan-item / Queue side).
 *   - `frontier` — every unplaced (todo, unassigned) work-item across the same
 *                  harnesses, ranked "which ready item to place" (dispatch side).
 *
 * It surveys every MEMBER harness (registry `hive_slug`), not the Mug's home
 * seat — the P-012 fix for the 2026-06-11 home-slug-only miss; membership not
 * wired ⇒ a workspace-wide survey, so the home-only blind spot can't recur.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolvePotHomeSlug } from '../../pot/wake';
import { surveyPot, surveyWorkspace } from '../../pot/survey';
import { placementRankerSpec } from '../../pot/placement-ranker';
import { isWorkspaceCoordinationOn } from '../../workspace-brain-scope';
import { shapePotSurvey } from './survey-shape';
import type { Ranked } from '../../queue-ranker';
import type { PlacementCandidate } from '../../pot/placement-ranker';

/** Compact a ranked candidate for the Mug — id, score, top reasons, signals.
 *  The `hive` tag is surfaced ONLY when present (the cross-pot workspace survey
 *  sets it; the single-pot survey omits it → byte-identical OFF output). */
function compact(c: Ranked<PlacementCandidate>) {
  const reasons = c.rank.features.flatMap((f) => f.reasons).slice(0, 4);
  return {
    id: c.id,
    harness: c.harness,
    ...(c.pot ? { pot: c.pot } : {}),
    title: c.title,
    importance: c.importance ?? 'normal',
    score: Math.round(c.rank.score * 100) / 100,
    ...(reasons.length > 0 ? { why: reasons } : {}),
    ...(c.openItems != null ? { openItems: c.openItems } : {}),
    ...(c.escalations ? { escalations: c.escalations } : {}),
  };
}

export default defineTool({
  name: 'pot:survey',
  profile: 'engineer',
  description:
    "The Mug's plan-aware placement survey: started plans ranked (which plan to pour cups into) AND the unplaced work-item frontier ranked (which ready item to place), across EVERY member harness — one ranker, two views. Read-only; call it at the top of a placement wake.",
  guidance: {
    when: 'You are the Mug starting a placement wake — survey what to work on next (which plan matters, which ready items to place) across all member harnesses.',
    notWhen: 'You already hold a specific work-item id and just need to place it — go straight to cup:spawn / the batch placement.',
    chaining:
      'pot:survey → place the top frontier items (cup:spawn / batch placement) and steer plan order (work_items:set_priority / plans:set-priority); pot:status to inspect the wake declaration.',
    seeAlso: [
      'pot:status (inspect the wake declaration)',
      'work_items:set_priority (steer the frontier order surveyed)',
      'fleet:assignments (who is already placed on the frontier)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Pot home harness slug (default: ctx harness or PAPERCUSP_POT_HOME_SLUG).'),
    frontierLimit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Max frontier work-items to rank+return (default 50).'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Max ranked rows returned per view (default 20).'),
  }),
  // context-trimming-tiers P-024: trimmed/standard sessions get capped ranked
  // rows (top-reason why, clipped titles) and — trimmed — the static ranker
  // spec replaced by a pointer (see survey-shape.ts).
  shape: {
    standard: (data) => shapePotSurvey(data, 'standard'),
    trimmed: (data) => shapePotSurvey(data, 'trimmed'),
  },
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolvePotHomeSlug(args.harness, undefined);
    if (!installSlug) {
      return {
        data: {
          ok: false,
          error: 'no_home_harness',
          message: 'Pass `harness` (or set PAPERCUSP_POT_HOME_SLUG) — the survey is Pot-scoped.',
        },
      };
    }

    const limit = args.limit ?? 20;

    // P-003 (workspace-scoped-coordination-2026-06-20 / D-002): the central
    // dispatcher. When FLAGS.WORKSPACE_COORDINATION is ON, the ONE workspace
    // Mug surveys EVERY pot — per-pot sections (focused ideation, the D-004
    // dilution mitigation) PLUS a single cross-pot ranked backlog she dispatches
    // by cross-pot priority (each row pot-tagged so placement routes onto the
    // right pot's cups). OFF (the dark default) ⇒ the single-pot survey,
    // BYTE-IDENTICAL to today.
    if (await isWorkspaceCoordinationOn()) {
      const ws = await surveyWorkspace(workspaceId, {
        frontierLimit: args.frontierLimit,
        fallbackHome: installSlug,
      });
      // {data} envelope so the payload-tier shapers apply (P-024).
      return {
        data: {
          ok: true,
          scope: 'workspace',
          hives: ws.hives,
          counts: {
            hives: ws.hives.length,
            plans: ws.crossPot.plans.length,
            frontier: ws.crossPot.frontier.length,
            frontierBlocked: ws.crossPot.frontierBlocked,
          },
          // The cross-pot ranked priority — the central-dispatch ordering.
          crossPot: {
            plans: ws.crossPot.plans.slice(0, limit).map(compact),
            frontier: ws.crossPot.frontier.slice(0, limit).map(compact),
          },
          // The per-pot sections — focused, so ideation/placement stays scoped.
          perPot: ws.perPot.map(({ pot, survey }) => ({
            pot,
            home: survey.home,
            members: survey.members,
            scope: survey.scope,
            counts: { plans: survey.plans.length, frontier: survey.frontier.length, frontierBlocked: survey.frontierBlocked },
            plans: survey.plans.slice(0, limit).map(compact),
            frontier: survey.frontier.slice(0, limit).map(compact),
          })),
          ranker: placementRankerSpec(),
        },
      };
    }

    const survey = await surveyPot(workspaceId, installSlug, {
      frontierLimit: args.frontierLimit,
    });

    // {data} envelope so the payload-tier shapers apply (P-024).
    return {
      data: {
        ok: true,
        home: survey.home,
        members: survey.members,
        scope: survey.scope,
        counts: { plans: survey.plans.length, frontier: survey.frontier.length, frontierBlocked: survey.frontierBlocked },
        plans: survey.plans.slice(0, limit).map(compact),
        frontier: survey.frontier.slice(0, limit).map(compact),
        ranker: placementRankerSpec(),
      },
    };
  },
});
