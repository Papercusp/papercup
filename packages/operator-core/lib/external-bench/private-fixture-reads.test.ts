import { describe, expect, it } from 'vitest';
import { BENCH_PRIVATE_FIXTURE_TOOL, benchFixtureAllocationSha256, benchFixtureProductCall,
  benchFixtureReadArgs, benchFixtureReadContinuations, freezeBenchFixtureReadBoundary,
  validBenchFixtureReadBoundary, type BenchFixtureAllocation } from './private-fixture-reads';
import { currentBenchSoloCapabilityControl } from './current-su';
import { allCapabilities, currentProtocolFixture } from './reproducibility/_protocol-test-fixture';
import { currentBenchmarkProtocolSchema } from './reproducibility/schema';
import { evaluateSessionConfinement, type SessionToolConfinement } from '../capability-envelope/session-confinement';

const allocation: BenchFixtureAllocation = {
  'LATENCY-M1:T01': { A: { issueId: 'EI-card-a' }, B: { issueId: 'EI-card-b' } },
  'LATENCY-M1:T02': {
    A: { issueId: 'EI-recipe-a', rubricRef: 'rubric-a', subjectRef: 'subject-a', comparisonTime: '2026-11-06T00:00:00Z' },
    B: { issueId: 'EI-recipe-b', rubricRef: 'rubric-b', subjectRef: 'subject-b', comparisonTime: '2026-11-06T00:00:00Z' } },
  'LATENCY-M1:T03': {
    A: { harness: 'fixture-a', slug: 'plan-a', revision: 3, specAsOf: '2026-11-06T00:00:00Z' },
    B: { harness: 'fixture-b', slug: 'plan-b', revision: 'c'.repeat(64), specAsOf: '2026-11-07T00:00:00Z' } },
};
const binding = { workspaceId: 'private-workspace', runId: 'run-1', preregHash: 'a'.repeat(64),
  assignmentId: 'bench-assignment:own', armId: 'cold', seed: 1 };
const pin = benchFixtureAllocationSha256(allocation);
const boundary = (taskId = 'LATENCY-M1:T01') => freezeBenchFixtureReadBoundary({
  binding, taskId, expectedSha256: pin, allocation })!;

