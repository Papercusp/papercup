import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainmentTree } from './containment-tree';
import type { WorkItem } from './work-items';
import type { GoalHistoryEntry, GoalHistoryRead } from '@papercusp/agent-mcp/goal-history';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { canonicalJson } from '@papercusp/hash-chain';
import { parseRecordedRubricCheck } from '@papercusp/test-config/execution-details';
import {
  captureGroundedContractChanges, compareGroundedPairedCost, GROUNDED_DIMENSIONS, GROUNDED_MANIFEST_SHA256,
  groundedPersistedBytes, materializeGroundedFixture, measureGroundedEvidence,
  observeGroundedDurableHost, observeGroundedStoreReads, observeGroundedModelFetch,
  observeGroundedStoreOperations, observeGroundedToolDispatch,
  type GroundedCensus, type GroundedMeasurementInput, type GroundedMeasurementScope,
} from './grounded-evidence-measurement';

const reads = vi.hoisted(() => ({ tree: vi.fn(), thread: vi.fn() }));
vi.mock('./containment-tree', async (original) => ({
  ...(await original<typeof import('./containment-tree')>()),
  resolveContainmentTree: reads.tree,
}));
vi.mock('./effort-thread', async (original) => ({
  ...(await original<typeof import('./effort-thread')>()),
  readEffortThread: reads.thread,
}));

import {
  buildBoundedPriorAttemptBrief,
  collectPriorAttempts,
  compilePriorAttempts,
  getContainmentRollupBrief,
  readGoalHistoryContext,
  readPlanHistoryContext,
  resolvePriorAttemptRefs,
} from './prior-attempt-context';

