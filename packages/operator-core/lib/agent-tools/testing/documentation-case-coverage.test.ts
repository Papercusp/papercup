import { describe, expect, it } from 'vitest';
import { createRecordedTestPopulation, parseRecordedTestPopulation,
  type RecordedPopulationCase, type RecordedPopulationIdentity } from '@papercusp/test-config/execution-details';
import { documentationCaseCoverageInputSchema, readDocumentationCaseTag, reconcileDocumentationCaseCoverage,
  type DocumentationCaseCoverageInput } from './documentation-case-coverage';

const PLAN = 'language-neutral-code-documentation-integration-2026-11-12';
const HASH = 'a'.repeat(64);
const RUN = '00000000-0000-4000-8000-000000000001';
const clone = <T>(value: T): T => structuredClone(value);
function population(cases: RecordedPopulationCase[]) {
  return createRecordedTestPopulation(cases, cases.filter(row => row.selected).map(row => row.identity))!;
}
function setPopulation(input: DocumentationCaseCoverageInput, index: number, cases: RecordedPopulationCase[]) {
  const execution = input.executions[index]!;
  execution.population = population(cases);
  execution.execution = {
    passed: cases.filter(row => row.outcome === 'passed').length,
    failed: cases.filter(row => row.outcome === 'failed').length,
    skipped: cases.filter(row => row.outcome === 'skipped').length, collectionFailed: false,
  };
}
function fixture(): DocumentationCaseCoverageInput {
  const declarations: DocumentationCaseCoverageInput['capture']['declarations'] = [];
  const causalPairs: DocumentationCaseCoverageInput['causalPairs'] = [];
  for (const testLayer of ['unit', 'integration'] as const) for (const family of ['missing-proof', 'stale-proof']) {
    const identities = (['baseline', 'falsifier'] as const).map(role => {
      const identity: RecordedPopulationIdentity = ['', 'lib/docs.' + testLayer + '.test.ts',
        '[plan:' + PLAN + '][R-12][' + role + '] ' + family + ' ' + testLayer, 1, 'test'];
      declarations.push({ identity, testLayer,
        source: { file: identity[1], contentHash: HASH, line1: declarations.length + 1, column1: 1 },
        ...(role === 'falsifier' ? { controlFamily: family } : {}) });
      return identity;
    });
    causalPairs.push({ baseline: identities[0]!, falsifier: identities[1]!, controlFamily: family,
      changedCause: family, predictedReason: family, observedReason: family });
  }
  return {
    capture: { subjectPlan: PLAN, candidateTreeFingerprint: HASH, runGroupId: RUN,
      requirements: [{ requirementId: 'R-12', layers: ['unit', 'integration'],
        controlFamilies: ['missing-proof', 'stale-proof'] }], declarations },
    executions: (['unit', 'integration'] as const).map((testLayer, index) => ({
      testRunId: index + 1, subjectPlan: PLAN, runGroupId: RUN, candidateTreeFingerprint: HASH, testLayer,
      testFile: 'lib/docs.' + testLayer + '.test.ts', projectName: null, populationCaptureStatus: 'captured',
      execution: { passed: 4, failed: 0, skipped: 0, collectionFailed: false },
      population: population(declarations.filter(row => row.testLayer === testLayer)
        .map(row => ({ identity: row.identity, selected: true, outcome: 'passed' }))),
    })), causalPairs,
  };
}

