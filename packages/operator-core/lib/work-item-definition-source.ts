/** D-008 / EI-28017561467711444: complete-source verification, not a caller approval bit.
 * This leaf has no write effects. Producers must fence admission and consumers
 * must resolve the source again; a persisted copy of its result is not authority.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { canonicalJson } from './authority/authority-rpc-envelope';
import { WorkItemDefinitionFieldsSchema, WorkItemDefinitionSchema, readWorkItemDefinition,
  WorkDefinitionAssessmentSchema, WorkDefinitionApprovalSourceSchema,
  type WorkItemDefinitionFields, type WorkDefinitionAssessment, type WorkDefinitionApprovalSource,
} from './work-item-definition';
import type { OwnerDirectiveRow } from './owner-directives';
import type { ReportRecord } from './report-library';
import type { Sql } from 'postgres';
import { hasEnumeratedVerificationCoverage, type CompletionVerificationEvidence } from './coord-lifecycle/records';

export { WorkDefinitionAssessmentSchema, WorkDefinitionApprovalSourceSchema } from './work-item-definition';
export type { WorkDefinitionAssessment, WorkDefinitionApprovalSource } from './work-item-definition';

const text = z.string().trim().min(1).max(4000);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

const targetSchema = z.object({ workspaceId: text, harnessSlug: text, workItemId: text }).strict();
export type WorkDefinitionApprovalTarget = z.infer<typeof targetSchema>;

/** The entire captured statement is this canonical JSON object. No substring,
 * quoted attachment or agent-written report is interpreted as an owner choice.
 * Canonical encoding also rejects duplicate JSON keys and appended refusals. */
const statementSchema = z.object({
  schema: z.literal('work-definition-approval-v1'),
  target: targetSchema,
  previousDefinitionHash: hash.nullable(),
  definition: WorkItemDefinitionFieldsSchema,
  assessment: WorkDefinitionAssessmentSchema,
}).strict();
export type WorkDefinitionApprovalStatement = z.infer<typeof statementSchema>;

export function workDefinitionFingerprint(definition: unknown): string | null {
  return definition == null ? null : createHash('sha256').update(canonicalJson(definition)).digest('hex');
}

/** Generates proposed source text only; calling this never grants authority. */
export function formatWorkDefinitionApproval(statement: WorkDefinitionApprovalStatement): string {
  return canonicalJson(statementSchema.parse(statement));
}

/** One reproducible readable edition, with the complete typed statement retained.
 * Reports are proposals, never approval. Re-rendering the entire body below
 * rejects extra/hidden text as well as a payload that differs from the prose. */
export function formatWorkDefinitionProposal(statement: WorkDefinitionApprovalStatement): string {
  const parsed = statementSchema.parse(statement);
  const { target, definition, assessment } = parsed;
  const list = (values: readonly string[]) => values.map(value => `- ${JSON.stringify(value)}`).join('\n') || '- (none)';
  return [
    '# Assessment scope proposal',
    'Selecting this proposal approves the exact work definition and assessment below. It does not certify measurement, completion, acceptance, or shipment.',
    `Workspace: ${JSON.stringify(target.workspaceId)}\nHarness: ${JSON.stringify(target.harnessSlug)}\nWork item: ${JSON.stringify(target.workItemId)}`,
    `Prior definition SHA-256: ${parsed.previousDefinitionHash ?? '(no prior definition)'}`,
    `## Acceptance criteria\n${list(definition.acceptanceCriteria ?? [])}`,
    `## In scope\n${list(definition.scope?.inScope ?? [])}`,
    `## Out of scope\n${list(definition.scope?.outOfScope ?? [])}`,
    `Verification target: ${canonicalJson(definition.verificationTarget ?? null)}\nFirst unit: ${JSON.stringify(definition.firstUnit ?? null)}`,
    `## Assessment mapping\nRubric: ${JSON.stringify(assessment.rubricRef)}\nRevision: ${assessment.rubricRevision}\nCriteria SHA-256: ${assessment.criteriaHash}\nSubject kind: ${assessment.subject.kind}\nSubject: ${JSON.stringify(assessment.subject.ref)}\nWindow start: ${assessment.subject.windowStart}\nWindow end: ${assessment.subject.windowEnd}`,
    `## Required rubric keys\n${list(assessment.criterionKeys)}`,
    `## Complete typed statement\n\`\`\`json\n${formatWorkDefinitionApproval(parsed)}\n\`\`\``,
  ].join('\n\n') + '\n';
}

