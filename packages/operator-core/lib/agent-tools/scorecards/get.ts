/** scorecards:get — evidence-first read of one scorecard for grading-integrity audits. */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS } from '@papercusp/tooldef';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { getDoorConstantsSync } from '../../context-doors-config';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { readScorecardEvidence, type ScorecardEvidenceRow } from '../../scorecards';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { runWithWorkspaceIfConcrete } from '../../workspace-als';
import {
  OBSERVATION_ATTRIBUTIONS,
  OBSERVATION_UNKNOWN_REASONS,
} from '../../harness/improvements/observation-types';

export const scorecardGetArgs = z.object({
  issueId: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('the scorecard issue id (EI-/WI-) whose criterion evidence must be re-run; preferred over the id alias'),
  id: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Compatibility alias for issueId for generic id-based read callers; issueId wins when both are supplied.'),
  criterionKey: z.string().min(1).max(200).optional()
    .describe('Read one criterion from an oversized card index. Evidence remains exact; follow evidenceRead.next until complete.'),
  indexOffset: z.number().int().min(0).optional()
    .describe('Resume a paged criterion index at evidenceRead.next.args.indexOffset.'),
  evidenceOffset: z.number().int().min(0).optional()
    .describe('UTF-16 offset from evidenceRead.next for one criterion. Concatenate pages in order; never grade from an incomplete page.'),
}).refine(({ issueId, id }) => issueId !== undefined || id !== undefined, {
  message: 'issueId or id is required',
  path: ['issueId'],
}).refine(({ criterionKey, indexOffset }) => criterionKey === undefined || indexOffset === undefined, {
  message: 'criterionKey and indexOffset cannot be combined',
  path: ['indexOffset'],
});

// Bound the JSON-encoded result before both payload shaping and the later MCP
// result door. The latter is much smaller than the shared 30k payload ceiling;
// the result door must preserve paging truth when its own projection clips a page.

// The handler body is serialized again as an MCP content item. Reserve room for
// that wire envelope so tools:invoke's outer result door cannot force-project a
// complete evidence page down to its generic string limit while leaving
// evidenceRead.complete unchanged.
const RESULT_DOOR_SERIALIZATION_RESERVE_CHARS = 256;

function inlineResultBudgetChars(ownerId?: string | null): number {
  const resultDoorChars =
    computeTurnDoors(0, getDoorConstantsSync(ownerId)).resultEach * CHARS_PER_TOKEN_ESTIMATE;
  return Math.max(
    1,
    Math.min(
      Math.floor(PAYLOAD_TIER_HARD_CEILING_CHARS / 2),
      resultDoorChars - RESULT_DOOR_SERIALIZATION_RESERVE_CHARS,
    ),
  );
}

const evidenceReadCall = (issueId: string, criterionKey: string, evidenceOffset = 0) => ({
  tool: 'scorecards:get',
  args: { issueId, criterionKey, evidenceOffset },
});

const criterionIndexReadCall = (issueId: string, indexOffset: number) => ({
  tool: 'scorecards:get',
  args: { issueId, indexOffset },
});

const evidenceReadCallSchema = z.object({
  tool: z.literal('scorecards:get'),
  args: z.object({
    issueId: z.string(),
    criterionKey: z.string().optional(),
    evidenceOffset: z.number().int().nonnegative().optional(),
    indexOffset: z.number().int().nonnegative().optional(),
  }).passthrough().refine(({ criterionKey, indexOffset }) =>
    (criterionKey !== undefined) !== (indexOffset !== undefined)),
}).passthrough();

const scorecardEvidenceCriterionSchema = z.object({
  key: z.string(),
  rating: z.string(),
  evidence: z.string(),
  evidenceRef: z.string().optional(),
  evidenceKind: z.string().optional(),
  positiveControlRef: z.string().optional(),
  absenceClaim: z.boolean().optional(),
  unknownReason: z.enum(OBSERVATION_UNKNOWN_REASONS).optional(),
  attribution: z.enum(OBSERVATION_ATTRIBUTIONS).optional(),
  nextEvidenceAction: z.string().optional(),
  suggestion: z.string().optional(),
  remediation: z.string().optional(),
  disregard: z.string().optional(),
}).passthrough();

