/**
 * rubrics:trend — the qualitative health TREND for a rubric
 * (plan-templates-and-rubric-v2-2026-06-20 P-010 / D-004).
 *
 * The every-turn Overwatch scorecard already IS a per-criterion rating
 * time-series; this rolls it up — per criterion, over time, with a direction —
 * so the Queen/owner sees "queen-placement-health: degraded, worsening over 5
 * ratings" instead of re-reading raw scorecards. Pure read+aggregate over the
 * scorecards (P-013, scorecards:list) — no new data, the quick-win the data
 * already supported.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { scorecardTrend } from '../../scorecards';

export default defineTool({
  name: 'rubrics:trend',
  profile: 'engineer',
  description:
    'The qualitative health TREND for a rubric — aggregate the every-turn Overwatch scorecard rating time-series per criterion over time, each with a direction (improving | worsening | stable | unknown), a rating distribution, first/latest rating, and the full chronological series. The health-over-time view ("queen-placement-health: degraded, worsening over 5 ratings"). Reads the scorecards (P-013) — no new data.',
  guidance: {
    when: 'You want to see how a rubric\'s criteria have trended OVER TIME — is a characteristic improving or worsening? which criteria are degrading across recent wakes? The qualitative health-over-time view, vs a single point-in-time scorecard.',
    notWhen:
      'You want the raw recent scorecards (point-in-time standing + completeness via missingKeys) — scorecards:list. You want the rubric DEFINITION (criteria/model/method) — rubrics:get. You want the cross-corpus ideation rollup — curation:state-of-hive.',
    chaining:
      'rubrics:list { status: "active" } → rubrics:trend { rubricRef, since } → drill a worsening criterion via scorecards:list { rubricRef, since } → work_items:get on a scorecard issueId.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    rubricRef: z.string().describe('the rubric to trend, e.g. "hive-coordination-health" (a trend is per-rubric)'),
    sourceHive: z.string().optional().describe('restrict the trend to one source-hive'),
    since: z
      .string()
      .optional()
      .describe('ISO timestamp — only scorecards filed at/after this (the trend window); omit for all'),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe('max scorecards to aggregate (newest-first read; default 500)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const trend = await scorecardTrend({
      rubricRef: args.rubricRef,
      sourceHive: args.sourceHive,
      since: args.since,
      limit: args.limit,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ ok: true, trend }),
        },
      ],
    };
  },
});
