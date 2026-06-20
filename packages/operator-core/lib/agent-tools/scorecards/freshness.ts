/**
 * scorecards:freshness — has the Overwatch emitted a COMPLETE scorecard recently?
 * (plan-templates-and-rubric-v2-2026-06-20 P-014b / D-005).
 *
 * The emission-freshness READ — the monitor-the-monitor query. P-014a's completeness GATE makes a
 * partial scorecard fail at WRITE; this makes a NO-emit or PARTIAL-only window VISIBLE at READ, so
 * a silently-skipping or silently-truncating Overwatch surfaces as a status instead of being missed
 * (D-005: a ~4h emission gap + 2-of-4 partials were invisible until a raw PG read). Built on
 * checkScorecardFreshness over scorecards:list (P-013, su-3a5d7).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { checkScorecardFreshness } from '../../scorecard-freshness';

export default defineTool({
  name: 'scorecards:freshness',
  profile: 'engineer',
  description:
    'Has the Overwatch emitted a COMPLETE scorecard for a rubric since a given time (its last wake)? The emission-freshness check (monitor-the-monitor): returns status = fresh (a COMPLETE scorecard landed in-window) | partial-only (scorecards landed but ALL incomplete — a silent truncation) | stale (NOTHING landed — a silent emission gap), plus emitted / complete / count / partialCount, lastEmittedAt, lastCompleteAt, and latestMissingKeys (what is unrated right now). Reads scorecards:list (P-013); a "complete" scorecard rates every rubric criterion.',
  guidance: {
    when: 'You want to know whether the Overwatch is actually emitting COMPLETE scorecards, not just whether it emitted anything — monitor-the-monitor. Did a complete hive-coordination-health scorecard land since the last wake (status fresh), or is it silently skipping (stale) / truncating to partials (partial-only)? Pass `since` = the last wake for a precise check.',
    notWhen:
      'You want the scorecard ROWS + their ratings — scorecards:list. You want a criterion\'s rating TREND over time — rubrics:trend. You are FILING a scorecard — improvements:capture { lane: "observation", observation: { rubricRef, ratings } }.',
    chaining:
      'scorecards:freshness { rubricRef: "hive-coordination-health", since } → status stale/partial-only ⇒ the Overwatch missed or truncated → scorecards:list { rubricRef, since } to see what (if anything) it emitted, or check latestMissingKeys for which criteria were dropped.',
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    rubricRef: z.string().describe('the rubric to check freshness for, e.g. "hive-coordination-health"'),
    sourceHive: z.string().optional().describe('restrict to scorecards from one source-hive'),
    since: z
      .string()
      .optional()
      .describe(
        'ISO timestamp — the window start; pass the Overwatch\'s last wake for a precise "since last wake" check. Omit for a lookback default.',
      ),
    lookbackMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('fallback window size in ms when `since` is omitted (default 2h)'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const freshness = await checkScorecardFreshness({
      rubricRef: args.rubricRef,
      sourceHive: args.sourceHive,
      since: args.since,
      lookbackMs: args.lookbackMs,
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, freshness }) }],
    };
  },
});