const scorecardSubjectRubricCurrentnessSchema = z.object({
  state: z.enum(['current', 'stale', 'unknown']),
  reason: z.enum([
    'current',
    'meaning-unchanged',
    'subject-rubric-mismatch',
    'recorded-identity-missing',
    'live-identity-missing',
    'revision-mismatch',
    'meaning-revision-mismatch',
    'criteria-hash-mismatch',
  ]),
  recordedRevision: z.number().nullable(),
  currentRevision: z.number().nullable(),
  recordedCriteriaHash: z.string().nullable(),
  currentCriteriaHash: z.string().nullable(),
}).passthrough();

const scorecardRubricCurrentnessSchema = z.object({
  state: z.enum(['current', 'stale', 'unknown']),
  reason: z.enum([
    'current',
    'recorded-identity-missing',
    'live-identity-missing',
    'revision-mismatch',
    'meaning-revision-mismatch',
    'criteria-hash-mismatch',
  ]),
  recordedRevision: z.number().nullable(),
  currentRevision: z.number().nullable(),
  recordedCriteriaHash: z.string().nullable(),
  currentCriteriaHash: z.string().nullable(),
}).passthrough();

const scorecardEvidenceSchema = z.object({
  issueId: z.string(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  rubricRef: z.string(),
  rubricRevision: z.number().optional(),
  rubricMeaningRevision: z.number().optional(),
  criteriaHash: z.string().optional(),
  rerunRecipe: z.record(z.string(), z.unknown()).optional(),
  rubricCurrentness: scorecardRubricCurrentnessSchema,
  evidenceFingerprint: z.string().optional(),
  sourceHive: z.string().optional(),
  subject: z.object({
    kind: z.enum(['agent-run', 'session', 'work-item', 'plan', 'pot', 'rubric', 'scorecard']).optional(),
    ref: z.string(),
    windowStart: z.string().optional(),
    windowEnd: z.string().optional(),
  }).passthrough().optional(),
  criteria: z.array(scorecardEvidenceCriterionSchema),
  rollup: z.object({
    verdict: z.enum(['exemplary', 'pass', 'partial', 'fail', 'severe', 'unassessable']),
    criticalKeys: z.array(z.string()),
    criticalFailures: z.array(z.string()),
    criticalUnknowns: z.array(z.string()),
    coverage: z.object({
      rated: z.number(),
      required: z.number(),
      sufficient: z.boolean(),
    }).passthrough(),
  }).passthrough().optional(),
  nKeys: z.number().int().nonnegative(),
  missingKeys: z.array(z.string()),
  extraKeys: z.array(z.string()),
  rubricResolved: z.boolean(),
  synthesized: z.boolean(),
  gradingAudit: z.object({
    state: z.enum(['pending', 'awaiting-reemit', 'passed', 'failed', 'cancelled']),
    metaRubricRef: z.string(),
    stampedAt: z.string(),
    rubricRevision: z.number().optional(),
    criteriaHash: z.string().optional(),
    dispatchReservation: z.object({
      key: z.string(),
      reservedAt: z.string(),
    }).passthrough().optional(),
    reemitRequired: z.object({
      code: z.literal('grading_audit_evaluator_changed'),
      at: z.string(),
      reason: z.string(),
    }).passthrough().optional(),
    auditIssueId: z.string().optional(),
    auditor: z.string().optional(),
    auditedAt: z.string().optional(),
  }).passthrough().optional(),
  provisional: z.object({
    violatableKeys: z.array(z.string()),
    stampedAt: z.string(),
  }).passthrough().optional(),
  retracted: z.object({
    at: z.string(),
    by: z.string(),
    reason: z.string(),
  }).passthrough().optional(),
  subjectRubricCurrentness: scorecardSubjectRubricCurrentnessSchema.optional(),
  supersededBy: z.string().optional(),
  auditTarget: z.object({
    current: z.boolean(),
    superseded: z.boolean(),
    supersededBy: z.string().nullable(),
    retracted: z.boolean(),
    subjectRubricCurrentness: scorecardSubjectRubricCurrentnessSchema.nullable(),
  }).passthrough(),
}).passthrough();

const scorecardEvidenceReadSchema = z.object({
  complete: z.boolean(),
  reason: z.string().optional(),
  instruction: z.string().optional(),
  criteria: z.array(z.object({
    key: z.string(),
    rating: z.string(),
    evidenceChars: z.number().int().nonnegative(),
    read: evidenceReadCallSchema,
  }).passthrough()).optional(),
  scope: z.enum(['selected-criterion', 'criterion-index']).optional(),
  offset: z.number().int().nonnegative().optional(),
  totalChars: z.number().int().nonnegative().optional(),
  totalCriteria: z.number().int().nonnegative().optional(),
  next: evidenceReadCallSchema.optional(),
}).passthrough();

const scorecardGetResultSchema = z.object({
  ok: z.boolean(),
  scorecard: scorecardEvidenceSchema.optional(),
  evidenceRead: scorecardEvidenceReadSchema.optional(),
  error: z.string().optional(),
  retryable: z.boolean().optional(),
  pgCode: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

function boundedEvidenceRead(
  scorecard: ScorecardEvidenceRow,
  args: z.infer<typeof scorecardGetArgs>,
  issueId: string,
  inlineBudgetChars: number,
) {
  if (args.criterionKey === undefined) {
    if (args.evidenceOffset !== undefined) {
      return { ok: false as const, error: 'criterion_required_for_offset' };
    }
    const full = { ok: true as const, scorecard, evidenceRead: { complete: true } };
    if (args.indexOffset === undefined && JSON.stringify(full).length <= inlineBudgetChars) return full;

    const indexOffset = args.indexOffset ?? 0;
    if (indexOffset > scorecard.criteria.length || (indexOffset === scorecard.criteria.length && indexOffset > 0)) {
      return { ok: false as const, error: 'invalid_criterion_index_offset' };
    }
    const metadata = { ...scorecard, criteria: [] };
    const page = (count: number) => {
      const endOffset = indexOffset + count;
      const completeIndex = endOffset === scorecard.criteria.length;
      return {
        ok: true as const,
        scorecard: metadata,
        evidenceRead: {
          complete: false,
          reason: args.indexOffset === undefined ? 'card-exceeds-inline-budget' : 'criterion-index-page',
          instruction: 'Evidence has NOT been read. For a criterion-index page, follow evidenceRead.next until the full index is assembled; then read every indexed criterion and concatenate its pages before grading.',
          criteria: scorecard.criteria.slice(indexOffset, endOffset).map(({ key, rating, evidence }) => ({
            key, rating, evidenceChars: evidence.length,
            read: evidenceReadCall(issueId, key),
          })),
          scope: 'criterion-index' as const,
          offset: indexOffset,
          totalCriteria: scorecard.criteria.length,
          ...(!completeIndex ? { next: criterionIndexReadCall(issueId, endOffset) } : {}),
        },
      };
    };
    let count = scorecard.criteria.length - indexOffset;
    let index = page(count);
    while (JSON.stringify(index).length > inlineBudgetChars && count > 1) {
      count = Math.max(1, Math.floor(count / 2));
      index = page(count);
    }
    if (JSON.stringify(index).length > inlineBudgetChars) {
      return {
        ok: false as const,
        error: 'scorecard_metadata_exceeds_inline_budget',
        message: 'Scorecard metadata and one criterion index entry exceed the inline budget.',
      };
    }
    return index;
  }
  const criterion = scorecard.criteria.find(({ key }) => key === args.criterionKey);
  if (!criterion) return { ok: false as const, error: 'unknown_criterion' };
  const offset = args.evidenceOffset ?? 0;
  if (offset > criterion.evidence.length || (offset === criterion.evidence.length && offset !== 0)) {
    return { ok: false as const, error: 'invalid_evidence_offset' };
  }
  let count = Math.min(inlineBudgetChars, criterion.evidence.length - offset);
  const page = () => {
    const nextOffset = offset + count;
    const complete = nextOffset === criterion.evidence.length;
    return {
      ok: true as const,
      scorecard: { ...scorecard, criteria: [{ ...criterion, evidence: criterion.evidence.slice(offset, nextOffset) }] },
      evidenceRead: {
        complete,
        scope: 'selected-criterion',
        offset,
        totalChars: criterion.evidence.length,
        instruction: 'Concatenate this criterion’s pages in offset order. Complete applies only to this criterion; audit every key from the card index.',
        ...(!complete ? { next: evidenceReadCall(issueId, criterion.key, nextOffset) } : {}),
      },
    };
  };
  let result = page();
  while (JSON.stringify(result).length > inlineBudgetChars && count > 1) {
    count = Math.max(1, Math.floor(count / 2));
    result = page();
  }
  if (JSON.stringify(result).length > inlineBudgetChars) {
    return { ok: false as const, error: 'scorecard_metadata_exceeds_inline_budget' };
  }
  return result;
}

export default defineTool({
  name: 'scorecards:get',
  profile: 'engineer',
  description:
    'Read ONE rubric scorecard by issue id using an evidence-first projection. Pass issueId (preferred) or id (compatibility alias); issueId wins. Stored evidenceFingerprint identifies the evidence scope. A validated rerunRecipe is included when present, including on criterion-index and criterion pages. Small cards return exact criterion evidence. Oversized cards return evidenceRead.complete:false and a criterion index; when the index is paged, follow evidenceRead.next until scope is no longer criterion-index. Then read each criterion and concatenate its pages before grading. Never interpret an index or incomplete page as missing evidence. criterionKey narrows the existing read; indexOffset resumes an index page; evidenceOffset resumes a criterion page. History-only payload is omitted.',
  guidance: {
    when: 'You are auditing one existing scorecard and must re-run the probe stated in every criterion evidence string. Pass the scorecard issueId returned by scorecards:list or a grading-audit dispatch reservation; generic id-based callers may use id as a compatibility alias.',
    notWhen:
      'You want scorecard history, trend inputs, or multiple rows — scorecards:list. You want a rubric definition — rubrics:get. You are filing a scorecard — scorecards:emit.',
    chaining:
      'Page evidenceRead.next until the criterion index is complete, then fetch each criterion’s evidence pages in small Promise.all groups; read one criterion’s pages sequentially. Resolve papercusp.output-envelope/v1 envelopes with capability:read before reading scorecard.criteria. Concatenate complete pages, rerun probes, then emit the grading-integrity audit.',
    returns:
      'Returns `{ ok, scorecard, evidenceRead }`. The scorecard includes `evidenceFingerprint` when recorded and `rerunRecipe` when a valid recipe was stored. Full reads contain every exact criterion; an oversized read contains criteria:[] plus a complete or paged criterion index, not absent evidence. Index pages preserve scorecard metadata and report offset/totalCriteria/next; criterion pages retain full-card identity and nKeys/missingKeys and report offset/totalChars/next. Concatenate all index and evidence pages before grading.',
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
  result: scorecardGetResultSchema,
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    return runWithWorkspaceIfConcrete(identity.workspaceId ?? undefined, async () => {
      try {
        const issueId = args.issueId ?? args.id;
        if (!issueId) {
          return { data: { ok: false as const, error: 'issueId or id is required' } };
        }
        const result = await readScorecardEvidence(issueId);
        if (result.kind === 'not_found') {
          return { data: { ok: false as const, error: `scorecard '${issueId}' not found` } };
        }
        if (result.kind === 'not_scorecard') {
          return { data: { ok: false as const, error: `'${issueId}' is not a scorecard` } };
        }
        return { data: boundedEvidenceRead(result.scorecard, args, issueId, inlineResultBudgetChars(identity.ownerId)) };
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
