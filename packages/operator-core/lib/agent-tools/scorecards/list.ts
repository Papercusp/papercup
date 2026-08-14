/**
 * scorecards:list — read structured rubric scorecards back
 * (plan-templates-and-rubric-v2-2026-06-20 P-013 / D-005).
 *
 * The READ side of the every-turn Overwatch scorecard. Until this tool, a
 * scorecard (a rubric-graded structured observation on
 * engineer_issues.payload.observation) was WRITE-ONLY — emission gaps + partial
 * scorecards were invisible except via raw PG. This is the linchpin the
 * monitoring layer builds on: P-010 (trend) aggregates over it, P-014
 * (emission-freshness + completeness) reads it, and the Overwatch's own
 * turn-over-turn self-comparison needs it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { listScorecards } from '../../scorecards';

export default defineTool({
  name: 'scorecards:list',
  profile: 'engineer',
  description:
    'Read rubric SCORECARDS back — rubric-graded observations (rubricRef + per-criterion {rating, evidence}). Filter by rubricRef + sourceHive + since; newest-first. ⚠ SYNTHESIZED floors (turn-end backstop / scheduled-pulse) are EXCLUDED by default — pass includeSynthesized:true for the "is the data layer alive at all?" read (e.g. while overwatch is paused). Rows carry ratings, synthesized, nKeys, missingKeys (completeness).',
  guidance: {
    when: 'You want to SEE the rubric scorecards that have been emitted — e.g. did the Kettle emit a COMPLETE pot-coordination-health scorecard recently (missingKeys empty)? what is one criterion\'s rating over time? is there an emission gap? The data substrate for trend/freshness/self-comparison monitoring.',
    notWhen:
      'You want the RUBRIC definition (criteria/model/method) — rubrics:get / rubrics:list. You want the cross-corpus meta-pattern rollup incl. rubric ratings grouped for ideation — curation:state-of-pot. You are FILING a scorecard — scorecards:emit.',
    chaining:
      'scorecards:list { rubricRef: "pot-coordination-health", since } → inspect missingKeys for completeness / ratings for the latest standing → drill into a row via work_items:get { id: issueId }, or rubrics:get { rubricRef } for the criterion definitions.',
    seeAlso: [
      'scorecards:freshness (staleness / partial-emit summary)',
      'scorecards:evaluate (typed grading skeleton + evidence delta)',
      'scorecards:emit (validated scorecard write)',
      'rubrics:trend (criteria trend over time)',
      'rubrics:get (the rubric criterion definitions)',
    ],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    rubricRef: z
      .string()
      .optional()
      .describe('restrict to one rubric, e.g. "pot-coordination-health"; omit for all rubric-graded scorecards'),
    sourceHive: z.string().optional().describe('restrict to scorecards from one source-hive'),
    subjectRef: z
      .string()
      .optional()
      .describe(
        'restrict to scorecards GRADING one subject (observation.subject.ref) — the per-RUN axis: an agent ownerId, session id, WI-/EI- id, plan or pot slug. Use for a per-run rubric (e.g. goal-mode-e2e) where sourceHive only says which pot. Absent on pre-2026-08-10 scorecards, which recorded no subject.',
      ),
    since: z
      .string()
      .optional()
      .describe('ISO timestamp — only scorecards filed at/after this (the time-window); omit for all'),
    limit: z.number().int().positive().max(500).optional().describe('max rows, newest-first (default 100, max 500)'),
    includeSynthesized: z
      .boolean()
      .optional()
      .describe(
        'also return SYNTHESIZED floor scorecards (turn-end backstop + scheduled-pulse). Default false — agent-emission reads exclude floors; pass true to verify the data layer itself (e.g. is the pulse filing while overwatch is paused?)',
      ),
    includeSuperseded: z
      .boolean()
      .optional()
      .describe('Audit view: also include scorecards replaced by a later payload-native supersedes filing.'),
    includeRetracted: z
      .boolean()
      .optional()
      .describe('Audit view: also include deliberately retracted scorecards and their withdrawal metadata.'),
  }),
  async handler(args, ctx) {
    resolveAgentIdentity(ctx);
    const scorecards = await listScorecards({
      rubricRef: args.rubricRef,
      sourceHive: args.sourceHive,
      subjectRef: args.subjectRef,
      since: args.since,
      limit: args.limit,
      includeSynthesized: args.includeSynthesized,
      includeSuperseded: args.includeSuperseded,
      includeRetracted: args.includeRetracted,
      // WI-6124: links are opt-IN. This tool returns whole rows to an agent, so it is a
      // surfacing read — keep it true or agents silently see every scorecard as unlinked.
      includeLinks: true,
    });
    return {
      data: { ok: true, count: scorecards.length, scorecards },
    };
  },
});