describe('documentation case coverage over the maintained recorded population', () => {
  it('reconciles the full candidate and exact one-to-one causal controls at each required layer', () => {
    const input = fixture();
    expect(documentationCaseCoverageInputSchema.parse(input)).toEqual(input);
    expect(reconcileDocumentationCaseCoverage(input)).toEqual({
      status: 'complete', reasons: [], expectedCaseCount: 8, observedCaseCount: 8, matchedCaseCount: 8,
    });
  });

  it.each([
    ['cross-plan observation', 'execution_scope_mismatch', (input: DocumentationCaseCoverageInput) => {
      input.executions[0]!.subjectPlan = 'another-plan';
    }],
    ['stale candidate', 'execution_candidate_mismatch', (input: DocumentationCaseCoverageInput) => {
      input.executions[0]!.candidateTreeFingerprint = 'b'.repeat(64);
    }],
    ['duplicate substitution', 'case_execution_duplicate', (input: DocumentationCaseCoverageInput) => {
      input.executions.push(clone(input.executions[0]!));
    }],
    ['forged population digest', 'execution_population_invalid', (input: DocumentationCaseCoverageInput) => {
      const rows = parseRecordedTestPopulation(input.executions[0]!.population)!;
      rows.populationHash = 'b'.repeat(64); input.executions[0]!.population = rows;
    }],
    ['missing observation', 'case_missing', (input: DocumentationCaseCoverageInput) => {
      const rows = parseRecordedTestPopulation(input.executions[0]!.population)!;
      setPopulation(input, 0, rows.cases.slice(1));
    }],
    ['skipped observation', 'case_not_passing', (input: DocumentationCaseCoverageInput) => {
      const rows = parseRecordedTestPopulation(input.executions[0]!.population)!;
      rows.cases[0]!.selected = false; rows.cases[0]!.outcome = 'skipped';
      setPopulation(input, 0, rows.cases);
    }],
    ['collection failure', 'execution_population_invalid', (input: DocumentationCaseCoverageInput) => {
      input.executions[0]!.execution.collectionFailed = true;
    }],
    ['unmeasured collection', 'execution_population_invalid', (input: DocumentationCaseCoverageInput) => {
      input.executions[0]!.populationCaptureStatus = 'collection-unavailable';
    }],
    ['registration-only nodes', 'execution_population_invalid', (input: DocumentationCaseCoverageInput) => {
      const rows = parseRecordedTestPopulation(input.executions[0]!.population)!;
      for (const row of rows.cases) row.identity[4] = 'suite';
      setPopulation(input, 0, rows.cases);
    }],
    ['wrong layer', 'case_layer_mismatch', (input: DocumentationCaseCoverageInput) => {
      input.executions[0]!.testLayer = 'browser';
    }],
    ['missing causal pair', 'case_unpaired', (input: DocumentationCaseCoverageInput) => {
      input.causalPairs.shift();
    }],
    ['role swap', 'causal_pair_mismatch', (input: DocumentationCaseCoverageInput) => {
      const pair = input.causalPairs[0]!;
      [pair.baseline, pair.falsifier] = [pair.falsifier, pair.baseline];
    }],
    ['wrong rejection reason', 'causal_reason_mismatch', (input: DocumentationCaseCoverageInput) => {
      input.causalPairs[0]!.observedReason = 'unrelated rejection';
    }],
    ['missing control family', 'control_family_missing', (input: DocumentationCaseCoverageInput) => {
      input.capture.requirements[0]!.controlFamilies.push('forged-proof');
    }],
    ['one declaration used twice', 'declaration_duplicate', (input: DocumentationCaseCoverageInput) => {
      input.capture.declarations.push(clone(input.capture.declarations[0]!));
    }],
    ['cross-plan declaration', 'declaration_plan_mismatch', (input: DocumentationCaseCoverageInput) => {
      input.capture.declarations[0]!.identity[2] =
        input.capture.declarations[0]!.identity[2].replace(PLAN, 'another-plan');
    }],
  ] as const)('rejects %s without selecting a smaller successful denominator', (_name, code, mutate) => {
    const input = fixture();
    expect(reconcileDocumentationCaseCoverage(input).status).toBe('complete');
    mutate(input);
    const result = reconcileDocumentationCaseCoverage(input);
    expect(result.status).toBe('incomplete');
    expect(result.reasons.some(reason => reason.code === code)).toBe(true);
  });

  it('refuses shared BAR credit and ambiguous attribution in a single case-role declaration', () => {
    const input = fixture();
    input.capture.declarations[0]!.identity[2] += '[R-9]';
    expect(reconcileDocumentationCaseCoverage(input).reasons).toContainEqual(expect.objectContaining({ code: 'case_tags_invalid' }));
    expect(readDocumentationCaseTag('[plan:' + PLAN + '][R-12][baseline][falsifier]')).toBeNull();
  });

  it('preserves exact source locations and refuses an empty or malformed candidate', () => {
    const input = fixture();
    input.capture.declarations[0]!.source.file = 'lib/foreign.test.ts';
    expect(reconcileDocumentationCaseCoverage(input).reasons).toContainEqual(expect.objectContaining({ code: 'declaration_source_mismatch' }));
    const empty = fixture(); empty.capture.declarations = [];
    expect(reconcileDocumentationCaseCoverage(empty)).toMatchObject({ status: 'invalid', expectedCaseCount: null });
    const missingCause = fixture(); missingCause.causalPairs[0]!.changedCause = ' ';
    expect(reconcileDocumentationCaseCoverage(missingCause).status).toBe('invalid');
    const malformedIdentity = fixture(); malformedIdentity.capture.declarations[0]!.identity[3] = 0;
    expect(reconcileDocumentationCaseCoverage(malformedIdentity).status).toBe('invalid');
  });
});