/** Complete owner statement, bound to one report edition and one exact target.
 * Callers show this text as a selection; the owner never has to retype JSON. */
export function formatWorkDefinitionProposalSelection(input: {
  target: WorkDefinitionApprovalTarget;
  proposal: NonNullable<WorkDefinitionApprovalSource['proposal']>;
}): string {
  const target = targetSchema.parse(input.target);
  const proposal = WorkDefinitionApprovalSourceSchema.shape.proposal.unwrap().parse(input.proposal);
  return `Approve assessment proposal ${proposal.reportId} (SHA-256 ${proposal.bodySha256}) for ${target.workItemId} in ${target.harnessSlug}, workspace ${target.workspaceId}.`;
}

function readProposalStatement(body: string): WorkDefinitionApprovalStatement | null {
  const marker = '## Complete typed statement\n```json\n';
  const start = body.lastIndexOf(marker);
  if (start < 0 || !body.endsWith('\n```\n')) return null;
  try {
    const statement = statementSchema.parse(JSON.parse(body.slice(start + marker.length, -5)));
    return formatWorkDefinitionProposal(statement) === body ? statement : null;
  } catch { return null; }
}

type ScopeRubric = {
  rubricId: string; revision?: number | null; criteriaHash?: string | null;
  criteria: readonly { key: string }[];
};
type ApprovalInput = {
  target: WorkDefinitionApprovalTarget;
  definition: WorkItemDefinitionFields;
  assessment: WorkDefinitionAssessment;
  source: WorkDefinitionApprovalSource;
  directive: OwnerDirectiveRow | null;
  /** Trusted resolver reads current editions only; no caller-provided approval bit. */
  proposalReport?: ReportRecord | null;
  rubric: ScopeRubric | null;
  comparisonTime: string;
} & ({ operation: 'admission'; previousDefinition: unknown } | { operation: 'read' });

interface VerifiedApproval {
  kind: 'verified';
  target: WorkDefinitionApprovalTarget;
  definition: WorkItemDefinitionFields;
  definitionHash: string;
  assessment: WorkDefinitionAssessment;
  source: WorkDefinitionApprovalSource;
  previousDefinitionHash: string | null;
  approvedAt: string;
}
const verified = new WeakSet<object>();
export type WorkDefinitionApprovalResult = VerifiedApproval | { kind: 'unknown'; reason: string };

/** Receipts are process-local and immutable. Re-parsing a stored/caller copy must
 * never turn it into the verified input of a projection or a write fence. */
export function isVerifiedWorkDefinitionApproval(value: unknown): value is VerifiedApproval {
  return value !== null && typeof value === 'object' && verified.has(value);
}

function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

/** A complete, authenticated owner statement can approve a bounded definition.
 * This verifies scope parity only. Ratings, evidence support, integrity audits,
 * fulfillment and terminal completion retain their separate canonical checks.
 * Operational read failures belong to the resolver and must stay unknown.
 */
