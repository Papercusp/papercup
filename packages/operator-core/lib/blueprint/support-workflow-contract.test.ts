import { describe, expect, it } from 'vitest';
import {
  assertApprovedSupportWorkflow,
  assertSupportCaseInput,
  parseSupportToEngineeringResult,
  type ApprovedSupportWorkflow,
} from './support-workflow-contract';

const workflow: ApprovedSupportWorkflow = {
  harnessSlug: 'papercusp', operationId: 'support-to-engineering', approvedRevision: 'a'.repeat(64),
  accountableOwner: 'employee-owner', reviewerPrincipals: ['reviewer-a', 'reviewer-b'],
  allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000,
};
const id = '00000000-0000-4000-8000-000000000001';

describe('P-012b support workflow contract', () => {
  it('requires an accountable owner, distinct reviewer and finite maximum', () => {
    expect(() => assertApprovedSupportWorkflow({ ...workflow, reviewerPrincipals: ['reviewer-a', 'reviewer-a'] })).toThrow(/distinct/);
    expect(() => assertApprovedSupportWorkflow({ ...workflow, maximumCostMicros: 0 })).toThrow(/malformed/);
  });

  it('pins the employee selection to the displayed approved revision and allowed action', () => {
    const input = assertSupportCaseInput(workflow, {
      supportCaseId: 'case-1', approvedRevision: workflow.approvedRevision,
      documentIds: [id], query: 'cobalt roadmap', requestedAction: 'prepare-handoff',
    });
    expect(input.documentIds).toEqual([id]);
    expect(() => assertSupportCaseInput(workflow, { ...input, approvedRevision: 'b'.repeat(64) })).toThrow(/outside/);
    expect(() => assertSupportCaseInput(workflow, { ...input, requestedAction: 'publish' })).toThrow(/outside/);
  });

  it('rejects malformed or widened evidence and parses only the selected case', () => {
    expect(() => assertSupportCaseInput(workflow, {
      supportCaseId: 'case-1', approvedRevision: workflow.approvedRevision,
      documentIds: ['not-a-uuid'], query: 'x', requestedAction: 'prepare-handoff',
    })).toThrow(/canonical/);
    const parsed = parseSupportToEngineeringResult({
      supportCaseId: 'case-1', summary: 'A bounded summary', reproduction: ['step'], checklist: ['check'],
      suggestedRole: 'engineer', citations: [{ id, source: 'slack', externalId: null }],
    }, { supportCaseId: 'case-1', documentIds: [id] });
    expect(parsed.supportCaseId).toBe('case-1');
    expect(() => parseSupportToEngineeringResult({ supportCaseId: 'case-2' },
      { supportCaseId: 'case-1', documentIds: [id] })).toThrow(/contract/);
    expect(() => parseSupportToEngineeringResult(parsed,
      { supportCaseId: 'case-1', documentIds: [] })).toThrow(/evidence/);
  });
});
