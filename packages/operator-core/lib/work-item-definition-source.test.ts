import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OwnerDirectiveRow } from './owner-directives';
import {
  formatWorkDefinitionApproval, isVerifiedWorkDefinitionApproval, verifyWorkDefinitionApproval,
  workDefinitionFingerprint, type WorkDefinitionApprovalSource, type WorkDefinitionApprovalStatement,
  formatWorkDefinitionProposal, formatWorkDefinitionProposalSelection,
} from './work-item-definition-source';
import type { ReportRecord } from './report-library';

const clock = '2026-11-02T00:00:00Z';
const target = { workspaceId: 'workspace', harnessSlug: 'papercusp', workItemId: 'WI-assessment' };
const definition = { acceptanceCriteria: ['Measure the requested fleet criteria', 'Preserve the historical window'],
  scope: { inScope: ['The explicitly approved assessment'], outOfScope: [] } };
const assessment = { rubricRef: 'fleet-rubric', rubricRevision: 3, criteriaHash: 'a'.repeat(64),
  subject: { kind: 'pot' as const, ref: 'fleet:luna-max-coverage-fixture',
    windowStart: '2026-11-01T00:00:00Z', windowEnd: clock }, criterionKeys: ['criterion-1'] };
function fixture() {
  const previousDefinition = { acceptanceCriteria: ['Assess the entire fleet'] };
  const statement: WorkDefinitionApprovalStatement = { schema: 'work-definition-approval-v1', target,
    previousDefinitionHash: workDefinitionFingerprint(previousDefinition), definition, assessment };
  const body = formatWorkDefinitionApproval(statement);
  const directive: OwnerDirectiveRow = { id: 42, workspaceId: target.workspaceId, ownerId: 'human',
    recordedBy: 'su-worker', capturedByHook: true, sourceTurnRef: 'session_turn:codex:original:6',
    sessionRef: 'original', verbatimText: body, createdAtMs: Date.parse('2026-11-01T12:00:00Z'),
    dispositionedAtMs: null, dispositionStatus: null, dispositionNote: null, dispositionedBy: null };
  const source: WorkDefinitionApprovalSource = { directiveId: 42, principalId: directive.ownerId,
    sourceTurnRef: directive.sourceTurnRef!, bodySha256: createHash('sha256').update(body).digest('hex') };
  return structuredClone({ target, definition, assessment, source, directive,
    rubric: { rubricId: assessment.rubricRef, revision: assessment.rubricRevision,
      criteriaHash: assessment.criteriaHash, criteria: Array.from({ length: 26 }, (_, i) => ({ key: `criterion-${i + 1}` })) },
    comparisonTime: clock, operation: 'admission' as const, previousDefinition });
}