describe('GEC.N1-N8 persisted slice regression and cost', () => {
  const scope: GroundedMeasurementScope = {
    workspaceId: 'gec-b-unit', potId: 'gec-b-pot', harness: 'gec-b', runId: 'gec-unit-run', ownerId: 'gec-unit-owner',
    caseId: 'N7', arm: 'pre', iteration: 1, manifestHash: GROUNDED_MANIFEST_SHA256,
    fixtureHash: 'fixture-v1', sourceFingerprint: 'source-v1', testFingerprint: 'test-v1',
    runtimeFingerprint: 'runtime-v1', configFingerprint: 'config-v1',
  };
  function captured(): GroundedMeasurementInput {
    const census = <T extends { id: string }>(rows: T[]): GroundedCensus<T> => ({
      scope: { ...scope }, sourceRef: 'recorder:unit-control', complete: true, ids: rows.map(r => r.id), rows,
    });
    return { scope: { ...scope }, boundary: { scope: { ...scope }, sourceRef: 'boundary:unit-control',
      admittedAt: '2026-11-12T00:00:00Z', settledAt: '2026-11-12T00:00:01Z',
      monotonicStartMs: 100, monotonicEndMs: 1100, drained: true },
      models: census([]), invocations: census([]), durable: census([]), storage: census([]), contracts: census([]) };
  }

  it('materializes the independently reviewed B bytes and bijective keys without changing an oracle', () => {
    const setup = materializeGroundedFixture('unit-run', { 'archive-01': '711' });
    expect(setup.manifestHash).toBe('565555fb5e75131c3c9fc59664eb42e21d2142d19f34713d2265795aada09e6a');
    expect(createHash('sha256').update(canonicalJson(setup.manifest)).digest('hex')).toBe(setup.manifestHash);
    expect(setup.manifest.cases).toHaveLength(52);
    expect(setup.manifest.measurements.dimensions).toEqual([...GROUNDED_DIMENSIONS]);
    expect(setup.manifest.seed.exactArchive.body).toBe('The original scope remains staging. Preserve this sentence and the final character: λ.');
    expect(setup.mapping['gec-b-<registered-run-id>']).toBe('gec-b-unit-run');
    expect(setup.mapping['archive-01']).toBe('711');
    const stored = materializeGroundedFixture('unit-run', { 'child-25': 'WI-generated-25', e2: '712' });
    expect(stored.mapping['child-25']).toBe('WI-generated-25');
    expect(stored.mapping.e2).toBe('712');
    expect(stored.manifest).toEqual(setup.manifest);
    expect(() => materializeGroundedFixture('unit-run', { 'child-26': 'WI-guessed-26' })).toThrow('unknown');
    expect(() => materializeGroundedFixture('unit-run', { e2: 'child-25' })).toThrow('bijective');
    expect(materializeGroundedFixture('unit-run', { 'src-2': 'sha256:physical-source', 'anchor-2': 'plan-anchor:1' })
      .mapping['src-2']).toBe('sha256:physical-source');
    expect(materializeGroundedFixture('unit-run').manifest).toEqual(setup.manifest);
    expect(() => materializeGroundedFixture('unit-run', { 'archive-01': 'D-002' })).toThrow('bijective');
    expect(() => materializeGroundedFixture('unit-run', { 'guessed-oracle': '711' })).toThrow('unknown');
  });

  it('retains 21 scalar checks in the existing ledger shape, with zero only at complete armed boundaries', () => {
    const result = measureGroundedEvidence(captured());
    expect(result.complete).toBe(true);
    expect(result.values.endToEndMs).toBe(1000);
    expect(result.checks).toHaveLength(21);
    for (const { check, status } of result.checks) {
      expect(status).toBe('captured');
      expect(parseRecordedRubricCheck(check)).toEqual(check);
      expect(check.subject?.ref).toMatch(/^GEC-20261112-B\/N7\/pre\/1\//);
      expect(check.provenance?.gaps).toEqual([]);
      expect(check.value).toBe(check.unit === 'ms' ? 1000 : 0);
    }
    const missing = captured(); delete missing.models;
    const unknown = measureGroundedEvidence(missing);
    expect(unknown.complete).toBe(false);
    expect(unknown.values.modelCalls).toBeNull();
    expect(unknown.values.modelInputTokens).toBeNull();
    expect(unknown.values.extractionCalls).toBeNull();
  });

  it('rounds only BIGINT row duration metadata while retaining fractional monotonic milliseconds', () => {
    const input = captured(); input.boundary!.monotonicEndMs = 1100.25;
    const result = measureGroundedEvidence(input);
    expect(result.values.endToEndMs).toBe(1000.25);
    expect(result.ledgerResults.every(row => row.durationMs === 1001)).toBe(true);
    expect(result.ledgerResults.find(row => row.check.unit === 'ms')?.check.value).toBe(1000.25);
  });

  it.each(['models', 'invocations', 'durable', 'storage', 'contracts'] as const)(
    'rejects a deliberately dropped %s recorder row independently of the adapter values', channel => {
      const input = captured(); input[channel]!.ids = ['original-admitted-operation'];
      const result = measureGroundedEvidence(input);
      expect(result.complete).toBe(false);
      expect(result.gaps).toContain(`${channel}:recorder-population-mismatch`);
      input[channel]!.complete = false;
      expect(measureGroundedEvidence(input).gaps).toContain(`${channel}:missing-incomplete-or-foreign-census`);
    });

  it.each(['workspaceId', 'potId', 'harness', 'runId', 'ownerId', 'caseId', 'arm', 'iteration',
    'manifestHash', 'fixtureHash', 'sourceFingerprint', 'testFingerprint', 'runtimeFingerprint', 'configFingerprint'] as const)(
    'refuses source capture from a different %s', key => {
      const input = captured();
      Object.assign(input.storage!.scope, { [key]: key === 'iteration' ? 2 : 'foreign' });
      const result = measureGroundedEvidence(input);
      expect(result.values.storageOperations).toBeNull(); expect(result.values.storageBytes).toBeNull();
      expect(result.complete).toBe(false);
    });

  it('keeps an unretainable recorder census unknown without throwing during provenance creation', () => {
    const input = captured();
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    input.invocations!.ids = ['uncapturable'];
    input.invocations!.rows = [{ id: 'uncapturable', tool: 'plans:get', args: cyclic,
      boundary: 'consumer', originRef: 'transport:cyclic-control',
      purpose: 'retrieval', purposeRef: 'registration:plans:get' }];
    expect(() => measureGroundedEvidence(input)).not.toThrow();
    const result = measureGroundedEvidence(input);
    expect(result.gaps).toContain('invocations:unretainable-source');
    expect(result.values.retrievalCalls).toBeNull();
    expect(result.values.modelCalls).toBe(0);
    expect(result.checks).toHaveLength(21);
  });

  it('keeps model purposes and final provider usage separate and rejects missing or unsafe tokens', () => {
    const input = captured();
    input.models!.ids = ['request-model', 'request-extraction', 'request-refresh', 'request-authoring'];
    input.models!.rows = [
      { id: 'request-model', purpose: 'model', purposeRef: 'caller:model', usageRef: 'provider:1', inputTokens: 10, outputTokens: 2 },
      { id: 'request-extraction', purpose: 'extraction', purposeRef: 'caller:extract', usageRef: 'provider:2', inputTokens: 20, outputTokens: 3 },
      { id: 'request-refresh', purpose: 'refresh', purposeRef: 'caller:refresh', usageRef: 'provider:3', inputTokens: 30, outputTokens: 4 },
      { id: 'request-authoring', purpose: 'authoring', purposeRef: 'caller:author', usageRef: 'provider:4', inputTokens: 40, outputTokens: 5 },
    ];
    const result = measureGroundedEvidence(input);
    expect(result.values).toMatchObject({ modelCalls: 4, modelInputTokens: 100, modelOutputTokens: 14,
      extractionCalls: 1, extractionInputTokens: 20, refreshOutputTokens: 4, agentAuthoringInputTokens: 40 });
    input.models!.rows = input.models!.rows.map(row => row.id === 'request-refresh' ? { ...row, usageRef: null } : row);
    expect(measureGroundedEvidence(input).values).toMatchObject({ modelInputTokens: null, modelOutputTokens: null,
      refreshInputTokens: null, extractionInputTokens: 20 });
    input.models!.rows = input.models!.rows.map(row => ({ ...row, purpose: 'unknown' }));
    expect(measureGroundedEvidence(input).values.extractionCalls).toBeNull();
    input.models!.rows = input.models!.rows.map(row => ({ ...row, purpose: 'invalid-untrusted-purpose' as never }));
    expect(measureGroundedEvidence(input).values.extractionCalls).toBeNull();
  });

  const wire = (...events: unknown[]) => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  it.each([
    ['codex', wire({ type: 'response.completed', response: { output: [], usage: { input_tokens: 0, output_tokens: 0 } } }), 0, 0],
    ['codex', wire({ type: 'response.completed', response: { output: [], usage: { input_tokens: 17, output_tokens: 5 } } }), 17, 5],
    ['anthropic', JSON.stringify({ type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 17, output_tokens: 5 } }), 17, 5],
    ['anthropic', wire({ type: 'message_start', message: { usage: { input_tokens: 17 } } },
      { type: 'message_delta', usage: { output_tokens: 5 } }, { type: 'message_stop' }), 17, 5],
  ] as const)('captures final %s provider usage from actual fetch bytes without consuming the caller body', async (provider, raw, inputTokens, outputTokens) => {
    const retainTape = vi.fn(async () => 'transcript_raw_zstd:test/provider-tape');
    const tap = observeGroundedModelFetch({ scope, sourceRef: 'recorder:provider-control', attemptId: 'request-control',
      provider, purpose: 'extraction', purposeRef: 'caller:extraction-test', fetchImpl: vi.fn(async () => new Response(raw)), retainTape });
    const response = await tap.fetch('https://provider.test/request');
    expect(await response.text()).toBe(raw);
    await tap.drain();
    const input = captured(); input.models = tap.seal();
    expect(measureGroundedEvidence(input).values).toMatchObject({ modelCalls: 1, modelInputTokens: inputTokens,
      modelOutputTokens: outputTokens, extractionCalls: 1, extractionInputTokens: inputTokens, extractionOutputTokens: outputTokens });
    expect(retainTape).toHaveBeenCalledWith({ id: 'request-control:model:1', provider, raw,
      sha256: createHash('sha256').update(raw).digest('hex') });
    expect(input.models.rows[0]!.usageRef).toContain('#sha256=');
  });

  it.each([
    wire({ type: 'response.output_item.done', item: { type: 'message', content: [] } }),
    wire({ type: 'response.completed', response: { usage: { input_tokens: 17 } } }),
    wire({ type: 'response.completed', response: { usage: { input_tokens: -1, output_tokens: 5 } } }),
    wire({ type: 'response.completed', response: { usage: { input_tokens: 17, output_tokens: 0.5 } } }),
    wire({ type: 'response.completed', response: { usage: { input_tokens: 17, output_tokens: 5 } } },
      { type: 'response.failed' }),
    wire({ type: 'response.completed', response: { usage: { input_tokens: 17, output_tokens: 5 } } }) + 'data: {broken}\n\n',
    wire({ type: 'response.completed', response: { usage: { input_tokens: 17, output_tokens: 5 } } }) + 'data: {unfinished',
    wire({ type: 'response.completed', response: { usage: { input_tokens: 17, output_tokens: 5 } } }, { type: 'response.output_item.done' }),
  ])('leaves partial, invalid, and failed provider tapes unknown: %s', async raw => {
    const tap = observeGroundedModelFetch({ scope, sourceRef: 'recorder:provider-control', attemptId: 'request-control',
      provider: 'codex', purpose: 'model', purposeRef: 'caller:model-test',
      fetchImpl: vi.fn(async () => new Response(raw)), retainTape: async () => 'retained:incomplete-tape' });
    await tap.fetch('https://provider.test/request'); await tap.drain();
    const input = captured(); input.models = tap.seal();
    expect(input.models.complete).toBe(true);
    expect(measureGroundedEvidence(input).values).toMatchObject({ modelCalls: 1, modelInputTokens: null, modelOutputTokens: null });
  });

  it('rejects unterminated Anthropic streams and retention errors rather than certifying free calls', async () => {
    for (const raw of [wire({ type: 'message_start', message: { usage: { input_tokens: 17 } } }),
      wire({ type: 'message_start', message: { usage: { input_tokens: 17 } } },
        { type: 'message_delta', usage: { output_tokens: 5, input_tokens: -1 } }, { type: 'message_stop' }),
      JSON.stringify({ type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 17 } })]) {
      const tap = observeGroundedModelFetch({ scope, sourceRef: 'recorder:anthropic-control', attemptId: 'partial-control',
        provider: 'anthropic', purpose: 'authoring', purposeRef: 'caller:author-test',
        fetchImpl: vi.fn(async () => new Response(raw)), retainTape: async () => 'retained:partial' });
      await tap.fetch('https://provider.test/request'); await tap.drain();
      const input = captured(); input.models = tap.seal();
      expect(measureGroundedEvidence(input).values.agentAuthoringInputTokens).toBeNull();
    }
    const tap = observeGroundedModelFetch({ scope, sourceRef: 'recorder:retention-control', attemptId: 'retention-control',
      provider: 'anthropic', purpose: 'authoring', purposeRef: 'caller:author-test',
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ type: 'message', stop_reason: 'end_turn',
        usage: { input_tokens: 17, output_tokens: 5 } }))), retainTape: async () => { throw new Error('recorder failed'); } });
    const response = await tap.fetch('https://provider.test/request');
    expect(response.ok).toBe(true); await tap.drain();
    const input = captured(); input.models = tap.seal();
    expect(measureGroundedEvidence(input).values.agentAuthoringInputTokens).toBeNull();
  });

  it('counts failed and retried provider sends, requires retention, and refuses a census sealed before settlement', async () => {
    let retained!: () => void;
    const retention = new Promise<void>(resolve => { retained = resolve; });
    const raw = wire({ type: 'response.completed', response: { usage: { input_tokens: 0, output_tokens: 0 } } });
    const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('transport failed'))
      .mockImplementation(async () => new Response(raw));
    const tap = observeGroundedModelFetch({ scope, sourceRef: 'recorder:retry-control', attemptId: 'retry-control',
      provider: 'codex', purpose: 'refresh', purposeRef: 'caller:refresh-test', fetchImpl: send,
      retainTape: async () => { await retention; return null; } });
    await expect(tap.fetch('https://provider.test/request')).rejects.toThrow('transport failed');
    await tap.fetch('https://provider.test/request');
    expect(tap.seal().complete).toBe(false);
    retained(); await tap.drain();
    const input = captured(); input.models = tap.seal();
    expect(input.models.ids).toEqual(['retry-control:model:1', 'retry-control:model:2']);
    expect(measureGroundedEvidence(input).values).toMatchObject({ modelCalls: 2, refreshCalls: 2, refreshInputTokens: null });
    await tap.fetch('https://provider.test/request'); await tap.drain();
    expect(tap.seal().complete).toBe(false);
  });

  it('counts public recovery once per dispatch, normalizes wrappers, and excludes nested/control calls', () => {
    const input = captured();
    input.invocations!.ids = ['one', 'two', 'nested', 'control'];
    input.invocations!.rows = [
      { id: 'one', tool: 'plans:get', args: { slug: 'gec-b-plan', heading: 'History' }, boundary: 'consumer',
        originRef: 'transport:one', purpose: 'retrieval', purposeRef: 'caller:read' },
      { id: 'two', tool: 'tools:invoke', args: { name: 'plans:get', args: { heading: 'History', slug: 'gec-b-plan' } },
        boundary: 'consumer', originRef: 'transport:two', purpose: 'retrieval', purposeRef: 'caller:read' },
      { id: 'nested', tool: 'work_items:get', args: {}, boundary: 'internal', originRef: 'transport:nested',
        purpose: 'retrieval', purposeRef: 'caller:read' },
      { id: 'control', tool: 'plans:get', args: {}, boundary: 'control', originRef: 'transport:control',
        purpose: 'other', purposeRef: 'caller:control' },
    ];
    expect(measureGroundedEvidence(input).values).toMatchObject({ foregroundLookups: 2, repeatedCalls: 1, retrievalCalls: 3 });
    input.invocations!.rows = input.invocations!.rows.map(row => row.id === 'one' ? { ...row, boundary: 'unknown' } : row);
    expect(measureGroundedEvidence(input).values).toMatchObject({ foregroundLookups: null, repeatedCalls: null, retrievalCalls: null });
  });

  it('retains physical live/replay steps and actual persisted UTF8 bytes without using output bytes', () => {
    const input = captured();
    input.durable!.ids = ['attempt1:step1', 'attempt2:step1'];
    input.durable!.rows = [{ id: 'attempt1:step1', source: 'live' }, { id: 'attempt2:step1', source: 'recorded' }];
    input.storage!.ids = ['read', 'write'];
    const serialized = JSON.stringify({ body: 'λ.' });
    input.storage!.rows = [{ id: 'read', kind: 'read', persistedBytes: null },
      { id: 'write', kind: 'write', persistedBytes: groundedPersistedBytes(serialized) }];
    expect(measureGroundedEvidence(input).values).toMatchObject({ durableSteps: 2, storageOperations: 2, storageBytes: 14 });
    input.storage!.rows = [{ id: 'read', kind: 'read', persistedBytes: null }, { id: 'write', kind: 'write', persistedBytes: null }];
    expect(measureGroundedEvidence(input).values.storageBytes).toBeNull();
  });

  it('counts newly required schema paths and narratives independently, and refuses unsettled child work', () => {
    const input = captured();
    input.contracts!.ids = ['authority:plans'];
    input.contracts!.rows = [{ id: 'authority:plans', beforeRequiredPaths: ['id'], afterRequiredPaths: ['id', 'proof'],
      beforeNarrativePaths: [], afterNarrativePaths: ['proof.explanation'] }];
    expect(measureGroundedEvidence(input).values).toMatchObject({ newMandatoryFields: 1, newMandatoryNarrativeSurfaces: 1 });
    input.boundary!.drained = false;
    const unsettled = measureGroundedEvidence(input);
    expect(unsettled.complete).toBe(false);
    expect(Object.values(unsettled.values).every(value => value === null)).toBe(true);
  });

  it('derives field and narrative deltas from complete projected schemas, following local refs', () => {
    const before = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } };
    const after = { type: 'object', required: ['id', 'completion'], properties: { ...before.properties,
      completion: { $ref: '#/$defs/completion' } }, $defs: { completion: { type: 'object',
        required: ['summary', 'count'], properties: { summary: { type: 'string', contentMediaType: 'text/markdown' }, count: { type: 'integer' } } } } };
    const snapshot = (schema: unknown) => ({ sourceRef: 'catalogue:original', sourceFingerprint: scope.sourceFingerprint,
      complete: true, ids: ['work_items:complete'], rows: [{ id: 'work_items:complete', inputSchema: schema }] });
    const capture = captureGroundedContractChanges({ scope, sourceRef: 'catalogue:comparison', before: snapshot(before), after: snapshot(after) });
    const input = captured(); input.contracts = capture.census;
    expect(capture.gaps).toEqual([]);
    expect(measureGroundedEvidence(input).values).toMatchObject({ newMandatoryFields: 3, newMandatoryNarrativeSurfaces: 1 });
    expect(capture.census.rows[0]!.afterRequiredPaths).toEqual(['/completion', '/completion/count', '/completion/summary', '/id']);
    const unchanged = captureGroundedContractChanges({ scope, sourceRef: 'catalogue:same', before: snapshot(after), after: snapshot(after) });
    input.contracts = unchanged.census;
    expect(measureGroundedEvidence(input).values).toMatchObject({ newMandatoryFields: 0, newMandatoryNarrativeSurfaces: 0 });
  });

  it('retains code-only contract bytes and refuses changed, omitted or corrupt source evidence', () => {
    const body = 'if (!args.proof) throw new Error("proof required");';
    const source = { id: 'acceptance:complete.ts', sourceRef: 'source:complete.ts', body,
      sha256: createHash('sha256').update(body).digest('hex') };
    const snapshot = () => ({ sourceRef: 'catalogue:source', sourceFingerprint: scope.sourceFingerprint,
      complete: true, ids: [], rows: [], sourceFiles: { ids: [source.id], rows: [{ ...source }] } });
    const before = snapshot(), after = snapshot();
    const input = captured();
    input.contracts = captureGroundedContractChanges({ scope, sourceRef: 'comparison:source', before, after }).census;
    expect(measureGroundedEvidence(input).values).toMatchObject({ newMandatoryFields: 0, newMandatoryNarrativeSurfaces: 0 });
    for (const mutate of [
      (value: ReturnType<typeof snapshot>) => { value.sourceFiles.rows = []; },
      (value: ReturnType<typeof snapshot>) => { value.sourceFiles.ids = []; },
      (value: ReturnType<typeof snapshot>) => { value.sourceFiles.rows[0]!.sha256 = 'bad'; },
      (value: ReturnType<typeof snapshot>) => {
        const changed = value.sourceFiles.rows[0]!;
        changed.body += '\nif (!args.reason) throw new Error("reason required");';
        changed.sha256 = createHash('sha256').update(changed.body).digest('hex');
      },
    ]) {
      const changed = snapshot(); mutate(changed);
      const capture = captureGroundedContractChanges({ scope, sourceRef: 'comparison:source', before, after: changed });
      expect(capture.gaps.length).toBeGreaterThan(0);
      input.contracts = capture.census;
      expect(measureGroundedEvidence(input).values.newMandatoryFields).toBeNull();
      expect(measureGroundedEvidence(input).values.newMandatoryNarrativeSurfaces).toBeNull();
    }
    const missing = { ...snapshot(), sourceFiles: undefined };
    expect(captureGroundedContractChanges({ scope, sourceRef: 'comparison:missing', before, after: missing }).gaps)
      .toContain('contracts:source-census-missing');
  });

  it('rejects dropped schemas, unsupported validation, and unclassified mandatory prose without guessing zero', () => {
    const before = { type: 'object', properties: {}, required: [] };
    const snapshot = (schema: unknown) => ({ sourceRef: 'catalogue:original', sourceFingerprint: scope.sourceFingerprint,
      complete: true, ids: ['authority:write'], rows: [{ id: 'authority:write', inputSchema: schema }] });
    for (const after of [
      { type: 'object', required: ['reason'], properties: { reason: { type: 'string', description: 'A new mandatory explanation' } } },
      { anyOf: [before, { type: 'object', required: ['hidden'], properties: { hidden: { type: 'string' } } }] },
      { $ref: '#/$defs/loop', $defs: { loop: { $ref: '#/$defs/loop' } } },
    ]) {
      const capture = captureGroundedContractChanges({ scope, sourceRef: 'catalogue:comparison', before: snapshot(before), after: snapshot(after) });
      const input = captured(); input.contracts = capture.census;
      expect(capture.gaps.length).toBeGreaterThan(0);
      expect(measureGroundedEvidence(input).values.newMandatoryNarrativeSurfaces).toBeNull();
    }
    const dropped = snapshot(before); dropped.ids.push('omitted:authority');
    expect(captureGroundedContractChanges({ scope, sourceRef: 'catalogue:comparison', before: snapshot(before), after: dropped }).census.complete).toBe(false);
    const foreign = snapshot(before); foreign.sourceFingerprint = 'foreign-source';
    expect(captureGroundedContractChanges({ scope, sourceRef: 'catalogue:comparison', before: snapshot(before), after: foreign }).gaps).toContain('contracts:foreign-current-source');
  });

  it('applies the frozen three-pair median budget, including zero baselines and missing observations', () => {
    expect(compareGroundedPairedCost([10, 100, 10], [11, 11, 500]).verdict).toBe('pass');
    expect(compareGroundedPairedCost([10, 10, 10], [12, 12, 1]).verdict).toBe('fail');
    expect(compareGroundedPairedCost([0, 0, 0], [1, 0, 1]).verdict).toBe('fail');
    expect(compareGroundedPairedCost([0, 0, 0], [0, 0, 100]).verdict).toBe('pass');
    expect(compareGroundedPairedCost([0, null, 0], [0, 0, 0]).verdict).toBe('unknown');
    expect(compareGroundedPairedCost([1], [1]).verdict).toBe('unknown');
  });

  it('counts registered result, authority and acceptance requirements alongside tool inputs', () => {
    const empty = { type: 'object', properties: {} };
    const prose = { type: 'object', required: ['reason'],
      properties: { reason: { type: 'string', contentMediaType: 'text/markdown' } } };
    const snapshot = (schema: unknown) => ({ sourceRef: 'catalogue:all-channels', sourceFingerprint: scope.sourceFingerprint,
      complete: true, ids: ['work_items:complete'], requiredKinds: ['input', 'result', 'authority', 'acceptance'] as const,
      rows: [{ id: 'work_items:complete', inputSchema: empty, resultSchema: schema,
        authoritySchema: schema, acceptanceSchema: schema }] });
    const capture = captureGroundedContractChanges({ scope, sourceRef: 'catalogue:full-comparison',
      before: snapshot(empty), after: snapshot(prose) });
    const input = captured(); input.contracts = capture.census;
    expect(capture.gaps).toEqual([]);
    expect(capture.census.ids).toHaveLength(4);
    expect(measureGroundedEvidence(input).values).toMatchObject({ newMandatoryFields: 3, newMandatoryNarrativeSurfaces: 3 });
    const missing = snapshot(prose);
    delete (missing.rows[0] as { acceptanceSchema?: unknown }).acceptanceSchema;
    const incomplete = captureGroundedContractChanges({ scope, sourceRef: 'catalogue:missing-acceptance',
      before: snapshot(empty), after: missing });
    input.contracts = incomplete.census;
    expect(measureGroundedEvidence(input).values.newMandatoryFields).toBeNull();
  });

  it('proves unchanged conditional contracts have no additions while refusing changed or dropped channels', () => {
    const schema = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    const snapshot = () => ({ sourceRef: 'catalogue:conditional', sourceFingerprint: scope.sourceFingerprint,
      complete: true, ids: ['acceptance:write'], requiredKinds: ['input', 'acceptance'] as const,
      rows: [{ id: 'acceptance:write', inputSchema: schema, acceptanceSchema: schema }] });
    const same = captureGroundedContractChanges({ scope, sourceRef: 'catalogue:unchanged', before: snapshot(), after: snapshot() });
    const input = captured(); input.contracts = same.census;
    expect(same.gaps).toEqual([]);
    expect(measureGroundedEvidence(input).values).toMatchObject({ newMandatoryFields: 0, newMandatoryNarrativeSurfaces: 0 });
    const changed = snapshot(); changed.rows[0]!.acceptanceSchema = { anyOf: [{ type: 'string' }, { type: 'boolean' }] };
    expect(captureGroundedContractChanges({ scope, sourceRef: 'catalogue:changed', before: snapshot(), after: changed }).census.complete).toBe(false);
    const dropped = { ...snapshot(), requiredKinds: ['input'] as const };
    const capture = captureGroundedContractChanges({ scope, sourceRef: 'catalogue:dropped-channel', before: snapshot(), after: dropped });
    expect(capture.gaps).toContain('contracts:channel-population-changed');
    expect(capture.census.complete).toBe(false);
  });

  it('captures the real collector dependency calls and detects a dropped observation', async () => {
    const original = dependencies();
    reads.tree.mockResolvedValue({ ...tree(0), root: { kind: 'work_item', ref: 'WI-1', depth: 0 }, descended: false });
    const observed = observeGroundedStoreReads({ scope, deps: original, attemptId: 'collector-1', sourceRef: 'collector:unit',
      methods: ['getPlan', 'specs', 'edges', 'evidence', 'item', 'items', 'checkpoint', 'thread', 'lifecycle', 'priorWork', 'goalHistory', 'goalHistoryByIds'] });
    await collectPriorAttempts({ workItemId: 'WI-1', harnessSlug: 'papercusp' }, observed.deps as never);
    const capture = observed.seal();
    expect(capture.complete).toBe(true);
    expect(capture.ids.length).toBeGreaterThan(0);
    expect(capture.ids.some(id => id.endsWith(':checkpoint'))).toBe(true);
    const input = captured(); input.storage = capture;
    expect(measureGroundedEvidence(input).values.storageOperations).toBe(capture.ids.length);
    input.storage = { ...capture, rows: capture.rows.slice(1) };
    expect(measureGroundedEvidence(input).values.storageOperations).toBeNull();
    await observed.deps.item('WI-1');
    expect(observed.seal().complete).toBe(false);
  });

  it('captures serialized writes at their original boundary and preserves class receivers and failures', async () => {
    class Store {
      #values = new Map<string, string | Uint8Array>();
      async write(key: string, value: string | Uint8Array) { this.#values.set(key, value); return 'small-result'; }
      async read(key: string) { return this.#values.get(key); }
      async uncertainWrite(key: string, value: string) { this.#values.set(key, value); throw new Error('receipt lost'); }
    }
    const original = new Store();
    const tap = observeGroundedStoreOperations({ scope, deps: original, sourceRef: 'store:serialized-control', attemptId: 'persist',
      operations: [{ method: 'write', kind: 'write', serializedArgument: 1 }, { method: 'read', kind: 'read' }] });
    const body = JSON.stringify({ body: 'λ.' });
    const binary = new Uint8Array([0, 127, 255]);
    expect(await tap.deps.write('text', body)).toBe('small-result');
    await tap.deps.write('binary', binary);
    expect(await tap.deps.read('text')).toBe(body);
    const input = captured(); input.storage = tap.seal();
    expect(measureGroundedEvidence(input).values).toMatchObject({ storageOperations: 3,
      storageBytes: Buffer.byteLength(body) + binary.byteLength });
    input.storage = { ...tap.seal(), rows: tap.seal().rows.slice(1) };
    expect(measureGroundedEvidence(input).values.storageBytes).toBeNull();
    const failed = observeGroundedStoreOperations({ scope, deps: original, sourceRef: 'store:uncertain-control', attemptId: 'uncertain',
      operations: [{ method: 'uncertainWrite', kind: 'write', serializedArgument: 1 }] });
    await expect(failed.deps.uncertainWrite('partial', body)).rejects.toThrow('receipt lost');
    expect(await original.read('partial')).toBe(body);
    input.storage = failed.seal();
    expect(input.storage.ids).toHaveLength(1);
    expect(measureGroundedEvidence(input).values.storageBytes).toBeNull();
    const opaque = observeGroundedStoreOperations({ scope, deps: original, sourceRef: 'store:opaque-control', attemptId: 'opaque',
      operations: [{ method: 'write', kind: 'write' }] });
    await opaque.deps.write('opaque', body); input.storage = opaque.seal();
    expect(measureGroundedEvidence(input).values.storageBytes).toBeNull();
  });

  it('counts SQL admissions beyond diagnostic capacity and keeps opaque writes, loss and hook replacement explicit', () => {
    const prior = { original: 'diagnostic-context' }, priorResult = vi.fn();
    const client = { options: { onquerycontext: () => prior, onresult: priorResult } } as unknown as postgres.Sql;
    const originalContextHook = client.options.onquerycontext;
    expect(() => observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'bad', attemptId: 'bad',
      postgres: [{ pool: 'first', client }, { pool: 'duplicate', client }] })).toThrow('duplicate');
    expect(client.options.onquerycontext).toBe(originalContextHook);
    const result = (context: unknown, queryId: number, command = 'SELECT') => ({ context, queryId, command,
      query: command === 'SELECT' ? 'SELECT 1' : 'INSERT INTO cache_l2 VALUES ($1)',
      status: 'ok', wireBytes: 99999 } as postgres.QueryResultDiagnostic);
    const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'store:pg-control',
      attemptId: 'pg', postgres: [{ pool: 'real-hooks', client }], isReadOnlySql: row => row.command === 'SELECT' });
    const contexts = tap.run(() => Array.from({ length: 40 }, () => client.options.onquerycontext!({ executed: true })));
    // Result callbacks deliberately run OUTSIDE run(), as pool callbacks do.
    contexts.forEach((context, i) => client.options.onresult!(result(context, i)));
    expect(priorResult.mock.calls.every(([row]) => row.context === prior)).toBe(true);
    const input = captured(); input.storage = tap.seal();
    expect(measureGroundedEvidence(input).values).toMatchObject({ storageOperations: 40, storageBytes: 0 });
    tap.restore();
    expect(client.options.onquerycontext!()).toBe(prior);
    const write = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'store:pg-write',
      attemptId: 'pg-write', postgres: [{ pool: 'real-hooks', client }] });
    const writeContext = write.run(() => client.options.onquerycontext!({ executed: true }));
    client.options.onresult!(result(writeContext, 41, 'INSERT'));
    input.storage = write.seal();
    expect(measureGroundedEvidence(input).values).toMatchObject({ storageOperations: 1, storageBytes: null });
    write.restore();
    const lost = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'store:pg-loss',
      attemptId: 'pg-loss', postgres: [{ pool: 'real-hooks', client }] });
    lost.run(() => client.options.onquerycontext!({ executed: true }));
    input.storage = lost.seal();
    expect(measureGroundedEvidence(input).values.storageOperations).toBeNull();
    lost.restore();
    const replaced = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'store:pg-replaced',
      attemptId: 'pg-replaced', postgres: [{ pool: 'real-hooks', client }] });
    client.options.onresult = priorResult;
    expect(replaced.seal().complete).toBe(false);
    replaced.restore();
    client.options.onquerycontext = () => { throw new Error('original admission hook lost'); };
    const broken = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'store:pg-broken',
      attemptId: 'pg-broken', postgres: [{ pool: 'real-hooks', client }] });
    expect(() => broken.run(() => client.options.onquerycontext!())).toThrow('original admission hook lost');
    expect(broken.seal().complete).toBe(false);
    broken.restore();
  });

  it('requires an exact reviewed statement, command and status for nonpersisting controls and failed reads', () => {
    const client = { options: {} } as unknown as postgres.Sql;
    const statements = [
      { query: 'begin ', command: 'BEGIN', status: 'ok', kind: 'control' },
      { query: "SELECT set_config('app.workspace_id', $1, true)", command: 'SELECT', status: 'ok', kind: 'control' },
      { query: 'WITH x AS (SELECT 1) SELECT * FROM x', command: 'SELECT', status: 'ok', kind: 'read' },
      { query: 'SELECT * FROM missing_fixture', command: null, status: 'error', kind: 'read' },
      { query: 'LISTEN dbos_notifications_channel;', command: 'LISTEN', status: 'ok', kind: 'control' },
      { query: "NOTIFY dbos_notifications_channel, 'dbos_listen_selftest'", command: 'NOTIFY', status: 'ok', kind: 'control' },
    ] as const;
    const registrations = statements.map(({ query, ...row }) => ({ ...row,
      queryHash: createHash('sha256').update(query).digest('hex'), sourceRef: 'review:bounded-fixture@source-sha256' }));
    const observe = (attemptId: string) => observeGroundedStoreOperations({ scope, deps: {}, operations: [],
      sourceRef: 'store:reviewed-control', attemptId, postgres: [{ pool: 'test', client }], nonPersistingSql: registrations });
    const terminal = (row: Pick<postgres.QueryResultDiagnostic, 'query' | 'command' | 'status'>,
      context: unknown, queryId: number): postgres.QueryResultDiagnostic => ({ ...row, context, queryId,
      connectionId: 1, backendPid: null, rowCount: 0, wireBytes: 0, elapsedMs: 1, preBuildMs: 0,
      errorCode: null, errorClass: null, serverRoutine: null });
    const tap = observe('exact');
    for (const [queryId, row] of statements.entries()) {
      const context = tap.run(() => client.options.onquerycontext!({ executed: true }));
      client.options.onresult!(terminal(row, context, queryId));
    }
    const input = captured(); input.storage = tap.seal();
    expect(input.storage.rows.map(row => row.kind)).toEqual(['control', 'control', 'read', 'read', 'control', 'control']);
    expect(input.storage.rows.every(row => row.sql?.nonPersisting?.sourceRef === registrations[0].sourceRef)).toBe(true);
    expect(measureGroundedEvidence(input).values).toMatchObject({ storageOperations: 6, storageBytes: 0 });
    tap.restore();
    for (const changed of [
      { ...statements[0], query: 'begin ; SELECT side_effect()' },
      { ...statements[1], query: "SELECT set_config('different.setting', $1, true)" },
      { ...statements[2], command: 'INSERT' },
      { ...statements[2], status: 'error' },
      { ...statements[3], status: 'ok', command: 'SELECT' },
      { ...statements[2], query: 'WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x' },
      { ...statements[4], query: 'LISTEN other_channel;' },
      { ...statements[4], command: 'NOTIFY' },
      { ...statements[4], status: 'error', command: null },
      { ...statements[5], query: "NOTIFY dbos_notifications_channel, 'changed_payload'" },
      { ...statements[5], query: statements[5].query + '; INSERT INTO t VALUES (1)' },
      { ...statements[5], status: 'error', command: null },
    ] as const) {
      const negative = observe('changed');
      const context = negative.run(() => client.options.onquerycontext!({ executed: true }));
      client.options.onresult!(terminal(changed, context, 99));
      input.storage = negative.seal();
      expect(input.storage.rows[0].kind).toBe('unknown');
      expect(measureGroundedEvidence(input).values.storageBytes).toBeNull();
      negative.restore();
    }
    const originalHook = client.options.onquerycontext;
    expect(() => observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'bad', attemptId: 'bad',
      postgres: [{ pool: 'test', client }], nonPersistingSql: [...registrations, registrations[0]] })).toThrow('duplicate');
    expect(client.options.onquerycontext).toBe(originalHook);
    for (const invalid of [
      { ...registrations[4], kind: 'read' },
      { ...registrations[4], status: 'error', command: null },
      { ...registrations[5], status: 'error' },
    ] as const) {
      expect(() => observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'bad', attemptId: 'bad',
        postgres: [{ pool: 'test', client }], nonPersistingSql: [invalid] })).toThrow('invalid nonpersisting');
      expect(client.options.onquerycontext).toBe(originalHook);
    }
  });

  it('retains only registered original SQL serialized strings before binding, including uncertain and mismatched writes', () => {
    const priorResult = vi.fn(), originalHook = () => 'prior';
    const client = { options: { onquerycontext: originalHook, onresult: priorResult } } as unknown as postgres.Sql;
    const template = ['INSERT INTO cache_l2(value) VALUES (', '::text::jsonb)'];
    const registration = { pool: 'cache', sourceRef: 'source:cache-writer@frozen-sha256', template,
      command: 'INSERT' as const, serializedArguments: [0] };
    const observe = (attemptId: string) => observeGroundedStoreOperations({ scope, deps: {}, operations: [],
      sourceRef: 'recorder:original-sql', attemptId, postgres: [{ pool: 'cache', client }],
      serializedSqlWrites: [registration], isReadOnlySql: row => row.command === 'SELECT' });
    expect(() => observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'bad', attemptId: 'bad',
      postgres: [{ pool: 'cache', client }], serializedSqlWrites: [registration, registration] })).toThrow('duplicate');
    expect(client.options.onquerycontext).toBe(originalHook);
    const tap = observe('original');
    const body = JSON.stringify({ value: 'λ.😺' });
    const original = { executed: true, tagged: true, strings: template, args: [body] };
    const context = tap.run(() => client.options.onquerycontext!(original));
    // Response/wire sizes cannot stand in for the original serialized value.
    client.options.onresult!({ context, queryId: 1, query: 'INSERT INTO cache_l2(value) VALUES ($1::text::jsonb)',
      command: 'INSERT', status: 'ok', wireBytes: 999999 } as postgres.QueryResultDiagnostic);
    const input = captured(); input.storage = tap.seal();
    expect(measureGroundedEvidence(input).values).toMatchObject({ storageOperations: 1, storageBytes: Buffer.byteLength(body) });
    expect(input.storage.rows[0]?.sql?.serializedWrite).toEqual({ sourceRef: registration.sourceRef,
      templateHash: createHash('sha256').update(canonicalJson(template)).digest('hex'),
      values: [{ argument: 0, sha256: createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body) }] });
    expect(priorResult.mock.calls[0]?.[0].context).toBe('prior');
    tap.restore();
    for (const control of ['opaque-object', 'different-template', 'error', 'wrong-command', 'mutated-argument'] as const) {
      const negative = observe(control);
      const query = { executed: true, tagged: true,
        strings: control === 'different-template' ? ['INSERT INTO another_cache(value) VALUES (', ')'] : template,
        args: [control === 'opaque-object' ? { value: 'λ.' } : body] };
      const admitted = negative.run(() => client.options.onquerycontext!(query));
      if (control === 'mutated-argument') query.args[0] = 'changed after admission';
      client.options.onresult!({ context: admitted, queryId: 2, query: 'INSERT INTO cache_l2(value) VALUES ($1)',
        command: control === 'wrong-command' ? 'UPDATE' : 'INSERT', status: control === 'error' ? 'error' : 'ok',
        wireBytes: 1 } as postgres.QueryResultDiagnostic);
      input.storage = negative.seal();
      expect(measureGroundedEvidence(input).values.storageBytes, control).toBeNull();
      expect(input.storage.complete).toBe(control !== 'wrong-command');
      negative.restore();
    }
  });

  it('captures node-postgres queued admissions and original Bind values once, preserving errors and lost terminals', () => {
    const statement = 'INSERT INTO original_values VALUES ($1, $2)', digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const serializerSourceRef = 'source:node-postgres/control#original-mapper';
    class Query {
      _results = { command: 'INSERT' };
      _canceledDueToError = false;
      constructor(readonly text: string, readonly values: unknown[]) {}
      submit(connection: { bind(config: { values: unknown[]; valueMapper(value: unknown, index: number): unknown }): void }) {
        connection.bind({ values: this.values, valueMapper(value) {
          return value === null ? null : typeof value === 'object' ? JSON.stringify(value) : String(value);
        } });
      }
      handleReadyForQuery() { return this._results; }
      handleError(error: Error) { return error; }
    }
    class Client {
      _queryQueue: Query[] = [];
      query(text: string, values: unknown[]) { const query = new Query(text, values); this._queryQueue.push(query); return query; }
      submit() { const query = this._queryQueue.shift()!;
        query.submit({ bind: config => { config.values.forEach((value, index) => config.valueMapper(value, index)); } }); return query; }
    }
    const originalQuery = Client.prototype.query, originalSubmit = Query.prototype.submit;
    const sqlObservations: import('./grounded-evidence-measurement').GroundedSqlObservation[] = [];
    const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'recorder:node-postgres-control',
      onSqlObservation: row => sqlObservations.push(row),
      attemptId: 'node-original', nodePostgres: [{ pool: 'dbos', clientPrototype: Client.prototype,
        queryPrototype: Query.prototype, serializerSourceRef }], serializedSqlParameters: [{ pool: 'dbos',
        sourceRef: 'source:original-writer', serializerSourceRef, queryHash: digest(statement), command: 'INSERT',
        parameterCount: 2, persistedParameters: [0, 1] }] });
    let serializations = 0;
    const client = new Client();
    try {
      // Different Client instances cover both a Pool's client and standalone
      // bootstrap clients. Admission precedes submit, so queue loss is visible.
      const bootstrap = new Client();
      const first = tap.run(() => client.query(statement, [{ toJSON: () => ({ original: `λ.${++serializations}` }) }, null]));
      const second = tap.run(() => bootstrap.query(statement, ['second', null]));
      const lost = tap.run(() => client.query(statement, ['lost', null]));
      client.query(statement, ['outside', null]);
      expect(client.submit()).toBe(first); expect(first.handleReadyForQuery()).toEqual({ command: 'INSERT' });
      expect(bootstrap.submit()).toBe(second); const failure = new Error('receipt lost');
      expect(second.handleError(failure)).toBe(failure);
      expect(client.submit()).toBe(lost);
      const census = tap.seal(), input = captured(); input.storage = census;
      expect(sqlObservations.filter(row => row.phase === 'admission').map(row => row.id)).toEqual(census.ids);
      expect(sqlObservations.every(row => row.pool === 'dbos' && row.query === statement)).toBe(true);
      expect(sqlObservations.filter(row => row.id === census.ids[0]).map(row => row.phase))
        .toEqual(['admission', 'submit', 'terminal']);
      expect(sqlObservations.filter(row => row.id === census.ids[1]).at(-1)).toMatchObject({ phase: 'terminal', status: 'error' });
      expect(sqlObservations.filter(row => row.id === census.ids[2]).map(row => row.phase))
        .toEqual(['admission', 'submit']);
      expect(sqlObservations.every((row, index) => Number.isFinite(row.monotonicMs)
        && (!index || row.monotonicMs >= sqlObservations[index - 1].monotonicMs))).toBe(true);
      expect(serializations).toBe(1);
      expect(census.ids).toHaveLength(3); expect(census.rows).toHaveLength(2);
      expect(census.diagnostics.pending).toBe(1); expect(census.complete).toBe(false);
      expect(census.rows.map(row => row.persistedBytes)).toEqual([Buffer.byteLength('{"original":"λ.1"}'), null]);
      expect(census.rows[0].sql?.serializedParameters?.values).toEqual([
        { parameter: 0, sha256: digest('{"original":"λ.1"}'), bytes: Buffer.byteLength('{"original":"λ.1"}') },
        { parameter: 1, sha256: null, bytes: 0 },
      ]);
      expect(measureGroundedEvidence(input).values.storageOperations).toBeNull();
      // A terminal after sealing is still retained; it cannot hide the error
      // write's uncertain bytes or drop the formerly pending operation.
      lost.handleReadyForQuery();
      const completed = tap.seal(); input.storage = completed;
      expect(completed.complete).toBe(true); expect(completed.rows).toHaveLength(3);
      expect(measureGroundedEvidence(input).values).toMatchObject({ storageOperations: 3, storageBytes: null });
    } finally { tap.restore(); }
    expect(Client.prototype.query).toBe(originalQuery); expect(Query.prototype.submit).toBe(originalSubmit);
  });

  it('preserves original SQL outcomes when diagnostic retention fails and refuses complete capture', () => {
    const client = { options: {} } as unknown as postgres.Sql;
    let priorResults = 0;
    client.options.onresult = () => { priorResults++; };
    const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'recorder:lost-sql-diagnostic',
      attemptId: 'lost-sql-diagnostic', postgres: [{ pool: 'fixture', client }],
      onSqlObservation: () => { throw new Error('diagnostic retention failed'); } });
    try {
      const query = { executed: true };
      const context = tap.run(() => client.options.onquerycontext!(query));
      expect(() => client.options.onresult!({ context, queryId: 1, query: 'SELECT 1',
        command: 'SELECT', status: 'ok', wireBytes: 1 } as postgres.QueryResultDiagnostic)).not.toThrow();
      expect(priorResults).toBe(1);
      expect(tap.seal()).toMatchObject({ complete: false, diagnostics: { pending: 0, captureFailed: true } });
      expect(tap.seal().rows).toHaveLength(1);
      expect(tap.seal().rows[0]).toMatchObject({ kind: 'unknown', persistedBytes: null });
    } finally { tap.restore(); }
  });

  it('refuses node-postgres driver replacement and a mismatched serializer pin before qualifying bytes', () => {
    class Query {
      text = 'INSERT INTO t VALUES ($1)'; values = ['λ.']; _results = { command: 'INSERT' };
      submit(connection: { bind(config: { values: unknown[]; valueMapper(value: unknown, index: number): unknown }): void }) {
        connection.bind({ values: this.values, valueMapper: value => String(value) });
      }
      handleReadyForQuery() {} handleError() {}
    }
    class Client {
      query() { const query = new Query(); query.submit({ bind(config) {
        config.values.forEach((value, index) => config.valueMapper(value, index));
      } }); return query; }
    }
    const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'recorder:node-pin-control',
      attemptId: 'node-pin', nodePostgres: [{ pool: 'dbos', clientPrototype: Client.prototype,
        queryPrototype: Query.prototype, serializerSourceRef: 'source:actual-mapper' }],
      serializedSqlParameters: [{ pool: 'dbos', sourceRef: 'source:writer', serializerSourceRef: 'source:OTHER-mapper',
        queryHash: createHash('sha256').update(new Query().text).digest('hex'), command: 'INSERT',
        parameterCount: 1, persistedParameters: [0] }] });
    const wrappedReady = Query.prototype.handleReadyForQuery;
    try {
      const query = tap.run(() => new Client().query()); query.handleReadyForQuery();
      expect(tap.seal().rows[0].persistedBytes).toBeNull();
      Query.prototype.handleReadyForQuery = () => {};
      expect(tap.seal().complete).toBe(false);
      Query.prototype.handleReadyForQuery = wrappedReady;
    } finally { tap.restore(); }
  });

  it('qualifies conditional node-postgres write bytes only for zero or the registered complete row outcome', () => {
    const statement = 'INSERT INTO conditional_values VALUES ($1) ON CONFLICT DO NOTHING';
    const body = 'λ.😺', serializerSourceRef = 'source:node-postgres/control#original-mapper';
    class Query {
      text = statement; values = [body]; _results: { command: string; rowCount: unknown };
      constructor(rowCount: unknown) { this._results = { command: 'INSERT', rowCount }; }
      submit(connection: { bind(config: { values: unknown[]; valueMapper(value: unknown, index: number): unknown }): void }) {
        connection.bind({ values: this.values, valueMapper: value => value });
      }
      handleReadyForQuery() {} handleError() {}
    }
    class Client {
      query(rowCount: unknown) { const query = new Query(rowCount); query.submit({ bind(config) {
        config.values.forEach((value, index) => config.valueMapper(value, index));
      } }); return query; }
    }
    for (const allOrNoneRows of [1, 2, 'zero-only'] as const) for (const count of [0, 1, 2, null, -1, 0.5, NaN, '1']) {
      const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'recorder:conditional-node',
        attemptId: 'conditional-node', nodePostgres: [{ pool: 'dbos', clientPrototype: Client.prototype,
          queryPrototype: Query.prototype, serializerSourceRef }], serializedSqlParameters: [{ pool: 'dbos',
          sourceRef: 'source:conditional-writer', serializerSourceRef,
          queryHash: createHash('sha256').update(statement).digest('hex'), command: 'INSERT',
          parameterCount: 1, persistedParameters: [0], allOrNoneRows }] });
      try {
        const query = tap.run(() => new Client().query(count)); query.handleReadyForQuery();
        const census = tap.seal(); expect(census.complete).toBe(true);
        expect(census.rows[0].persistedBytes, `${allOrNoneRows}/${count}`)
          .toBe(count === 0 ? 0 : count === allOrNoneRows ? Buffer.byteLength(body) : null);
        expect(census.rows[0].sql?.rowOutcome).toEqual({ allOrNoneRows,
          affectedRows: typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null });
      } finally { tap.restore(); }
    }
  });

  it('uses postgres CommandComplete counts for conditional parameter and tagged writes, never returned-row counts', () => {
    const body = 'λ.😺', template = ['INSERT INTO conditional_values VALUES (', ') ON CONFLICT DO NOTHING'];
    const statement = template.join('$1'), client = { options: {} } as unknown as postgres.Sql;
    for (const tagged of [false, true]) for (const allOrNoneRows of [1, 2, 'zero-only'] as const) {
      for (const count of [0, 1, 2, null, -1, 0.5, NaN, '1']) for (const failed of [false, true]) {
        const registration = { pool: 'conditional', sourceRef: 'source:conditional-writer', command: 'INSERT' as const,
          allOrNoneRows };
        const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'recorder:conditional-postgres',
          attemptId: 'conditional-postgres', postgres: [{ pool: 'conditional', client }],
          serializedSqlWrites: tagged ? [{ ...registration, template, serializedArguments: [0] }] : [],
          serializedSqlParameters: tagged ? [] : [{ ...registration, serializerSourceRef: 'source:original-Bind',
            queryHash: createHash('sha256').update(statement).digest('hex'), parameterCount: 1, persistedParameters: [0] }] });
        try {
          const query = { executed: true, tagged, strings: template, args: [body], options: { simple: false },
            statement: { string: statement }, parameters: [body] };
          const context = tap.run(() => client.options.onquerycontext!(query));
          // DataRow count is deliberately the OPPOSITE of the affected count.
          // A non-RETURNING INSERT has zero DataRows even when it persists data.
          client.options.onresult!({ context, queryId: 1, query: statement, command: 'INSERT',
            status: failed ? 'error' : 'ok', rowCount: count === 0 ? 1 : 0,
            result: Object.assign([], { command: 'INSERT', count }) } as postgres.QueryResultDiagnostic);
          const census = tap.seal(); expect(census.complete).toBe(true);
          expect(census.rows[0].persistedBytes, `${tagged}/${allOrNoneRows}/${count}/${failed}`)
            .toBe(failed ? null : count === 0 ? 0 : count === allOrNoneRows ? Buffer.byteLength(body) : null);
        } finally { tap.restore(); }
      }
    }
    for (const allOrNoneRows of [0, -1, 0.5, NaN]) {
      expect(() => observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'bad', attemptId: 'bad',
        postgres: [{ pool: 'conditional', client }], serializedSqlWrites: [{ pool: 'conditional', sourceRef: 'writer',
          template, command: 'INSERT', serializedArguments: [0], allOrNoneRows }] })).toThrow('invalid');
      expect(() => observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'bad', attemptId: 'bad',
        postgres: [{ pool: 'conditional', client }], serializedSqlParameters: [{ pool: 'conditional', sourceRef: 'writer',
          serializerSourceRef: 'mapper', queryHash: createHash('sha256').update(statement).digest('hex'),
          command: 'INSERT', parameterCount: 1, persistedParameters: [0], allOrNoneRows }] })).toThrow('invalid');
    }
  });

  it('refuses conditional byte qualification without an exact single terminal or original serialized values', () => {
    const template = ['INSERT INTO conditional_values VALUES (', ') ON CONFLICT DO NOTHING'];
    const statement = template.join('$1'), client = { options: {} } as unknown as postgres.Sql;
    const outcomes: unknown[] = [undefined, [], [{ command: 'INSERT', count: 1 }], { command: 'UPDATE', count: 1 },
      { command: 'INSERT', count: 0 }, { command: 'INSERT', count: 1 }];
    for (const tagged of [false, true]) for (const result of outcomes) {
      const registration = { pool: 'conditional', sourceRef: 'writer', command: 'INSERT' as const, allOrNoneRows: 1 };
      const tap = observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'recorder:conditional-premises',
        attemptId: 'conditional-premises', postgres: [{ pool: 'conditional', client }],
        serializedSqlWrites: tagged ? [{ ...registration, template, serializedArguments: [0] }] : [],
        serializedSqlParameters: tagged ? [] : [{ ...registration, serializerSourceRef: 'mapper',
          queryHash: createHash('sha256').update(statement).digest('hex'), parameterCount: 1, persistedParameters: [0] }] });
      try {
        let serializations = 0;
        const opaque = { toJSON() { serializations++; return 'not-an-original-string'; } };
        for (const value of ['λ.😺', opaque]) {
          const query = { executed: true, tagged, strings: template, args: [value], options: { simple: false },
            statement: { string: statement }, parameters: [value] };
          const context = tap.run(() => client.options.onquerycontext!(query));
          client.options.onresult!({ context, queryId: 1, query: statement, command: 'INSERT', status: 'ok',
            rowCount: 1, result } as postgres.QueryResultDiagnostic);
          const terminal = result as { command?: string; count?: number } | undefined;
          const expected = value === opaque || terminal?.command !== 'INSERT' ? null
            : terminal.count === 0 ? 0 : terminal.count === 1 ? Buffer.byteLength('λ.😺') : null;
          expect(tap.snapshot().rows.at(-1)?.persistedBytes).toBe(expected); expect(serializations).toBe(0);
        }
        expect(tap.seal().complete).toBe(true);
      } finally { tap.restore(); }
    }
  });

  it('retains actual driver serializer outputs for exact registered observation writes and refuses incomplete premises', () => {
    const client = { options: {} } as unknown as postgres.Sql;
    const statement = 'INSERT INTO observations VALUES ($1, $2, $3)',
      queryHash = createHash('sha256').update(statement).digest('hex');
    const registration = { pool: 'observations', sourceRef: 'source:observation-writer@sha256',
      serializerSourceRef: 'source:postgres/src/connection.js@sha256#Bind', queryHash,
      command: 'INSERT' as const, parameterCount: 3, persistedParameters: [0, 1, 2] };
    const observe = () => observeGroundedStoreOperations({ scope, deps: {}, operations: [],
      sourceRef: 'recorder:original-observation', attemptId: 'serialized-parameters',
      postgres: [{ pool: 'observations', client }], serializedSqlParameters: [registration] });
    const body = '{"original":"λ.😺"}';
    for (const control of ['original', 'object-not-serialized', 'missing', 'wrong-arity', 'changed-statement',
      'unregistered', 'wrong-command', 'error', 'simple', 'not-executed'] as const) {
      const tap = observe();
      let reserializations = 0;
      const opaque = { toJSON: () => { reserializations++; throw new Error('must not serialize twice'); } };
      const query = { executed: control !== 'not-executed', options: { simple: control === 'simple' },
        statement: { string: control === 'changed-statement' ? 'different statement' : statement },
        parameters: control === 'missing' ? undefined : control === 'wrong-arity' ? [body]
          : [control === 'object-not-serialized' ? opaque : body, 't', null] };
      const context = tap.run(() => client.options.onquerycontext!(query));
      client.options.onresult!({ context, queryId: 1,
        query: control === 'unregistered' ? 'INSERT INTO other VALUES ($1)' : statement,
        command: control === 'wrong-command' ? 'UPDATE' : 'INSERT',
        status: control === 'error' ? 'error' : 'ok', wireBytes: 999999 } as postgres.QueryResultDiagnostic);
      const input = captured(); input.storage = tap.seal();
      expect(reserializations).toBe(0);
      expect(measureGroundedEvidence(input).values.storageBytes, control)
        .toBe(control === 'original' ? Buffer.byteLength(body) + 1 : null);
      if (control === 'original') expect(input.storage.rows[0].sql?.serializedParameters).toMatchObject({
        sourceRef: registration.sourceRef, serializerSourceRef: registration.serializerSourceRef, parameterCount: 3,
        values: [{ parameter: 0, bytes: Buffer.byteLength(body) }, { parameter: 1, bytes: 1 },
          { parameter: 2, bytes: 0, sha256: null }],
      });
      tap.restore();
    }
    expect(() => observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'bad', attemptId: 'bad',
      postgres: [{ pool: 'observations', client }], serializedSqlParameters: [registration, registration] })).toThrow('duplicate');
    expect(() => observeGroundedStoreOperations({ scope, deps: {}, operations: [], sourceRef: 'bad', attemptId: 'bad',
      postgres: [{ pool: 'observations', client }], serializedSqlParameters: [{ ...registration, persistedParameters: [3] }] }))
      .toThrow('invalid');
  });

  it('excludes independently unexecuted SQL fragments while retaining missing driver state and lost terminals as unknown', () => {
    const priorContext = vi.fn(() => 'prior');
    const client = { options: { onquerycontext: priorContext } } as unknown as postgres.Sql;
    const observe = (attemptId: string) => observeGroundedStoreOperations({ scope, deps: {}, operations: [],
      sourceRef: 'store:fragment-control', attemptId, postgres: [{ pool: 'control', client }],
      isReadOnlySql: () => true });
    const tap = observe('fragments'), fragment = { executed: false }, executed = { executed: false };
    const context = tap.run(() => {
      client.options.onquerycontext!(fragment);
      return client.options.onquerycontext!(executed);
    });
    const admitted = tap.snapshot();
    expect(admitted).toMatchObject({ complete: false, diagnostics: { pending: 2, excludedUnexecutedIds: [] } });
    expect(admitted.ids).toHaveLength(2); expect(admitted.rows).toHaveLength(0);
    // A caller cannot mutate a retained snapshot into the recorder's state.
    admitted.ids = []; admitted.diagnostics.admissions.length = 0;
    executed.executed = true;
    client.options.onresult!({ context, queryId: 1, query: 'SELECT 1', command: 'SELECT', status: 'ok' } as postgres.QueryResultDiagnostic);
    expect(priorContext.mock.calls.map(call => (call as unknown[])[0])).toEqual([fragment, executed]);
    const census = tap.seal();
    expect(census.complete).toBe(true);
    expect(census.diagnostics.admissions).toHaveLength(2);
    expect(census.ids).toEqual(census.rows.map(row => row.id));
    expect(census.diagnostics.excludedUnexecutedIds).toHaveLength(1);
    tap.restore();
    expect(tap.seal().complete).toBe(true);
    const lost = observe('executed-without-terminal');
    lost.run(() => client.options.onquerycontext!({ executed: true }));
    expect(lost.seal()).toMatchObject({ complete: false, diagnostics: { pending: 1, excludedUnexecutedIds: [] } });
    lost.restore();
    const older = observe('older-driver');
    const oldContext = older.run(() => client.options.onquerycontext!());
    client.options.onresult!({ context: oldContext, queryId: 2, query: 'SELECT 1', command: 'SELECT', status: 'ok' } as postgres.QueryResultDiagnostic);
    const input = captured(); input.storage = older.seal();
    expect(input.storage.complete).toBe(false);
    expect(measureGroundedEvidence(input).values.storageOperations).toBeNull();
    older.restore();
  });

  it('captures actual dispatch attempts, original arguments, purposes and incomplete child work', async () => {
    const registration = { 'plans:get': { purpose: 'retrieval' as const, purposeRef: 'registration:plans:get' } };
    const calls: string[] = [];
    let finish!: () => void;
    const child = new Promise<void>(resolve => { finish = resolve; });
    const tap = observeGroundedToolDispatch({ scope, sourceRef: 'dispatch:consumer-control', attemptId: 'consumer',
      boundary: 'consumer', originRef: 'transport:public-control', registrations: registration,
      dispatch: async (tool, args, fail: boolean) => {
        calls.push(tool);
        if (tool === 'child') await child;
        if (fail) throw new Error('original dispatch failure');
        (args as { slug: string }).slug = 'mutated-by-handler';
        return 'result';
      } });
    for (const fail of [false, true]) {
      const call = tap.dispatch('plans:get', { slug: 'original' }, fail);
      if (fail) await expect(call).rejects.toThrow('original dispatch failure');
      else expect(await call).toBe('result');
    }
    const input = captured(); input.invocations = tap.seal();
    expect(calls).toEqual(['plans:get', 'plans:get']);
    expect(input.invocations.rows.map(row => row.args)).toEqual([{ slug: 'original' }, { slug: 'original' }]);
    expect(measureGroundedEvidence(input).values).toMatchObject({ foregroundLookups: 2, retrievalCalls: 2, repeatedCalls: 1 });
    const pending = tap.dispatch('child', { slug: 'original' }, false);
    expect(tap.seal().complete).toBe(false);
    finish(); await pending;
    input.invocations = tap.seal();
    expect(input.invocations.complete).toBe(false);
    expect(measureGroundedEvidence(input).values.foregroundLookups).toBeNull();
  });

  it('keeps unregistered dispatch purposes unknown and excludes control traffic from foreground reads', async () => {
    const create = (boundary: 'consumer' | 'control') => observeGroundedToolDispatch({ scope,
      sourceRef: 'dispatch:purpose-control', attemptId: boundary, boundary, originRef: 'transport:purpose-control',
      registrations: { 'plans:get': { purpose: 'retrieval', purposeRef: 'registration:plans:get' } },
      dispatch: async () => 'ok' });
    const control = create('control'); await control.dispatch('plans:get', {});
    const input = captured(); input.invocations = control.seal();
    expect(measureGroundedEvidence(input).values).toMatchObject({ foregroundLookups: 0, retrievalCalls: 0 });
    const unknown = create('consumer'); await unknown.dispatch('toString', {});
    input.invocations = unknown.seal();
    expect(input.invocations.rows[0]?.purpose).toBe('unknown');
    expect(measureGroundedEvidence(input).values.retrievalCalls).toBeNull();
  });

  it('preserves dispatch behavior while marking uncloneable arguments as incomplete capture', async () => {
    const args = { callback: () => 'original callback' };
    const original = vi.fn(async (_tool: string, actual: unknown) => actual);
    const tap = observeGroundedToolDispatch({ scope, dispatch: original,
      sourceRef: 'dispatch:uncloneable-control', attemptId: 'uncloneable', boundary: 'consumer', originRef: 'transport:uncloneable',
      registrations: { 'plans:get': { purpose: 'retrieval', purposeRef: 'registration:plans:get' } } });
    expect(await tap.dispatch('plans:get', args)).toBe(args);
    expect(original).toHaveBeenCalledWith('plans:get', args);
    const input = captured(); input.invocations = tap.seal();
    expect(input.invocations.complete).toBe(false);
    expect(measureGroundedEvidence(input).values.foregroundLookups).toBeNull();
  });

  it('retains child dispatch admissions before a pending handler and isolates snapshots from later settlement', async () => {
    let settle!: (value: string) => void;
    let observed!: ReturnType<typeof observeGroundedToolDispatch<[], string>>;
    const snapshots: ReturnType<typeof observed.snapshot>[] = [];
    observed = observeGroundedToolDispatch({ scope, sourceRef: 'dispatch:producer-death', attemptId: 'producer',
      boundary: 'internal', originRef: 'runtime:live-dispatch',
      registrations: { 'items:get': { purpose: 'retrieval', purposeRef: 'registered-fixture:items:get' } },
      onObservation: () => snapshots.push(observed.snapshot()),
      dispatch: async () => {
        expect(snapshots).toHaveLength(1);
        return new Promise<string>(resolve => { settle = resolve; });
      } });
    const args = { k: 1 }, pending = observed.dispatch('items:get', args);
    args.k = 2;
    expect(snapshots[0]).toMatchObject({ complete: false, rows: [], diagnostics: { pending: 1,
      admissions: [{ tool: 'items:get', args: { k: 1 }, boundary: 'internal', purpose: 'retrieval' }] } });
    expect(snapshots[0].diagnostics.pendingIds).toEqual(snapshots[0].ids);
    const tampered = observed.snapshot();
    (tampered.diagnostics.admissions[0].args as { k: number }).k = 999;
    tampered.ids.length = 0;
    settle('original result'); expect(await pending).toBe('original result');
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0].rows).toEqual([]);
    expect(snapshots[1]).toMatchObject({ complete: false, diagnostics: { pending: 0, pendingIds: [] } });
    const input = captured(); input.invocations = observed.seal();
    expect(input.invocations.complete).toBe(true);
    expect(input.invocations.rows[0].args).toEqual({ k: 1 });
    expect(measureGroundedEvidence(input).values).toMatchObject({ retrievalCalls: 1, foregroundLookups: 0 });
  });

  it('preserves dispatch behavior but refuses qualification after an original snapshot retention failure', async () => {
    const observed = observeGroundedToolDispatch({ scope, sourceRef: 'dispatch:retention-failure', attemptId: 'failure',
      boundary: 'internal', originRef: 'runtime:live-dispatch', registrations: {},
      onObservation: () => { throw new Error('original recorder unavailable'); }, dispatch: async () => 'original result' });
    expect(await observed.dispatch('items:get', {})).toBe('original result');
    expect(observed.seal()).toMatchObject({ complete: false, diagnostics: { pending: 0, captureFailed: true } });
  });

  it('retains incomplete producer snapshots without closing durable admission or sharing mutable rows', async () => {
    let settle!: (value: string) => void;
    const observed = observeGroundedDurableHost({ scope, sourceRef: 'host:producer-death', attemptId: 'producer',
      host: { async runStep<R>(_name: string, fn: () => Promise<R>) { return fn(); } } });
    const pending = observed.host.runStep('pending', () => new Promise<string>(resolve => { settle = resolve; }));
    const crash = observed.snapshot();
    expect(crash).toMatchObject({ complete: false, ids: ['producer:durable:1:pending'], rows: [] });
    const input = captured(); input.durable = crash;
    expect(measureGroundedEvidence(input).values.durableSteps).toBeNull();
    settle('original result');
    expect(await pending).toBe('original result');
    const settled = observed.snapshot();
    expect(settled.complete).toBe(false);
    expect(crash.rows).toEqual([]);
    settled.rows[0]!.source = 'recorded';
    await observed.host.runStep('next', async () => 'next original result');
    expect(observed.seal()).toMatchObject({ complete: true, rows: [
      { source: 'live' }, { source: 'live' },
    ] });
  });

  it('captures host step replay without repeating the original callback and discloses failed steps', async () => {
    const saved = new Map<string, unknown>();
    const original = { async runStep<R>(name: string, fn: () => Promise<R>): Promise<R> {
      if (saved.has(name)) return saved.get(name) as R;
      const value = await fn(); saved.set(name, value); return value;
    } };
    const observed = observeGroundedDurableHost({ scope, host: original, sourceRef: 'host:unit', attemptId: 'attempt1' });
    const callback = vi.fn(async () => 'original-result');
    expect(await observed.host.runStep('read', callback)).toBe('original-result');
    expect(await observed.host.runStep('read', callback)).toBe('original-result');
    expect(callback).toHaveBeenCalledTimes(1);
    const capture = observed.seal();
    expect(capture.rows.map(row => row.source)).toEqual(['live', 'recorded']);
    const input = captured(); input.durable = capture;
    expect(measureGroundedEvidence(input).values.durableSteps).toBe(2);
    const failed = observeGroundedDurableHost({ scope, host: original, sourceRef: 'host:failure', attemptId: 'attempt2' });
    await expect(failed.host.runStep('failure', async () => { throw new Error('original failure'); })).rejects.toThrow('original failure');
    input.durable = failed.seal();
    expect(measureGroundedEvidence(input).values.durableSteps).toBeNull();
  });
});