export function verifyWorkDefinitionApproval(input: ApprovalInput): WorkDefinitionApprovalResult {
  const refuse = (reason: string): WorkDefinitionApprovalResult => ({ kind: 'unknown', reason });
  const target = targetSchema.safeParse(input.target);
  const source = WorkDefinitionApprovalSourceSchema.safeParse(input.source);
  const assessment = WorkDefinitionAssessmentSchema.safeParse(input.assessment);
  const definition = WorkItemDefinitionFieldsSchema.safeParse(input.definition);
  if (!target.success || !source.success || !assessment.success || !definition.success)
    return refuse('approval_input_invalid');
  // Normalization is not permission to hide part of the persisted definition.
  if (!isDeepStrictEqual(definition.data, input.definition)
    || !isDeepStrictEqual(assessment.data, input.assessment)
    || !isDeepStrictEqual(target.data, input.target)
    || !isDeepStrictEqual(source.data, input.source)) return refuse('approval_input_noncanonical');
  if (!definition.data.acceptanceCriteria?.length) return refuse('approval_criteria_missing');
  const directive = input.directive;
  if (!directive?.capturedByHook || !directive.sourceTurnRef || !directive.sessionRef
    || directive.id !== source.data.directiveId || directive.workspaceId !== target.data.workspaceId
    || directive.ownerId !== source.data.principalId || directive.sourceTurnRef !== source.data.sourceTurnRef
    || directive.sessionRef !== source.data.sourceTurnRef.split(':')[2])
    return refuse('approval_source_unverified');
  if (directive.dispositionStatus === 'declined') return refuse('approval_source_withdrawn');
  const clock = Date.parse(input.comparisonTime);
  if (!Number.isFinite(clock) || !Number.isFinite(directive.createdAtMs)
    || directive.createdAtMs > clock) return refuse('approval_source_time_unknown');
  if (createHash('sha256').update(directive.verbatimText).digest('hex') !== source.data.bodySha256)
    return refuse('approval_source_body_mismatch');
  let approved: WorkDefinitionApprovalStatement;
  if (source.data.proposal) {
    const proposal = source.data.proposal;
    const report = input.proposalReport;
    if (!report || report.reportId !== proposal.reportId || report.workspaceId !== target.data.workspaceId
      || report.subject.kind !== 'work_item' || report.subject.ref !== target.data.workItemId
      || report.origin.harnessSlug !== target.data.harnessSlug || report.kind !== 'proposal'
      || report.visibility !== 'workspace' || report.retiredAt)
      return refuse('approval_proposal_unavailable');
    if (report.bodySha256 !== proposal.bodySha256
      || createHash('sha256').update(report.bodyMd).digest('hex') !== proposal.bodySha256)
      return refuse('approval_proposal_body_mismatch');
    const publishedAt = Date.parse(report.publishedAt);
    if (!Number.isFinite(publishedAt) || publishedAt > directive.createdAtMs)
      return refuse('approval_proposal_time_unknown');
    if (directive.verbatimText !== formatWorkDefinitionProposalSelection({ target: target.data, proposal }))
      return refuse('approval_proposal_selection_mismatch');
    const statement = readProposalStatement(report.bodyMd);
    if (!statement) return refuse('approval_proposal_statement_invalid');
    approved = statement;
  } else {
    let raw: unknown;
    try { raw = JSON.parse(directive.verbatimText); }
    catch { return refuse('approval_statement_invalid'); }
    const statement = statementSchema.safeParse(raw);
    if (!statement.success || canonicalJson(statement.data) !== directive.verbatimText)
      return refuse('approval_statement_noncanonical');
    approved = statement.data;
  }
  if (!isDeepStrictEqual(approved.target, target.data)) return refuse('approval_target_mismatch');
  if (!isDeepStrictEqual(approved.definition, definition.data)) return refuse('approval_definition_mismatch');
  if (!isDeepStrictEqual(approved.assessment, assessment.data)) return refuse('approval_assessment_mismatch');
  if (input.operation === 'admission'
    && workDefinitionFingerprint(input.previousDefinition) !== approved.previousDefinitionHash)
    return refuse('approval_previous_definition_mismatch');
  const rubric = input.rubric;
  if (!rubric || rubric.rubricId !== assessment.data.rubricRef
    || rubric.revision !== assessment.data.rubricRevision || rubric.criteriaHash !== assessment.data.criteriaHash)
    return refuse('approval_rubric_identity_unknown');
  const declaredKeys = rubric.criteria.map(c => c.key);
  if (declaredKeys.length !== new Set(declaredKeys).size
    || assessment.data.criterionKeys.some(key => !declaredKeys.includes(key)))
    return refuse('approval_criterion_identity_unknown');
  const receipt = freezeJson<VerifiedApproval>({ kind: 'verified', target: target.data,
    definition: definition.data, definitionHash: workDefinitionFingerprint(definition.data)!,
    assessment: assessment.data, source: source.data, previousDefinitionHash: approved.previousDefinitionHash,
    approvedAt: new Date(directive.createdAtMs).toISOString() });
  verified.add(receipt);
  return receipt;
}

export class WorkDefinitionApprovalError extends Error {
  readonly code = 'work_definition_approval_refused';
  constructor(readonly reason: string) {
    super(`Work definition approval refused: ${reason}. No definition or completion was written.`);
  }
}