describe('complete owner-source work-definition approval (D-008)', () => {
  it('verifies an explicit bounded definition against the complete captured source, not its author session', () => {
    const input = fixture();
    const result = verifyWorkDefinitionApproval(input);
    expect(result).toMatchObject({ kind: 'verified', target, definition, assessment,
      source: input.source, previousDefinitionHash: workDefinitionFingerprint(input.previousDefinition) });
    expect(isVerifiedWorkDefinitionApproval(result)).toBe(true);
    // This is authority for one exact scope, not evidence that its measurement or completion passed.
    expect(result).not.toHaveProperty('fulfillment');
    expect(result).not.toHaveProperty('gradingAudit');
  });

  it.each(['missing', 'agent-copy', 'workspace', 'principal', 'turn', 'session', 'other-session', 'malformed-turn', 'id', 'withdrawn', 'future'])(
    'refuses %s source authority', kind => {
      const input = fixture();
      if (kind === 'missing') return expect(verifyWorkDefinitionApproval({ ...input, directive: null }).kind).toBe('unknown');
      if (kind === 'agent-copy') input.directive.capturedByHook = false;
      if (kind === 'workspace') input.directive.workspaceId = 'elsewhere';
      if (kind === 'principal') input.directive.ownerId = 'another-human';
      if (kind === 'turn') input.directive.sourceTurnRef = 'session_turn:codex:copy:6';
      if (kind === 'session') input.directive.sessionRef = null;
      if (kind === 'other-session') input.directive.sessionRef = 'another-source-session';
      if (kind === 'malformed-turn') input.directive.sourceTurnRef = input.source.sourceTurnRef = 'not-a-source-turn';
      if (kind === 'id') input.directive.id++;
      if (kind === 'withdrawn') input.directive.dispositionStatus = 'declined';
      if (kind === 'future') input.directive.createdAtMs = Date.parse('2026-11-03T00:00:00Z');
      expect(verifyWorkDefinitionApproval(input).kind).toBe('unknown');
    },
  );

  it.each(['hidden-refusal', 'duplicate-key', 'extra-property', 'fragment', 'renormalized-definition'])(
    'rejects %s even when the caller recomputes the body hash', kind => {
      const input = fixture();
      if (kind === 'hidden-refusal') input.directive.verbatimText += '\nDo not approve this scope.';
      if (kind === 'duplicate-key') input.directive.verbatimText = input.directive.verbatimText.replace(
        '"criterionKeys":["criterion-1"]', '"criterionKeys":["criterion-2"],"criterionKeys":["criterion-1"]');
      if (kind === 'extra-property') input.directive.verbatimText = input.directive.verbatimText.replace(
        '"schema":', '"refusal":"Do not approve","schema":');
      if (kind === 'fragment') input.directive.verbatimText = JSON.stringify({ assessment });
      if (kind === 'renormalized-definition') input.directive.verbatimText = input.directive.verbatimText.replace(
        'Measure the requested fleet criteria', ' Measure the requested fleet criteria ');
      input.source.bodySha256 = createHash('sha256').update(input.directive.verbatimText).digest('hex');
      expect(verifyWorkDefinitionApproval(input).kind).toBe('unknown');
    },
  );

  it.each(['item', 'harness', 'definition', 'scope', 'rubric', 'revision', 'hash', 'subject', 'window', 'expansion', 'contraction'])(
    'refuses %s movement relative to the approved full statement', kind => {
      const input = fixture();
      if (kind === 'item') input.target.workItemId = 'WI-another';
      if (kind === 'harness') input.target.harnessSlug = 'another';
      if (kind === 'definition') input.definition.acceptanceCriteria.pop();
      if (kind === 'scope') input.definition.scope.inScope.push('Additional work');
      if (kind === 'rubric') input.assessment.rubricRef = 'another-rubric';
      if (kind === 'revision') input.assessment.rubricRevision++;
      if (kind === 'hash') input.assessment.criteriaHash = 'b'.repeat(64);
      if (kind === 'subject') input.assessment.subject.ref = 'fleet:another';
      if (kind === 'window') input.assessment.subject.windowStart = '2026-10-31T00:00:00Z';
      if (kind === 'expansion') input.assessment.criterionKeys.push('criterion-2');
      if (kind === 'contraction') input.assessment.criterionKeys = [];
      expect(verifyWorkDefinitionApproval(input).kind).toBe('unknown');
    },
  );

  it.each(['missing', 'revision', 'hash', 'removed-key', 'duplicate-key'])(
    'refuses a %s live rubric independently of matching source text', kind => {
      const input = fixture();
      if (kind === 'missing') return expect(verifyWorkDefinitionApproval({ ...input, rubric: null }).kind).toBe('unknown');
      if (kind === 'revision') input.rubric.revision++;
      if (kind === 'hash') input.rubric.criteriaHash = 'b'.repeat(64);
      if (kind === 'removed-key') input.rubric.criteria.shift();
      if (kind === 'duplicate-key') input.rubric.criteria.push({ key: 'criterion-1' });
      expect(verifyWorkDefinitionApproval(input).kind).toBe('unknown');
    },
  );

  it('rejects replay after the prior definition changes, while an unchanged CAS baseline verifies', () => {
    const input = fixture();
    expect(verifyWorkDefinitionApproval(input).kind).toBe('verified');
    input.previousDefinition.acceptanceCriteria.push('A later requirement');
    expect(verifyWorkDefinitionApproval(input)).toEqual({ kind: 'unknown', reason: 'approval_previous_definition_mismatch' });
  });

  it('uses the same complete-source check on read, without inventing a prior definition', () => {
    const { previousDefinition: _, ...input } = fixture();
    expect(verifyWorkDefinitionApproval({ ...input, operation: 'read' }).kind).toBe('verified');
    input.directive.capturedByHook = false;
    expect(verifyWorkDefinitionApproval({ ...input, operation: 'read' }).kind).toBe('unknown');
  });

  it('does not grant assessment scope from a definition with no declared acceptance criteria', () => {
    const input = fixture();
    expect(verifyWorkDefinitionApproval({ ...input, definition: { firstUnit: 'Save the report' } }))
      .toEqual({ kind: 'unknown', reason: 'approval_criteria_missing' });
  });

  it('does not let a serialized or subsequently mutated receipt become authority', () => {
    const input = fixture();
    const result = verifyWorkDefinitionApproval(input);
    if (result.kind !== 'verified') throw new Error('source fixture did not verify');
    expect(isVerifiedWorkDefinitionApproval(JSON.parse(JSON.stringify(result)))).toBe(false);
    expect(Object.isFrozen(result.assessment.criterionKeys)).toBe(true);
    expect(Object.isFrozen(result.definition.acceptanceCriteria)).toBe(true);
    input.assessment.criterionKeys.push('criterion-2');
    input.definition.acceptanceCriteria.pop();
    expect(result.assessment.criterionKeys).toEqual(['criterion-1']);
    expect(result.definition.acceptanceCriteria).toEqual(definition.acceptanceCriteria);
  });
});

