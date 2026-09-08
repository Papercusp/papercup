/** scorecards:get — evidence-first read of one scorecard for grading-integrity audits. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readScorecardEvidence } from '../../scorecards';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';

export const scorecardGetArgs = z.object({
  issueId: z
    .string()
    .min(1)
    .max(120)
    .describe('the scorecard issue id (EI-/WI-) whose criterion evidence must be re-run'),
});

export default defineTool({
  name: 'scorecards:get',
  profile: 'engineer',
  description:
    'Read ONE rubric scorecard by issue id using an evidence-first projection. Returns the exact per-criterion `{key, rating, evidence}` strings plus minimal card identity and completeness fields; omits replay recipes, generation metadata, links, and other history-only payload. Use this before a grading-integrity audit so evidence is inline rather than hidden by a history-row projection or result-door spill.',
  guidance: {
    when: 'You are auditing one existing scorecard and must re-run the probe stated in every criterion evidence string. Pass the scorecard issueId returned by scorecards:list or a grading-audit dispatch reservation.',
    notWhen:
      'You want scorecard history, trend inputs, or multiple rows — scorecards:list. You want a rubric definition — rubrics:get. You are filing a scorecard — scorecards:emit.',
    chaining:
      'scorecards:get { issueId } → re-run every returned criteria[].evidence probe → scorecards:emit { rubricRef:"grading-integrity", subject:{kind:"scorecard",ref:issueId}, ratings } to settle the audit.',
    returns:
      'Returns `{ ok, scorecard }`; scorecard.criteria is an ordered array of exact `{key,rating,evidence}` entries, and missingKeys/extraKeys/rubricResolved make completeness explicit. It intentionally does not return the full scorecards:list row.',
    seeAlso: ['scorecards:list', 'scorecards:emit', 'rubrics:get'],
  },
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES, 'judge'],
  // This tool's projection is intentionally bounded at the source. It still
  // opts out of ambient tier shaping so a trimmed audit session cannot replace
  // evidence strings with depth-limit placeholders. The shared 30k ceiling
  // remains active as a final safety rail.
  ignoreSessionPayloadTier: true,
  args: scorecardGetArgs,
  result: z
    .object({
      ok: z.boolean(),
      scorecard: z.unknown().optional(),
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
        const result = await readScorecardEvidence(args.issueId);
        if (result.kind === 'not_found') {
          return { data: { ok: false as const, error: `scorecard '${args.issueId}' not found` } };
        }
        if (result.kind === 'not_scorecard') {
          return { data: { ok: false as const, error: `'${args.issueId}' is not a scorecard` } };
        }
        return { data: { ok: true as const, scorecard: result.scorecard } };
      } catch (error) {
        if (error instanceof OrgTxnTimeoutError || error instanceof DbCallDeadlineError) {
          return {
            data: {
              ok: false as const,
              error: 'timeout',
              retryable: true,
              ...(error instanceof OrgTxnTimeoutError ? { pgCode: error.pgCode } : {}),
              message:
                `scorecards:get read hit transient database contention: ${error.message}. ` +
                'No scorecard was returned; retry shortly.',
            },
          };
        }
        throw error;
      }
    });
  },
});
