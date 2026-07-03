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
import { checkScorecardFreshness, interpretOverwatchEmission } from '../../scorecard-freshness';
import { COORDINATION_RUBRIC_REF } from '../../overwatch/scorecard-backstop';
import { getOverwatchLiveness } from '../../overwatch/snapshot';

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
    seeAlso: [
      'scorecards:list (the raw scorecards behind the freshness view)',
      'rubrics:trend (per-criterion trend over time)',
    ],
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
    const out: {
      ok: true;
      freshness: typeof freshness;
      overwatch?: {
        flagEnabled: boolean;
        started: boolean;
        loopAlive: boolean;
        loopStale: boolean;
        lastRunAt: string | null;
        cadenceSec: number;
      };
      interpretation?: ReturnType<typeof interpretOverwatchEmission>;
    } = { ok: true, freshness };
    // WI-1724 (monitor-the-monitor is silent): a bare `stale`/`partial-only` verdict for the
    // Overwatch's OWN rubric is ambiguous — disabled (ignore) vs paused/not-started (ignore) vs
    // a DEAD wake-loop (revive) vs a live-loop-but-skipping AGENT (fix the turn) all read the
    // same. Cross-reference the live overwatch liveness so the verdict self-interprets. Only for
    // the coordination rubric (the Overwatch's mandate); fail-soft — a degraded liveness read
    // just omits the enrichment rather than erroring the freshness check.
    if (args.rubricRef === COORDINATION_RUBRIC_REF) {
      try {
        const liveness = await getOverwatchLiveness(
          args.sourceHive ? { hiveSlug: args.sourceHive } : undefined,
        );
        const overwatch = {
          flagEnabled: liveness.flagEnabled,
          started: liveness.started,
          loopAlive: liveness.alive,
          loopStale: liveness.stale,
          lastRunAt: liveness.lastRunAt,
          cadenceSec: liveness.cadenceSec,
        };
        out.overwatch = overwatch;
        out.interpretation = interpretOverwatchEmission(freshness.status, overwatch);
      } catch {
        // fail-soft — omit the enrichment; the raw freshness still returns.
      }
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(out) }],
    };
  },
});