describe('immutable readable proposal selection (D-009)', () => {
  function proposed() {
    const input = fixture();
    const statement = JSON.parse(input.directive.verbatimText) as WorkDefinitionApprovalStatement;
    const bodyMd = formatWorkDefinitionProposal(statement);
    const proposal = { reportId: 'rpt_scope-proposal', bodySha256: createHash('sha256').update(bodyMd).digest('hex') };
    const source = { ...input.source, proposal };
    const selection = formatWorkDefinitionProposalSelection({ target, proposal });
    const proposalReport: ReportRecord = { workspaceId: target.workspaceId, reportId: proposal.reportId,
      title: 'Assessment mapping', summary: '', bodyMd, bodySha256: proposal.bodySha256, goalOwnerReport: null,
      kind: 'proposal', subject: { kind: 'work_item', ref: target.workItemId, label: null },
      origin: { harnessSlug: target.harnessSlug, authorOwnerId: 'su-worker', authorSessionRef: 'draft' },
      visibility: 'workspace', supersedesReportId: null, lineageId: proposal.reportId, source: 'agent', tags: [],
      publishedAt: '2026-11-01T11:00:00Z', updatedAt: '2026-11-01T11:00:00Z', retiredAt: null };
    return { ...input, source, proposalReport,
      directive: { ...input.directive, verbatimText: selection }, statement };
  }
  function rehash(input: ReturnType<typeof proposed>) {
    input.source.bodySha256 = createHash('sha256').update(input.directive.verbatimText).digest('hex');
    input.proposalReport.bodySha256 = createHash('sha256').update(input.proposalReport.bodyMd).digest('hex');
    if (input.source.proposal) input.source.proposal.bodySha256 = input.proposalReport.bodySha256;
  }
  function valid() { const input = proposed(); rehash(input); return input; }

  it('retains every definition field and tuple in one reproducible readable body and verifies exact selection', () => {
    const input = valid();
    expect(input.proposalReport.bodyMd).toContain('## Acceptance criteria');
    expect(input.proposalReport.bodyMd).toContain('## Required rubric keys');
    expect(input.proposalReport.bodyMd).toContain(formatWorkDefinitionApproval(input.statement));
    for (const operation of ['read', 'admission'] as const)
      expect(verifyWorkDefinitionApproval({ ...input, operation })).toMatchObject({ kind: 'verified',
        definition, assessment, source: input.source });
  });

  it.each(['missing', 'report-id', 'workspace', 'item', 'harness', 'kind', 'private', 'retired', 'future', 'invalid-time', 'body-hash'])(
    'refuses %s proposal evidence independently of a valid captured selection', kind => {
      const input = valid();
      if (kind === 'missing') return expect(verifyWorkDefinitionApproval({ ...input, proposalReport: null }).kind).toBe('unknown');
      if (kind === 'report-id') input.proposalReport.reportId = 'rpt_other';
      if (kind === 'workspace') input.proposalReport.workspaceId = 'other';
      if (kind === 'item') input.proposalReport.subject.ref = 'WI-other';
      if (kind === 'harness') input.proposalReport.origin.harnessSlug = 'other';
      if (kind === 'kind') input.proposalReport.kind = 'status-digest';
      if (kind === 'private') input.proposalReport.visibility = 'owner';
      if (kind === 'retired') input.proposalReport.retiredAt = clock;
      if (kind === 'future') input.proposalReport.publishedAt = '2026-11-01T13:00:00Z';
      if (kind === 'invalid-time') input.proposalReport.publishedAt = 'invalid';
      if (kind === 'body-hash') input.proposalReport.bodyMd += 'Hidden changed body';
      expect(verifyWorkDefinitionApproval(input).kind).toBe('unknown');
    },
  );

  it.each(['hidden-refusal', 'whitespace', 'other-report', 'other-hash', 'other-target', 'json-approval', 'missing-reference', 'agent', 'principal', 'withdrawn'])(
    'refuses %s selection instead of interpreting an excerpt as approval', kind => {
      const input = valid();
      if (kind === 'hidden-refusal') input.directive.verbatimText += '\nDo not approve this mapping.';
      if (kind === 'whitespace') input.directive.verbatimText += '\n';
      if (kind === 'other-report') input.directive.verbatimText = input.directive.verbatimText.replace('rpt_scope-proposal', 'rpt_other');
      if (kind === 'other-hash') input.directive.verbatimText = input.directive.verbatimText.replace(input.source.proposal.bodySha256, 'b'.repeat(64));
      if (kind === 'other-target') input.directive.verbatimText = input.directive.verbatimText.replace('WI-assessment', 'WI-other');
      if (kind === 'json-approval') input.directive.verbatimText = formatWorkDefinitionApproval(input.statement);
      if (kind === 'missing-reference') delete (input.source as WorkDefinitionApprovalSource).proposal;
      if (kind === 'agent') input.directive.capturedByHook = false;
      if (kind === 'principal') input.source.principalId = 'another-human';
      if (kind === 'withdrawn') input.directive.dispositionStatus = 'declined';
      rehash(input);
      expect(verifyWorkDefinitionApproval(input).kind).toBe('unknown');
    },
  );

  it.each(['hidden-report-text', 'prose-payload-disagreement', 'definition', 'prior-hash', 'rubric', 'revision', 'criteria-hash', 'subject', 'window', 'key-expansion'])(
    'refuses %s even when a new body hash and exact selection are supplied', kind => {
      const input = valid();
      if (kind === 'hidden-report-text') input.proposalReport.bodyMd += '\nAdditional scope omitted above.\n';
      if (kind === 'prose-payload-disagreement') input.proposalReport.bodyMd = input.proposalReport.bodyMd.replace('## Required rubric keys', '## Optional rubric keys');
      if (kind === 'definition') input.statement.definition.acceptanceCriteria!.pop();
      if (kind === 'prior-hash') input.statement.previousDefinitionHash = 'b'.repeat(64);
      if (kind === 'rubric') input.statement.assessment.rubricRef = 'another-rubric';
      if (kind === 'revision') input.statement.assessment.rubricRevision++;
      if (kind === 'criteria-hash') input.statement.assessment.criteriaHash = 'b'.repeat(64);
      if (kind === 'subject') input.statement.assessment.subject.ref = 'another-fleet';
      if (kind === 'window') input.statement.assessment.subject.windowStart = '2026-10-31T00:00:00Z';
      if (kind === 'key-expansion') input.statement.assessment.criterionKeys.push('criterion-2');
      if (!['hidden-report-text', 'prose-payload-disagreement'].includes(kind))
        input.proposalReport.bodyMd = formatWorkDefinitionProposal(input.statement);
      rehash(input);
      input.directive.verbatimText = formatWorkDefinitionProposalSelection({ target, proposal: input.source.proposal });
      rehash(input);
      expect(verifyWorkDefinitionApproval(input).kind).toBe('unknown');
    },
  );
});