describe('current authority scenario matrix', () => {
  it('serializes current spec, decision, correction, completion and ownership before stale carry', () => {
    const brief = buildBoundedPriorAttemptBrief(
      compilePriorAttempts([
        {
          scope: 'goal-wide',
          authority: 'checkpoint',
          rawRef: 'goal-history#stale-carry',
          text: 'STALE CARRY: use the obsolete stop condition and prior owner.',
        },
        {
          scope: 'goal-wide',
          authority: 'lifecycle',
          rawRef: 'WI-1#lifecycle:ownership',
          text: 'CURRENT OWNERSHIP: transferred to su-current.',
        },
        {
          scope: 'goal-wide',
          authority: 'verified-completion',
          rawRef: 'WI-1#completion',
          text: 'CURRENT COMPLETION: the obsolete attempt is finished.',
        },
        {
          scope: 'goal-wide',
          authority: 'retraction',
          rawRef: 'goal:goal-history#comment:correction',
          text: 'CORRECTION: retract the obsolete premise.',
        },
        {
          scope: 'plan-wide',
          authority: 'plan-decision',
          rawRef: 'plan-history#D-002',
          text: 'CURRENT DECISION: preserve the corrected route.',
        },
        {
          scope: 'same-spec',
          authority: 'current-spec',
          rawRef: 'plan-history#SPEC-001@2',
          text: 'CURRENT SPEC: stale carry never overrides canonical state.',
        },
      ]),
    );
    expect(brief).not.toBeNull();
    const serialized = JSON.stringify(brief);
    const assertCurrentBeforeCarry = (output: string) => {
      const stale = output.indexOf('STALE CARRY');
      expect(stale).toBeGreaterThanOrEqual(0);
      for (const current of [
        'CURRENT SPEC',
        'CURRENT DECISION',
        'CORRECTION',
        'CURRENT COMPLETION',
        'CURRENT OWNERSHIP',
      ]) {
        expect(output.indexOf(current), current).toBeGreaterThanOrEqual(0);
        expect(output.indexOf(current), current).toBeLessThan(stale);
      }
    };
    assertCurrentBeforeCarry(serialized);
    // Permanent negative control: the same oracle must reject a final sink
    // that prepends stale carry ahead of every current authority record.
    expect(() => assertCurrentBeforeCarry(`STALE CARRY precedes authority\n${serialized}`)).toThrow();
  });
});

