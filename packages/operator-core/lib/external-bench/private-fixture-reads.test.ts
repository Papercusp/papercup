import { describe, expect, it } from 'vitest';
import { BENCH_PRIVATE_FIXTURE_TOOL, benchFixtureAllocationSha256, benchFixtureProductCall,
  benchFixtureReadArgs, benchFixtureReadContinuations, freezeBenchFixtureReadBoundary,
  validBenchFixtureReadBoundary, benchAttentionInputSchema, type BenchFixtureAllocation } from './private-fixture-reads';
import { latencyAttentionFixtures } from '../../test/_latency-acceptance';
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
  it('pins T06 raw events and view while admitting only retained observation reads', () => {
    const fixture = latencyAttentionFixtures();
    const { reference: _reference, measured: _measured, keys: _keys, observationRequired: _required, ...raw } = fixture;
    const input = benchAttentionInputSchema.parse(raw);
    const extended: BenchFixtureAllocation = { ...allocation, 'LATENCY-M1:T06': {
      A: { input, viewWorkspaceId: input.workspace }, B: { input, viewWorkspaceId: input.otherWorkspace } } };
    const frozen = freezeBenchFixtureReadBoundary({ binding, taskId: 'LATENCY-M1:T06', allocation: extended,
      expectedSha256: benchFixtureAllocationSha256(extended) })!;
    expect(benchFixtureProductCall(frozen, { operation: 'attention', case: 'B' }))
      .toEqual({ tool: 'attention-observation', args: { case: 'B' } });
    for (const change of [{ replay: true }, { workspaceId: 'foreign' }, { event: input.relevantMessage },
      { acker: 'pc-admin-coord-ui' }, { sql: 'INSERT' }, { reference: fixture.reference }])
      expect(benchFixtureReadArgs.safeParse({ operation: 'attention', case: 'A', ...change }).success).toBe(false);
    expect(() => benchFixtureProductCall(boundary(), { operation: 'attention', case: 'A' })).toThrow(/not declared/);
    expect(() => benchAttentionInputSchema.parse({ ...input, reference: fixture.reference })).toThrow();
    expect(() => benchAttentionInputSchema.parse({ ...input, unrelatedMessages: input.unrelatedMessages.slice(1) })).toThrow();
    expect(input.acknowledgment.acker).toBe('admin');
  });
  it('pins T10 cases and rejects caller-selected budgets, providers and unassigned scenarios', () => {
    const taskId = 'LATENCY-M1:T10';
    const extended: BenchFixtureAllocation = { ...allocation, [taskId]: {
      A: { budgetMs: 4000, scenarioIds: ['on-time'] },
      B: { budgetMs: 4000, scenarioIds: ['synchronous-entry-block', 'late-timer'] } } };
    const frozen = freezeBenchFixtureReadBoundary({ binding, taskId, allocation: extended,
      expectedSha256: benchFixtureAllocationSha256(extended) })!;
    expect(benchFixtureProductCall(frozen, { operation: 'retrieval', case: 'B', scenarioId: 'late-timer' }))
      .toEqual({ tool: 'retrieval-observation', args: { budgetMs: 4000, scenarioId: 'late-timer' } });
    for (const change of [{ budgetMs: 8000 }, { provider: 'foreign' }, { scenario: {} }, { nowMs: 0 },
      { workspaceId: 'foreign' }, { expected: { embeddingAccepted: true } }])
      expect(benchFixtureReadArgs.safeParse({ operation: 'retrieval', case: 'A', scenarioId: 'on-time', ...change }).success).toBe(false);
    expect(() => benchFixtureProductCall(frozen, { operation: 'retrieval', case: 'A', scenarioId: 'late-timer' })).toThrow(/not assigned/);
    expect(() => benchFixtureProductCall(boundary(), { operation: 'retrieval', case: 'A', scenarioId: 'on-time' })).toThrow(/not declared/);
    expect(() => benchFixtureProductCall(frozen, { operation: 'coverage', case: 'A' })).toThrow(/not declared/);
    expect(() => freezeBenchFixtureReadBoundary({ binding, taskId, expectedSha256: pin, allocation })).toThrow(/no frozen source/);
  });
  it.each(['LATENCY-M1:T07', 'LATENCY-M1:T08'] as const)('pins %s coverage identities and refuses caller-selected matching or mutation', taskId => {
    const source = { harness: 'papercusp', slug: 'frozen-plan', sourceIdPrefix: 'WI-80', itemIds: ['P-001', 'P-003'] };
    const extended = { ...allocation, [taskId]: { A: source, B: { ...source, itemIds: ['P-005'] } } };
    const frozen = freezeBenchFixtureReadBoundary({ binding, taskId, allocation: extended,
      expectedSha256: benchFixtureAllocationSha256(extended) })!;
    expect(benchFixtureProductCall(frozen, { operation: 'coverage', case: 'B' }))
      .toEqual({ tool: 'coverage-read', args: { harness: source.harness, slug: source.slug,
        sourceIdPrefix: source.sourceIdPrefix, itemIds: ['P-005'], workspaceId: binding.workspaceId } });
    for (const change of [{ harness: 'foreign' }, { slug: 'foreign' }, { itemIds: ['P-099'] },
      { workspaceId: 'foreign' }, { sourceIdPrefix: 'WI-' }, { promote: true }, { sql: 'SELECT 1' }, { eligibleIds: ['WI-answer'] }])
      expect(benchFixtureReadArgs.safeParse({ operation: 'coverage', case: 'A', ...change }).success).toBe(false);
    expect(() => benchFixtureProductCall(boundary(), { operation: 'coverage', case: 'A' })).toThrow(/not declared/);
    expect(() => benchFixtureProductCall(frozen, { operation: 'conditions', case: 'A' })).toThrow(/not declared/);
    expect(() => freezeBenchFixtureReadBoundary({ binding, taskId, expectedSha256: pin, allocation })).toThrow(/no frozen source/);
  });
  it('confines condition diagnosis to the host prefix without a caller-selected clock or filter', () => {
    const taskId = 'LATENCY-M1:T09';
    const extended = { ...allocation, [taskId]: { A: { prefix: 'frozen:busy:' }, B: { prefix: 'frozen:quiet:' } } };
    const frozen = freezeBenchFixtureReadBoundary({ binding, taskId, allocation: extended,
      expectedSha256: benchFixtureAllocationSha256(extended) })!;
    expect(benchFixtureProductCall(frozen, { operation: 'conditions', case: 'B' }))
      .toEqual({ tool: 'condition-prefix', args: { prefix: 'frozen:quiet:' } });
    for (const change of [{ prefix: 'foreign:' }, { since: '2026-11-06' }, { nowMs: 0 },
      { limit: 1 }, { workspaceId: 'foreign' }, { sql: 'SELECT 1' }])
      expect(benchFixtureReadArgs.safeParse({ operation: 'conditions', case: 'A', ...change }).success).toBe(false);
    expect(() => benchFixtureProductCall(boundary(), { operation: 'conditions', case: 'A' })).toThrow(/not declared/);
    expect(() => benchFixtureProductCall(frozen, { operation: 'timeline', case: 'A' })).toThrow(/not declared/);
    expect(() => freezeBenchFixtureReadBoundary({ binding, taskId, expectedSha256: pin, allocation })).toThrow(/no frozen source/);
  });
  it('admits exact frozen context selectors without caller-selected files or hashes', () => {
    const request = { operation: 'context', case: 'A', source: 'corpus', entryKey: 'raw:source' };
    expect(benchFixtureProductCall(boundary(), request)).toEqual({ tool: 'frozen-context',
      args: { source: 'corpus', entryKey: 'raw:source' } });
    for (const change of [{ path: '/foreign' }, { sha256: 'a'.repeat(64) }, { source: '../memory' },
      { entryKey: '' }, { sql: 'select 1' }])
      expect(benchFixtureReadArgs.safeParse({ ...request, ...change }).success).toBe(false);
  });
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
    expect(() => freezeBenchFixtureReadBoundary({ binding, taskId: 'LATENCY-M1:T06', expectedSha256: pin, allocation })).toThrow(/no frozen source/);
    expect(freezeBenchFixtureReadBoundary({ binding, taskId: 'LATENCY-M1:T11', expectedSha256: pin, allocation })).toBeUndefined();
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
  it.each(['LATENCY-M1:T04', 'LATENCY-M1:T05'] as const)('confines %s to allocated historical windows and cursor-only paging', taskId => {
    const a = { owner: 'su-11111111-1111-1111-1111-111111111111', since: '2026-11-06T00:00:00Z', until: '2026-11-06T00:10:00Z' };
    const b = { ...a, owner: 'su-22222222-2222-2222-2222-222222222222' };
    const extended = { ...allocation, [taskId]: { A: a, B: b } };
    const frozen = freezeBenchFixtureReadBoundary({ binding, taskId, allocation: extended,
      expectedSha256: benchFixtureAllocationSha256(extended) })!;
    expect(benchFixtureProductCall(frozen, { operation: 'timeline', case: 'B', cursor: 'position-only' }))
      .toEqual({ tool: 'sessions:timeline', args: { ...b, limit: 300, include_auto: true,
        group_repeated: false, cursor: 'position-only' } });
    expect(() => freezeBenchFixtureReadBoundary({ binding, taskId, allocation,
      expectedSha256: pin })).toThrow(/no frozen source/);
    expect(() => benchFixtureProductCall(frozen, { operation: 'plan', case: 'A' })).toThrow(/not declared/);
    expect(() => benchFixtureProductCall(boundary(), { operation: 'timeline', case: 'A' })).toThrow(/not declared/);
    for (const change of [{ owner: 'self' }, { until: a.since }, { since: 'invalid' }])
      expect(validBenchFixtureReadBoundary({ ...frozen, cases: { A: { ...a, ...change }, B: b } })).toBe(false);
    for (const change of [{ owner: a.owner }, { since: a.since }, { until: a.until },
      { limit: 1 }, { include_auto: false }, { group_repeated: true }, { kinds: ['tool'] }, { tool: 'coord:send' }])
      expect(benchFixtureReadArgs.safeParse({ operation: 'timeline', case: 'A', ...change }).success).toBe(false);
    const confinement: SessionToolConfinement = { denyTools: [], denyOutside: [BENCH_PRIVATE_FIXTURE_TOOL],
      denyAmbientContext: true, denyBenchmarkReadsOutside: frozen,
      denyWorkItemsOutside: { id: 'WI-own', harness: 'bench-private', checkout: '/private/own' },
      imposedBy: `benchmark-host ${frozen.assignmentId}`, reason: 'private assignment' };
    expect(evaluateSessionConfinement({ toolName: BENCH_PRIVATE_FIXTURE_TOOL,
      args: { operation: 'timeline', case: 'A' }, confinement }).allowed).toBe(true);
    expect(evaluateSessionConfinement({ toolName: 'sessions:timeline', args: a, confinement }).allowed).toBe(false);
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
