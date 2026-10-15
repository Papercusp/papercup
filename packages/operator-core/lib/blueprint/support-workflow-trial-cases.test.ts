import { describe, expect, it } from 'vitest';
import { checkAgainstJsonSchema } from '../json-schema-validation';
import { assertSupportCaseInput, parseSupportToEngineeringResult } from './support-workflow-contract';
import { supportToEngineeringOperation, supportWorkflowFromOperation } from './support-workflow-operation';
import { supportWorkflowTrialCases } from './fixtures/support-workflow-trial-cases';

const revision = 'a'.repeat(64);
const operation = supportToEngineeringOperation({
  id: 'synthetic-support-trial', version: '1', role: 'worker',
  identity: { kind: 'identity', ref: 'trial-worker', revision: '1', contentHash: 'b'.repeat(64) },
  accountableOwner: 'trial-admin', reviewerPrincipals: ['trial-reviewer'],
  allowedSources: ['slack'], allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000,
});
const workflow = supportWorkflowFromOperation(operation, 'papercusp', revision)!;
const cases = supportWorkflowTrialCases(revision);

describe('P-015 labelled synthetic support trial inputs', () => {
  it('provides 30 distinct comparable cases with disjoint permitted and denied documents', () => {
    expect(cases).toHaveLength(30);
    expect(new Set(cases.map((item) => item.input.supportCaseId)).size).toBe(30);
    expect(new Set(cases.map((item) => item.title)).size).toBe(30);
    expect(new Set(cases.map((item) => item.reviewerOnlyOracle.trigger)).size).toBe(30);
    const ids = cases.flatMap((item) => [...item.documents, item.deniedDocument].map(({ id }) => id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of cases) {
      expect(item.provenance).toBe('synthetic');
      expect(item.resultLabel).toBe('internal-simulation');
      expect(item.input.documentIds).toEqual(item.documents.map(({ id }) => id));
      expect(item.input.documentIds).not.toContain(item.deniedDocument.id);
      expect(JSON.stringify(item.documents)).not.toContain(item.deniedDocument.snippet);
    }
  });

  it.each(cases)('$input.supportCaseId uses the existing approved input and private schemas', (item) => {
    expect(assertSupportCaseInput(workflow, item.input)).toEqual(item.input);
    expect(checkAgainstJsonSchema(operation.inputSchema, item.input).ok).toBe(true);
    expect(checkAgainstJsonSchema(operation.privateInputSchema!, {
      supportCaseId: item.input.supportCaseId, documents: item.documents,
    }).ok).toBe(true);
    expect(() => assertSupportCaseInput(workflow, { ...item.input, approvedRevision: 'c'.repeat(64) })).toThrow(/outside/);
    expect(() => assertSupportCaseInput(workflow, { ...item.input, requestedAction: 'publish' })).toThrow(/outside/);
  });

  it.each(cases)('$input.supportCaseId rejects restricted or foreign-case citations', (item) => {
    // This is a fabricated contract control, never a model result or trial outcome.
    const result = { supportCaseId: item.input.supportCaseId, summary: item.title,
      reproduction: [item.reviewerOnlyOracle.trigger], checklist: [item.reviewerOnlyOracle.expected],
      suggestedRole: item.reviewerOnlyOracle.suggestedRole,
      citations: item.documents.map(({ id, source, externalId }) => ({ id, source, externalId })),
    };
    expect(parseSupportToEngineeringResult(result, item.input, item.documents).supportCaseId)
      .toBe(item.input.supportCaseId);
    const foreignCase = cases.find((other) => other.input.supportCaseId !== item.input.supportCaseId)!;
    for (const invalid of [item.deniedDocument, foreignCase.documents[0]]) {
      expect(() => parseSupportToEngineeringResult({ ...result, citations: [invalid] }, item.input, item.documents))
        .toThrow(/evidence/);
    }
    expect(() => parseSupportToEngineeringResult(result, item.input, item.documents.slice(0, 1)))
      .toThrow(/complete canonical evidence/);
  });

  it('recreates inputs without inheriting decisions or mutation from a previous run', () => {
    const first = supportWorkflowTrialCases(revision);
    first[0].documents[0].snippet = 'mutated by a runner';
    expect(supportWorkflowTrialCases(revision)[0].documents[0].snippet).not.toBe('mutated by a runner');
    for (const item of cases) {
      expect(item).not.toHaveProperty('accepted');
      expect(item).not.toHaveProperty('baselineMs');
      expect(item).not.toHaveProperty('costMicros');
      expect(item).not.toHaveProperty('reviewerDecision');
    }
  });
});