/** Use the same canonical source and rubric reader for admission, readers and
 * terminal issuance. Operational failures are unknown, never an absent approval.
 * A caller supplies a reference, not a receipt or a preverified authority bit. */
export async function resolveWorkDefinitionApproval(input: {
  target: WorkDefinitionApprovalTarget; definition: unknown;
  operation: 'read' | 'admission'; previousDefinition?: unknown;
  sql?: Sql; comparisonTime?: string;
}): Promise<WorkDefinitionApprovalResult> {
  const parsed = WorkItemDefinitionSchema.safeParse(input.definition);
  if (!parsed.success || !parsed.data.assessmentScope) return { kind: 'unknown', reason: 'approval_scope_missing' };
  const { assessmentScope, ...definition } = parsed.data;
  if (!isDeepStrictEqual(parsed.data, input.definition)) return { kind: 'unknown', reason: 'approval_input_noncanonical' };
  try {
    const [{ getOwnerDirective }, { readRubricWithoutSeeding }] = await Promise.all([
      import('./owner-directives'), import('./rubrics'),
    ]);
    const [directive, lookup] = await Promise.all([
      getOwnerDirective(assessmentScope.source.directiveId, input.sql),
      readRubricWithoutSeeding(assessmentScope.assessment.rubricRef,
        { sql: input.sql, workspaceId: input.target.workspaceId }),
    ]);
    let proposalReport: ReportRecord | null = null;
    if (assessmentScope.source.proposal) {
      const { getReport } = await import('./report-library');
      const sql = input.sql ?? (await import('@papercusp/db-org')).getOrgPg().sql;
      proposalReport = await getReport(sql, input.target.workspaceId, assessmentScope.source.proposal.reportId,
        undefined, undefined, { currentEditionOnly: true });
    }
    if (lookup.kind !== 'found') return { kind: 'unknown', reason: 'approval_rubric_identity_unknown' };
    return verifyWorkDefinitionApproval({ target: input.target, definition,
      assessment: assessmentScope.assessment, source: assessmentScope.source,
      directive, proposalReport, rubric: lookup.rubric, comparisonTime: input.comparisonTime ?? new Date().toISOString(),
      ...(input.operation === 'admission'
        ? { operation: 'admission', previousDefinition: input.previousDefinition }
        : { operation: 'read' }),
    });
  } catch {
    return { kind: 'unknown', reason: 'approval_source_unreadable' };
  }
}

/** Short final fence, inside the existing payload/state transaction. SHARE
 * locks cover rubric/class insertions as well as row changes; a row-only rubric
 * lock would miss ambiguous new slugs. No network or test execution occurs here. */
export async function fenceWorkDefinitionApproval(sql: Sql, input: {
  target: WorkDefinitionApprovalTarget; definition: unknown;
  operation: 'read' | 'admission'; previousDefinition?: unknown;
}): Promise<VerifiedApproval> {
  await sql`LOCK TABLE harness_shared.owner_directives, harness_shared.harness_plans IN SHARE MODE`;
  if (readWorkItemDefinition({ workDefinition: input.definition })?.assessmentScope?.source.proposal)
    await sql`LOCK TABLE harness_shared.report_library IN SHARE MODE`;
  const resolved = await resolveWorkDefinitionApproval({ ...input, sql });
  if (!isVerifiedWorkDefinitionApproval(resolved)) throw new WorkDefinitionApprovalError(resolved.reason);
  return resolved;
}

/** Existing generic payload writers must not clear a scope or admit one without
 * source verification, even when called below the public update handler. */
export async function fenceWorkDefinitionMutation(sql: Sql, input: {
  target: WorkDefinitionApprovalTarget; previousDefinition: unknown; nextDefinition: unknown;
}): Promise<void> {
  const hasPreviousScope = input.previousDefinition && typeof input.previousDefinition === 'object'
    && Object.hasOwn(input.previousDefinition, 'assessmentScope');
  const next = readWorkItemDefinition({ workDefinition: input.nextDefinition });
  const hasNextScope = input.nextDefinition && typeof input.nextDefinition === 'object'
    && Object.hasOwn(input.nextDefinition, 'assessmentScope');
  if (!hasPreviousScope && !hasNextScope) return;
  if (!next?.assessmentScope) throw new WorkDefinitionApprovalError('approval_scope_cannot_be_erased');
  await fenceWorkDefinitionApproval(sql, { ...input, definition: input.nextDefinition, operation: 'admission' });
}

