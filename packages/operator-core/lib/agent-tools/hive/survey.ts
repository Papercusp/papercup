/**
 * hive:survey — the Queen's plan-aware placement survey
 * (queen-autonomous-execution-2026-06-13 B-08 / P-010, P-012).
 *
 * One call returns BOTH ranked views of the Hive's work (autonomy-policy D-013),
 * ranked by the ONE placement registry (lib/hive/placement-ranker.ts):
 *   - `plans`    — every STARTED plan across the Hive's MEMBER harnesses, ranked
 *                  "which plan to pour bees into" (the plan-item / Queue side).
 *   - `frontier` — every unplaced (todo, unassigned) work-item across the same
 *                  harnesses, ranked "which ready item to place" (dispatch side).
 *
 * It surveys every MEMBER harness (registry `hive_slug`), not the Queen's home
 * seat — the P-012 fix for the 2026-06-11 home-slug-only miss; membership not
 * wired ⇒ a workspace-wide survey, so the home-only blind spot can't recur.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveHiveHomeSlug } from '../../hive/wake';
import { surveyHive } from '../../hive/survey';
import { placementRankerSpec } from '../../hive/placement-ranker';
import type { Ranked } from '../../queue-ranker';
import type { PlacementCandidate } from '../../hive/placement-ranker';

/** Compact a ranked candidate for the Queen — id, score, top reasons, signals. */
function compact(c: Ranked<PlacementCandidate>) {
  const reasons = c.rank.features.flatMap((f) => f.reasons).slice(0, 4);
  return {
    id: c.id,
    harness: c.harness,
    title: c.title,
    importance: c.importance ?? 'normal',
    score: Math.round(c.rank.score * 100) / 100,
    ...(reasons.length > 0 ? { why: reasons } : {}),
    ...(c.openItems != null ? { openItems: c.openItems } : {}),
    ...(c.escalations ? { escalations: c.escalations } : {}),
  };
}

export default defineTool({
  name: 'hive:survey',
  profile: 'engineer',
  description:
    "The Queen's plan-aware placement survey: started plans ranked (which plan to pour bees into) AND the unplaced work-item frontier ranked (which ready item to place), across EVERY member harness — one ranker, two views. Read-only; call it at the top of a placement wake.",
  guidance: {
    when: 'You are the Queen starting a placement wake — survey what to work on next (which plan matters, which ready items to place) across all member harnesses.',
    notWhen: 'You already hold a specific work-item id and just need to place it — go straight to fleet:spawn / the batch placement.',
    chaining:
      'hive:survey → place the top frontier items (fleet:spawn / batch placement) and steer plan order (work_items:set_priority / plans:set-priority); hive:status to inspect the wake declaration.',
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z
      .string()
      .max(120)
      .optional()
      .describe('Hive home harness slug (default: ctx harness or PAPERCUSP_HIVE_HOME_SLUG).'),
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
  async handler(args, ctx) {
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? activeWorkspaceId();
    const installSlug = resolveHiveHomeSlug(args.harness, ctx.harnessSlug);
    if (!installSlug) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: false,
              error: 'no_home_harness',
              message: 'Pass `harness` (or set PAPERCUSP_HIVE_HOME_SLUG) — the survey is Hive-scoped.',
            }),
          },
        ],
      };
    }

    const survey = await surveyHive(workspaceId, installSlug, {
      frontierLimit: args.frontierLimit,
    });
    const limit = args.limit ?? 20;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            home: survey.home,
            members: survey.members,
            scope: survey.scope,
            counts: { plans: survey.plans.length, frontier: survey.frontier.length, frontierBlocked: survey.frontierBlocked },
            plans: survey.plans.slice(0, limit).map(compact),
            frontier: survey.frontier.slice(0, limit).map(compact),
            ranker: placementRankerSpec(),
          }),
        },
      ],
    };
  },
});