const target = { kind: 'plan' as const, ref: 'plan-history', harness: 'papercusp' };
function tree(count = 2): ContainmentTree {
  return {
    root: { ...target, depth: 0 },
    ancestors: [],
    descendants: Array.from({ length: count }, (_, i) => ({
      kind: 'work_item' as const,
      ref: `WI-${i + 1}`,
      harness: 'papercusp',
      depth: 1,
    })),
    omittedDescendants: [],
    omittedDescendantsTruncated: false,
    fanOut: { admitted: count, total: count, cap: 24, truncated: false },
    descended: true,
  };
}
function dependencies() {
  return {
    getPlan: vi.fn(async () => ({
      content:
        '## Decisions\n\n### D-001 — Keep the current correction\nDate: 2026-09-07\nDo not repeat the obsolete approach.',
    })),
    specs: vi.fn(async () => []),
    edges: vi.fn(async () => []),
    evidence: vi.fn(async () => []),
    item: vi.fn(
      async (id: string) =>
        ({
          id,
          family: 'feature',
          harness: 'papercusp',
          payload: {},
          sourcePlanSlug: 'plan-history',
          sourcePlanItemIds: [],
          updatedAt: '2026-09-07T00:00:00Z',
        }) as unknown as WorkItem,
    ),
    items: vi.fn(async () => [{ id: 'WI-unrelated' } as WorkItem]),
    checkpoint: vi.fn(async ({ workItemId }: { workItemId: string }) => ({
      checkpoint: `Outcome: ${workItemId} repaired the original defect. Root cause: cursor advanced before delivery. Residue: verify shipment.`,
      updatedAtMs: Date.parse('2026-09-07T00:00:00Z'),
    })),
    thread: vi.fn(async () => null),
    lifecycle: vi.fn(async () => null),
    priorWork: vi.fn(async () => null),
    goalHistory: vi.fn(
      async (_input: { workspaceId: string; goalId: string; limit?: number }): Promise<GoalHistoryRead> => ({
        entries: [],
        truncated: false,
        limit: 100,
        omittedEntryIds: [],
        omittedEntryIdsTruncated: false,
      }),
    ),
    goalHistoryByIds: vi.fn(
      async (_input: {
        workspaceId: string;
        goalId: string;
        ids: readonly string[];
      }): Promise<GoalHistoryEntry[]> => [],
    ),
  };
}
beforeEach(() => {
  reads.tree.mockReset().mockResolvedValue(tree());
  reads.thread.mockReset().mockResolvedValue([
    {
      id: 'own-1',
      body: 'Outcome: preserve the plan lesson.',
      created_ts: '2026-09-07T00:00:00Z',
      author_id: 'su-test',
    },
  ]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('plan history production projection', () => {
  it.each(['plan', 'goal'] as const)('enforces the existing %s consumer budget and returns unknown with recovery at its deadline', async (kind) => {
    vi.useFakeTimers();
    reads.tree.mockImplementation(() => new Promise(() => {}));
    const deps = dependencies();
    const reader = vi.fn((opts: Parameters<typeof getContainmentRollupBrief>[0]) =>
      getContainmentRollupBrief(opts, deps as never));
    const pending = kind === 'plan'
      ? readPlanHistoryContext(target.ref, target.harness, reader)
      : readGoalHistoryContext('goal-history', reader);
    expect(reader).toHaveBeenCalledWith(expect.objectContaining({
      budget: { maxChars: 6_000, maxRecords: 16, maxTextChars: 400 },
      maxDescendants: 24,
      timeoutMs: 2_500,
    }));
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      status: 'unknown', brief: null,
      recovery: kind === 'plan'
        ? { tool: 'plans:get', args: { slug: target.ref, harness: target.harness, heading: 'History' } }
        : { tool: 'goals:get', args: { id: 'goal-history', detail: 'full' } },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['plan', 'goal', 'child-plan'] as const)('keeps failed %s learned-history reads unknown and recovers through the same reader', async (kind) => {
    const goalTarget = { kind: 'goal' as const, ref: 'goal-history' };
    if (kind !== 'plan') {
      reads.tree.mockResolvedValue({
        ...tree(0),
        root: { ...goalTarget, depth: 0 },
        descendants: kind === 'child-plan'
          ? [{ kind: 'plan', ref: 'plan-child', harness: 'papercusp', depth: 1 }]
          : [],
      });
    } else reads.tree.mockResolvedValue(tree(0));
    const deps = dependencies();
    const failedRef = kind === 'plan' ? target.ref : kind === 'goal' ? goalTarget.ref : 'plan-child';
    reads.thread.mockImplementation(async (ref: { ref: string }) => {
      if (ref.ref === failedRef) throw new Error('stored effort history unavailable');
      return [];
    });
    const read = () => kind === 'plan'
      ? readPlanHistoryContext(target.ref, target.harness, opts => getContainmentRollupBrief(opts, deps as never))
      : readGoalHistoryContext(goalTarget.ref, opts => getContainmentRollupBrief(opts, deps as never));
    const failed = await read();
    expect(failed.status).toBe('unknown');
    expect(failed.brief?.degradedSources).toContain(
      kind === 'child-plan' ? 'plan-thread:plan-child' : `${kind}-thread`,
    );
    expect(failed.recovery).toEqual(kind === 'plan'
      ? { tool: 'plans:get', args: { slug: target.ref, harness: target.harness, heading: 'History' } }
      : { tool: 'goals:get', args: { id: goalTarget.ref, detail: 'full' } });

    reads.thread.mockResolvedValue([{
      id: 'recovered-note',
      body: 'False premise: history was empty. Root cause: the thread read failed. Residue: verify the next depth.',
      created_ts: '2026-09-07T00:00:00Z',
      author_id: 'su-test',
    }]);
    const recovered = await read();
    expect(recovered.status).toBe('available');
    expect(recovered.brief?.degradedSources).toEqual([]);
    expect(JSON.stringify(recovered)).toContain('history was empty');
    expect(JSON.stringify(recovered)).toContain(`#comment:recovered-note`);
    expect(recovered.recovery).toEqual(failed.recovery);
  });

  it('delivers the plan and child lessons from one bounded tree read', async () => {
    const deps = dependencies();
    const history = await readPlanHistoryContext(target.ref, target.harness, (opts) =>
      getContainmentRollupBrief(opts, deps as never),
    );
    const serialized = JSON.stringify(history);
    expect(history.status).toBe('available');
    expect(serialized).toContain('preserve the plan lesson');
    expect(serialized).toContain('WI-1 repaired the original defect');
    expect(serialized).toContain('cursor advanced before delivery');
    expect(serialized).toContain('verify shipment');
    expect(serialized).not.toContain('WI-unrelated');
    expect(reads.tree).toHaveBeenCalledTimes(1);
    expect(reads.tree).toHaveBeenCalledWith(target, expect.objectContaining({ direction: 'down', maxDescendants: 24 }));
    expect(deps.items).not.toHaveBeenCalled();
    expect(deps.thread).not.toHaveBeenCalled();
    expect(deps.checkpoint).toHaveBeenCalledTimes(2);
    expect(history.recovery).toEqual({
      tool: 'plans:get',
      args: { slug: target.ref, harness: target.harness, heading: 'History' },
    });
  });

  it('distinguishes successful empty history from unreadable relationships and sources', async () => {
    const deps = dependencies();
    deps.getPlan.mockResolvedValue({ content: '## Now\nNo prior attempts.' });
    reads.tree.mockResolvedValue(tree(0));
    reads.thread.mockResolvedValue([]);
    const empty = await getContainmentRollupBrief({ target }, deps as never);
    expect(empty?.status).toBe('empty');
    reads.tree.mockResolvedValue({ ...tree(0), unavailable: 'read-failed' });
    expect((await getContainmentRollupBrief({ target }, deps as never))?.status).toBe('unknown');
    reads.tree.mockResolvedValue(tree(0));
    deps.getPlan.mockRejectedValue(new Error('plan unavailable'));
    const failed = await getContainmentRollupBrief({ target }, deps as never);
    expect(failed?.status).toBe('unknown');
    expect(failed?.degradedSources).toContain('plan');
  });

  it('includes containment resolution inside the deadline and clears the timer', async () => {
    vi.useFakeTimers();
    reads.tree.mockImplementation(() => new Promise(() => {}));
    const pending = getContainmentRollupBrief({ target, timeoutMs: 100 }, dependencies() as never);
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a large history and recovers a child record at full resolution', async () => {
    const deps = dependencies();
    reads.tree.mockResolvedValue({
      ...tree(24),
      fanOut: { admitted: 24, total: 100, cap: 24, truncated: true },
      omittedDescendants: [{ kind: 'work_item', ref: 'WI-25', harness: 'papercusp' }],
    });
    deps.checkpoint.mockImplementation(async ({ workItemId }) => ({
      checkpoint: `Outcome: ${workItemId} fixed. Root cause: ${'long cause '.repeat(200)}. Residue: final retained obligation.`,
      updatedAtMs: 1,
    }));
    const brief = await getContainmentRollupBrief(
      { target, budget: { maxChars: 6000, maxTextChars: 100 } },
      deps as never,
    );
    expect(JSON.stringify(brief).length).toBeLessThan(8000);
    expect(brief?.omission.truncated).toBe(true);
    expect(brief?.fanOut.truncated).toBe(true);
    const recovered = await resolvePriorAttemptRefs(
      { target, harness: 'papercusp', rawRefs: ['WI-1#checkpoint', 'WI-unrelated#checkpoint'] },
      deps as never,
    );
    expect(recovered?.records[0]?.text).toContain('final retained obligation');
    expect(recovered?.records[0]?.text.length).toBeGreaterThan(2000);
    expect(recovered?.unresolved).toEqual(['WI-unrelated#checkpoint']);
  });

  it('keeps ordinary member history ancestor-only', async () => {
    const deps = dependencies();
    reads.tree.mockResolvedValue({ ...tree(0), root: { kind: 'work_item', ref: 'WI-1', depth: 0 }, descended: false });
    await collectPriorAttempts({ workItemId: 'WI-1', harnessSlug: 'papercusp' }, deps as never);
    expect(reads.tree).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'work_item' }),
      expect.objectContaining({ direction: 'up' }),
    );
    expect(deps.checkpoint).toHaveBeenCalledTimes(1);
  });
});

describe('exact scoped history recovery', () => {
  it.each(['plan', 'goal'] as const)('recovers admitted %s comments without a synthetic work-item lookup', async (kind) => {
    const scopedTarget = { kind, ref: kind === 'plan' ? target.ref : 'goal-history', harness: 'papercusp' };
    reads.tree.mockResolvedValue({ ...tree(0), root: { ...scopedTarget, depth: 0 } });
    const archive = {
      id: 1, thread_id: `${kind}-admitted-thread`, author_id: 'su-original',
      body: `Original ${kind} archive: ${'preserved λ '.repeat(400)}`.trimEnd(),
      created_ts: '2026-09-07T00:00:00Z',
    };
    reads.thread.mockResolvedValue([{ ...archive, id: 2, body: 'Recent admitted post' }]);
    const threadPost = vi.fn(async ({ postId }: { workspaceId: string; postId: number }) =>
      postId === 1 ? archive : postId === 404 ? { ...archive, id: 404, thread_id: 'foreign-thread' } : null,
    );
    const deps = dependencies();
    const prefix = `${kind}:${scopedTarget.ref}#comment:`;
    const resolved = await resolvePriorAttemptRefs(
      { target: scopedTarget, harness: 'papercusp', rawRefs: [`${prefix}1`, `${prefix}404`, `${prefix}405`] },
      { ...deps, threadPost } as never,
    );
    expect(resolved?.records).toEqual([expect.objectContaining({
      rawRef: `${prefix}1`, text: archive.body, actor: archive.author_id,
    })]);
    expect(resolved?.unresolved).toEqual([`${prefix}404`, `${prefix}405`]);
    expect(deps.item).not.toHaveBeenCalled();
    expect(deps.thread).not.toHaveBeenCalled();
    expect(threadPost.mock.calls.map(([input]) => input.postId)).toEqual([1, 404, 405]);
    expect(threadPost.mock.calls.every(([input]) => Boolean(input.workspaceId))).toBe(true);
  });
});

describe('goal history production projection', () => {
  it('delivers goal-owned audit history plus bounded plan/item descendants with goal recovery', async () => {
    const goalTarget = { kind: 'goal' as const, ref: 'goal-history' };
    reads.tree.mockResolvedValue({
      root: { ...goalTarget, depth: 0 },
      ancestors: [],
      descendants: [
        { kind: 'plan', ref: 'plan-child', harness: 'papercusp', depth: 1 },
        { kind: 'work_item', ref: 'WI-1', harness: 'papercusp', depth: 2 },
      ],
      omittedDescendants: [{ kind: 'work_item', ref: 'WI-25', harness: 'papercusp' }],
      omittedDescendantsTruncated: false,
      fanOut: { admitted: 2, total: 25, cap: 24, truncated: true },
      descended: true,
    });
    const deps = dependencies();
    deps.goalHistory.mockResolvedValue({
      entries: [
        {
          id: 'goal-history-1',
          kind: 'amendment',
          author: 'su-goal',
          at: '2026-09-07T00:00:00Z',
          reason: 'new evidence corrected the stop condition',
          reasonSource: 'caller',
          changes: [{ field: 'killCriterion', before: 'old', after: 'current' }],
        },
      ],
      truncated: false,
      limit: 100,
      omittedEntryIds: [],
      omittedEntryIdsTruncated: false,
    });

    const history = await readGoalHistoryContext(goalTarget.ref, (opts) =>
      getContainmentRollupBrief(opts, deps as never),
    );
    const serialized = JSON.stringify(history);
    expect(history.status).toBe('available');
    expect(serialized).toContain('new evidence corrected the stop condition');
    expect(serialized).toContain('Keep the current correction');
    expect(serialized).toContain('preserve the plan lesson');
    expect(serialized).toContain('WI-1 repaired the original defect');
    expect(history.brief?.fanOut).toMatchObject({ total: 25, truncated: true });
    expect(reads.tree).toHaveBeenCalledWith(
      goalTarget,
      expect.objectContaining({ direction: 'down', maxDescendants: 24 }),
    );
    expect(history.recovery).toEqual({ tool: 'goals:get', args: { id: goalTarget.ref, detail: 'full' } });
  });

  it('discloses and recovers goal-history rows beyond the 25-row inline collector page', async () => {
    const goalTarget = { kind: 'goal' as const, ref: 'goal-history' };
    reads.tree.mockResolvedValue({
      root: { ...goalTarget, depth: 0 },
      ancestors: [],
      descendants: [],
      omittedDescendants: [],
      omittedDescendantsTruncated: false,
      fanOut: { admitted: 0, total: 0, cap: 24, truncated: false },
      descended: true,
    });
    const entries = Array.from(
      { length: 27 },
      (_, i): GoalHistoryEntry => ({
        id: `goal-row-${i + 1}`,
        kind: 'evidence',
        author: 'su-goal',
        at: new Date(Date.UTC(2026, 8, 7, 0, 0, 27 - i)).toISOString(),
        summary: `goal evidence ${i + 1}`,
      }),
    );
    const deps = dependencies();
    deps.goalHistory.mockImplementation(async ({ limit = 25 }: { limit?: number }) => ({
      entries: entries.slice(0, limit),
      truncated: entries.length > limit,
      limit,
      omittedEntryIds: entries.slice(limit).map((entry) => entry.id),
      omittedEntryIdsTruncated: false,
    }));
    deps.goalHistoryByIds.mockImplementation(async ({ ids }: { ids: readonly string[] }) =>
      entries.filter((entry) => ids.includes(entry.id)),
    );

    const history = await readGoalHistoryContext(goalTarget.ref, (opts) =>
      getContainmentRollupBrief(opts, deps as never),
    );
    expect(history.brief?.goalHistory).toMatchObject({
      admitted: 25,
      limit: 25,
      truncated: true,
      omittedRecordsLowerBound: 2,
      omittedRefsTruncated: false,
    });
    expect(history.brief?.omission.omittedRefs.map((entry) => entry.rawRef)).toEqual(
      expect.arrayContaining(['goal:goal-history#history:goal-row-26', 'goal:goal-history#history:goal-row-27']),
    );

    const recovered = await resolvePriorAttemptRefs(
      {
        target: goalTarget,
        rawRefs: ['goal:goal-history#history:goal-row-20', 'goal:goal-history#history:goal-row-27'],
      },
      deps as never,
    );
    expect(recovered?.records.map((record) => record.rawRef)).toEqual([
      'goal:goal-history#history:goal-row-20',
      'goal:goal-history#history:goal-row-27',
    ]);
    expect(recovered?.unresolved).toEqual([]);
  });
});
