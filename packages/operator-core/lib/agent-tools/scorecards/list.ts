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
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { listScorecardPage } from '../../scorecards';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

export default defineTool({
  name: 'scorecards:list',
  profile: 'engineer',
  description:
    'Read rubric SCORECARDS back — rubric-graded observations (rubricRef + per-criterion {rating, evidence}). Filter by rubricRef + sourceHive + subjectRef + since; newest-first. `subjectRef` is the scalar observation.subject.ref filter (for example a WI-/EI- id), unlike scorecards:emit\'s structured subject:{kind,ref}. ⚠ SYNTHESIZED floors (turn-end backstop / scheduled-pulse) are EXCLUDED by default — pass includeSynthesized:true for the "is the data layer alive at all?" read (e.g. while overwatch is paused).',
  guidance: {
    when: 'You want to SEE the rubric scorecards that have been emitted — e.g. did Overwatch emit a COMPLETE pot-coordination-health scorecard recently (missingKeys empty)? what is one criterion\'s rating over time? is there an emission gap? The data substrate for trend/freshness/self-comparison monitoring. To filter by the graded subject, pass the scalar `subjectRef` (the stored observation.subject.ref), not emit\'s structured `subject:{kind,ref}` object.',
    notWhen:
      'You want the RUBRIC definition (criteria/model/method) — rubrics:get / rubrics:list. You want the cross-corpus meta-pattern rollup incl. rubric ratings grouped for ideation — curation:state-of-pot. You are FILING a scorecard — scorecards:emit.',
    chaining:
      'scorecards:list { rubricRef: "pot-coordination-health", subjectRef: "EI-123", since } → inspect missingKeys for completeness / ratings for the latest standing → drill into a row via work_items:get { id: issueId }, or rubrics:get { rubricRef } for the criterion definitions.',
    returns:
      'Rows carry ratings, synthesized, nKeys, missingKeys (completeness). `ratings`, `gradedGeneration` and `generationFreshness` are nested OBJECTS on the row, never scalars (`generationFreshness` is present only when the row carries a `gradedGeneration`), so a flat/CSV projection over a row fails on them. `count` is the returned page size; `hasMore` and `truncatedByLimit` say when the page is capped.',
    seeAlso: [
      'scorecards:freshness (staleness / partial-emit summary)',
      'scorecards:evaluate (typed grading skeleton + evidence delta)',
      'scorecards:emit (validated scorecard write)',
      'rubrics:trend (criteria trend over time)',
      'rubrics:get (the rubric criterion definitions)',
    ],
  },
  // EI-21437537919383948: this is a correctness read, not a browseable list.
  // Each row carries the complete per-criterion ratings/evidence map; allowing
  // the ambient trimmed session tier to reshape that nested map can turn a
  // 4-of-7 scorecard into an apparently complete 4-criterion card. Keep the
  // result-door spill lossless (the explicit hard ceiling still applies), just
  // as scorecards:evaluate and rubrics:get do for their correctness payloads.
  ignoreSessionPayloadTier: true,
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  args: z.object({
    rubricRef: z
      .string()
      .optional()
      .describe('restrict to one rubric, e.g. "pot-coordination-health"; omit for all rubric-graded scorecards'),
    sourceHive: z.string().optional().describe('restrict to scorecards from one source-hive'),
    harness: z
      .string()
      .min(1)
      .max(120)
      .optional()
      .describe(
        'Optional caller scope hint accepted for compatibility; scorecard history is workspace-scoped and this hint does not filter the read.',
      ),
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
  result: z
    .object({
      ok: z.boolean().optional(),
      count: z.number().int().nonnegative().optional(),
      hasMore: z.boolean().optional(),
      truncatedByLimit: z.boolean().optional(),
      scorecards: z.array(z.unknown()).optional(),
      error: z.string().optional(),
      retryable: z.boolean().optional(),
      pgCode: z.string().optional(),
      message: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      try {
        const page = await listScorecardPage({
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
          data: {
            ok: true,
            count: page.rows.length,
            hasMore: page.hasMore,
            truncatedByLimit: page.hasMore,
            scorecards: page.rows,
          },
        };
      } catch (error) {
        // EI-21592547181442895: an exhausted, transient read contention sequence is
        // actionable to callers and must not degrade into generic handler_error.
        if (error instanceof OrgTxnTimeoutError) {
          return {
            data: {
              ok: false,
              error: 'timeout',
              retryable: true,
              pgCode: error.pgCode,
              message:
                `scorecards:list read hit transient database contention: ${error.message}. ` +
                'No scorecards were returned; retry shortly.',
            },
          };
        }
        throw error;
      }
    });
  },
});