/** Same check for validateOnly and issuance. The canonical reader resolves the
 * source again; even truthful artifact coverage cannot fulfill unknown criteria.
 * D-007 historical manual projections are excluded by that reader's independent
 * requested-scope projection. A degraded measured rating can still be fulfilled. */
export async function workDefinitionAssessmentCompletionError(input: {
  target: WorkDefinitionApprovalTarget; definition: unknown;
  evidence?: CompletionVerificationEvidence;
}): Promise<string | null> {
  const definition = readWorkItemDefinition({ workDefinition: input.definition });
  if (!definition?.assessmentScope) return input.definition && typeof input.definition === 'object'
    && Object.hasOwn(input.definition, 'assessmentScope') ? 'approval_scope_invalid' : null;
  const approval = await resolveWorkDefinitionApproval({ ...input, operation: 'read' });
  if (!isVerifiedWorkDefinitionApproval(approval)) return approval.reason;
  const coverage = input.evidence?.coverage;
  if (!hasEnumeratedVerificationCoverage(coverage) || approval.definition.acceptanceCriteria?.some(criterion =>
    !coverage!.population.includes(criterion) || !coverage!.checked?.includes(criterion)))
    return 'approval_original_criteria_unfulfilled';
  const id = input.evidence?.assessmentScorecardId;
  if (!id) return 'assessment_scorecard_required';
  try {
    const { listScorecards } = await import('./scorecards');
    const cards = await listScorecards({ issueIds: [id], finalizedOnly: true, includeGeneration: false,
      comparisonTime: approval.assessment.subject.windowEnd,
      assessmentWorkItem: { id: input.target.workItemId, harness: input.target.harnessSlug }, limit: 2 });
    const card = cards[0];
    if (cards.length !== 1 || card?.issueId !== id || card.coverage?.fulfillment !== 'fulfilled'
      || card.coverage.requestedScope.state !== 'verified' || card.rubricCurrentness?.state !== 'current'
      || card.coverage.requestedScope.definitionHash !== approval.definitionHash
      || card.coverage.requestedScope.sourceDirectiveId !== approval.source.directiveId
      || card.retracted || card.supersededBy || card.synthesized) return 'assessment_requested_scope_unfulfilled';
    return null;
  } catch {
    return 'assessment_proof_unreadable';
  }
}

/** Existing terminal writers invoke this with their row locked. Keep source,
 * rubric identity, scorecard/supersession and ledger stable until the write.
 * engineer_issues is a compatibility view over work_items: this base-table
 * read/write lock also fences retractions and new superseders through that
 * view. Serialize these writers before reading: two SHARE holders otherwise
 * deadlock when both upgrade to RowExclusive for their terminal UPDATE.
 * These rare scope-bearing closes use the bounded transaction's lock budget. */
export async function fenceWorkDefinitionCompletion(sql: Sql, input: {
  target: WorkDefinitionApprovalTarget; definition: unknown; evidence?: CompletionVerificationEvidence;
}): Promise<void> {
  if (!input.definition || typeof input.definition !== 'object'
    || !Object.hasOwn(input.definition, 'assessmentScope')) return;
  try {
    await sql`LOCK TABLE harness_shared.work_items IN SHARE ROW EXCLUSIVE MODE`;
    await sql`LOCK TABLE harness_shared.owner_directives, harness_shared.harness_plans,
      harness_shared.test_runs, harness_shared.plan_revisions,
      harness_shared.plan_spec_clauses, harness_shared.plan_spec_clause_revisions IN SHARE MODE`;
    if (readWorkItemDefinition({ workDefinition: input.definition })?.assessmentScope?.source.proposal)
      await sql`LOCK TABLE harness_shared.report_library IN SHARE MODE`;
    const error = await workDefinitionAssessmentCompletionError(input);
    if (error) throw new WorkDefinitionApprovalError(error);
  } catch (error) {
    if (error instanceof WorkDefinitionApprovalError) throw error;
    throw new WorkDefinitionApprovalError('assessment_issuance_unavailable');
  }
}