describe('native benchmark private source allocation', () => {
  it('pins all source locators before deriving distinct cold/warm assignment boundaries', () => {
    const source = structuredClone(allocation);
    const cold = freezeBenchFixtureReadBoundary({ binding, taskId: 'LATENCY-M1:T01', expectedSha256: pin, allocation: source })!;
    const warm = freezeBenchFixtureReadBoundary({ binding: {
      ...binding, assignmentId: 'bench-assignment:warm', armId: 'warm' },
      taskId: cold.taskId, expectedSha256: pin, allocation })!;
    expect(warm.cases).toEqual(cold.cases);
    expect(warm.assignmentId).not.toBe(cold.assignmentId);
    expect(() => freezeBenchFixtureReadBoundary({ binding, taskId: cold.taskId,
      expectedSha256: pin, allocation: { ...allocation, 'LATENCY-M1:T01': {
        ...allocation['LATENCY-M1:T01'], A: { issueId: 'foreign' } } } })).toThrow(/frozen arm/);
    source['LATENCY-M1:T01'].A.issueId = 'mutated';
    expect(cold.cases.A).toEqual({ issueId: 'EI-card-a' });
    expect(freezeBenchFixtureReadBoundary({ binding, taskId: 'LATENCY-M1:T04', expectedSha256: pin, allocation })).toBeUndefined();
    expect(validBenchFixtureReadBoundary({ ...cold, sql: 'SELECT 1' })).toBe(false);
  });
  it('calls real-reader identities only from the pinned case and retains historical selectors', () => {
    expect(benchFixtureProductCall(boundary(), { operation: 'card', case: 'B', criterionKey: 'known', evidenceOffset: 400 }))
      .toEqual({ tool: 'scorecards:get', args: { issueId: 'EI-card-b', criterionKey: 'known', evidenceOffset: 400 } });
    expect(benchFixtureProductCall(boundary('LATENCY-M1:T02'), { operation: 'siblings', case: 'A' }))
      .toMatchObject({ tool: 'scorecards:list', args: { rubricRef: 'rubric-a', subjectRef: 'subject-a', limit: 20,
        historyMode: 'review-history', comparisonTime: '2026-11-06T00:00:00Z' } });
    expect(benchFixtureProductCall(boundary('LATENCY-M1:T03'), { operation: 'plan', case: 'B' }))
      .toEqual({ tool: 'plans:get', args: { harness: 'fixture-b', slug: 'plan-b', revision: 'c'.repeat(64), mode: 'full', includeEnrichments: false } });
    expect(benchFixtureProductCall(boundary('LATENCY-M1:T03'), { operation: 'specs', case: 'A' }))
      .toEqual({ tool: 'plans:get-specs', args: { harness: 'fixture-a', slug: 'plan-a', asOf: '2026-11-06T00:00:00Z' } });
    expect(() => benchFixtureProductCall(boundary(), { operation: 'siblings', case: 'A' })).toThrow(/not declared/);
    expect(() => benchFixtureProductCall(boundary(), { operation: 'card', case: 'A', rerunRecipeOffset: 0 })).toThrow(/incompatible/);
    expect(() => benchFixtureProductCall(boundary(), { operation: 'card', case: 'A', evidenceOffset: 1 })).toThrow(/incompatible/);
  });
  it.each(['workspaceId', 'harness', 'issueId', 'sql', 'tool', 'path', 'replay', 'projection'])
    ('refuses solver-supplied %s instead of widening a product reader', key => {
      expect(benchFixtureReadArgs.safeParse({ operation: 'card', case: 'A', [key]: 'foreign' }).success).toBe(false);
    });
  it('translates actual card continuations without changing evidence or granting replay', () => {
    const request = { operation: 'card', case: 'A' } as const;
    const call = benchFixtureProductCall(boundary(), request);
    const recipe = { steps: [{ tool: 'scorecards:get', args: { issueId: 'EI-card-a' } }] };
    const result = { scorecard: { evidence: 'verbatim evidence', rerunRecipe: recipe },
      evidenceRead: { next: { tool: 'scorecards:get', args: { issueId: 'EI-card-a', criterionKey: 'known', evidenceOffset: 24 } } },
      replay: { tool: 'scorecards:get', args: { issueId: 'EI-card-a', criterionKey: 'known', replay: 'retained-sql-query' } } };
    const translated = benchFixtureReadContinuations(result, call, request) as typeof result;
    expect(translated.scorecard).toBe(result.scorecard);
    expect(JSON.stringify(translated.scorecard.rerunRecipe)).toBe(JSON.stringify(recipe));
    expect(translated.evidenceRead.next).toEqual({ tool: BENCH_PRIVATE_FIXTURE_TOOL,
      args: { operation: 'card', case: 'A', criterionKey: 'known', evidenceOffset: 24 } });
    expect(translated.replay).toEqual(result.replay);
    expect(benchFixtureReadContinuations({ tool: 'scorecards:get', args: { issueId: 'foreign' } }, call, request))
      .toEqual({ tool: 'scorecards:get', args: { issueId: 'foreign' } });
  });
  it('keeps the source comparison clock on T02 card pages without exposing it as a solver selector', () => {
    const request = { operation: 'card', case: 'A' } as const;
    const call = benchFixtureProductCall(boundary('LATENCY-M1:T02'), request);
    expect(call.args.comparisonTime).toBe('2026-11-06T00:00:00Z');
    const address = { tool: 'scorecards:get', args: { issueId: call.args.issueId,
      comparisonTime: call.args.comparisonTime, indexOffset: 2 } };
    expect(benchFixtureReadContinuations({ evidenceRead: { next: address } }, call, request))
      .toEqual({ evidenceRead: { next: { tool: BENCH_PRIVATE_FIXTURE_TOOL, args: { operation: 'card', case: 'A', indexOffset: 2 } } } });
    expect(benchFixtureReadContinuations({ evidenceRead: { next: { ...address, args: {
      ...address.args, comparisonTime: '2026-11-07T00:00:00Z' } } } }, call, request))
      .toMatchObject({ evidenceRead: { next: { tool: 'scorecards:get' } } });
  });
  it('uses the existing exact ceiling and refuses malformed, cross-task and raw product access', () => {
    const reads = boundary();
    const confinement: SessionToolConfinement = { denyTools: [], denyOutside: [BENCH_PRIVATE_FIXTURE_TOOL],
      denyAmbientContext: true, denyBenchmarkReadsOutside: reads,
      denyWorkItemsOutside: { id: 'WI-own', harness: 'bench-private', checkout: '/private/own' },
      imposedBy: `benchmark-host ${reads.assignmentId}`, reason: 'private assignment' };
    const decide = (toolName: string, args: unknown, changed = confinement) =>
      evaluateSessionConfinement({ toolName, args, confinement: changed });
    const request = { operation: 'card', case: 'A' };
    expect(decide(BENCH_PRIVATE_FIXTURE_TOOL, request).allowed).toBe(true);
    expect(decide('scorecards:get', { issueId: 'EI-card-a' }).allowed).toBe(false);
    expect(decide(BENCH_PRIVATE_FIXTURE_TOOL, { operation: 'plan', case: 'A' }).allowed).toBe(false);
    for (const change of [{ denyWorkItemsOutside: undefined }, { denyAmbientContext: undefined },
      { denyBenchmarkReadsOutside: { ...reads, taskId: 'foreign' } }, { imposedBy: 'unbound' }])
      expect(decide(BENCH_PRIVATE_FIXTURE_TOOL, request, { ...confinement, ...change } as SessionToolConfinement).allowed).toBe(false);
    expect(decide(BENCH_PRIVATE_FIXTURE_TOOL, request, { ...confinement, denyTools: [BENCH_PRIVATE_FIXTURE_TOOL] }).allowed).toBe(false);
  });
  it('admits the proxy only on explicitly frozen, equally pinned Codex solo arms', () => {
    const protocol = currentProtocolFixture();
    for (const [index, arm] of protocol.arms.entries()) {
      arm.id = index ? 'warm' : 'cold';
      arm.control = { topology: 'solo', solverGroup: 'matched', solverToolsHash: 'f'.repeat(64), capabilities: allCapabilities('off') };
    }
    const solo = protocol.arms[0];
    expect(currentBenchSoloCapabilityControl(solo).toolNames).not.toContain(BENCH_PRIVATE_FIXTURE_TOOL);
    solo.control!.fixtureReads = { kind: 'latency-m1-v1', sha256: pin };
    expect(currentBenchSoloCapabilityControl(solo).toolNames).toContain(BENCH_PRIVATE_FIXTURE_TOOL);
    expect(currentBenchSoloCapabilityControl(solo).toolNames).not.toContain('scorecards:get');
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
    for (const arm of protocol.arms) if (arm.control?.solverGroup === solo.control!.solverGroup)
      arm.control.fixtureReads = { kind: 'latency-m1-v1', sha256: pin };
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(true);
    protocol.arms[1].control!.topology = 'stock-native-reference';
    expect(currentBenchmarkProtocolSchema.safeParse(protocol).success).toBe(false);
  });
});
