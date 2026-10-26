import { describe, expect, it, vi } from 'vitest';
import {
  DEFERRED_SPEND_ACCEPTANCE_PLAN as plan, DEFERRED_SPEND_INSTRUMENT_KEYS as keys,
  measureDeferredSpendAcceptance, collectDeferredSpendAcceptanceEvidence, type DeferredSpendAcceptanceInputs,
} from './deferred-spend-acceptance-instruments';
import {
  deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint, evaluateDeferredSpendEvidence,
} from './deferred-spend-acceptance-contract';
import { deferredSpendSourceHash, deferredSpendSourceManifest } from './deferred-spend-source-census';
import { DEFERRED_SPEND_RETAINED_RUNS } from './deferred-spend-population';
import { DEFERRED_SPEND_ACTION_STREAMS, type DeferredSpendActionRecord,
  type DeferredSpendActionLineage, type DeferredSpendActionStream } from './deferred-spend-action-boundary';
import { getRegisteredInstrument } from '../rubric-instrument-registry';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';
import type { Rubric } from '../rubrics';

const start = '2026-10-25T19:00:00Z', end = '2026-10-25T20:00:00Z', at = '2026-10-25T20:00:02Z';
type Mutable<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer E)[] ? Mutable<E>[]
  : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function fixture() {
  const provenance = { method: 'reviewed-source-read', selector: 'independent-base-candidate', evidenceRefs: ['review:selectors'] };
  const base = 'a'.repeat(40), candidate = 'b'.repeat(40);
  const request = { workspaceId: 'ws', harness: 'papercusp', planSlug: plan as typeof plan, rubricRef: 'acceptance-deferred-spend',
    rubricRevision: 7, criteriaHash: 'c'.repeat(64), subjectRef: plan, windowStart: start, windowEnd: end };
  const scope = { workspaceId: request.workspaceId, harness: request.harness, planSlug: plan,
    rubricRef: request.rubricRef, rubricRevision: 7, criteriaHash: request.criteriaHash };
  const files = [
    { revision: candidate, path: 'tsconfig.json', text: JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts'] }), contentHash: '' },
    { revision: candidate, path: 'src/collector.ts', text: "export function collect() { return 'consistent-read-only'; }", contentHash: '' },
  ];
  for (const file of files) file.contentHash = deferredSpendSourceHash(file.text);
  const members = files.filter(file => file.path.startsWith('src/')).map(({ path, contentHash }) => ({ path, contentHash }));
  const tsconfigs = [{ path: 'tsconfig.json', contentHash: files[0].contentHash, provenance }];
  const projectConfiguration = { tsconfigs, projectReferences: [], provenance,
    contentHash: deferredSpendFingerprint({ tsconfigs, projectReferences: [] }) };
  const migrationRegistry = { revision: candidate, entries: [], contentHash: deferredSpendFingerprint([]), provenance };
  const sourceIdentity = deferredSpendEvidenceIdentitySchema.parse({ schemaVersion: 'deferred-spend-evidence-v1', scope,
    subject: { kind: 'source', ref: plan }, observation: { id: 'observation', observedAt: at,
      window: { startAt: start, endAt: end }, serving: { hostId: 'fixture', processId: 'test:1', buildId: candidate, runtimeGeneration: 'fixture' },
      snapshot: { id: 'snapshot', acquiredAt: at, scopeHash: deferredSpendFingerprint(scope), consistency: 'consistent-read-only', evidenceRefs: ['snapshot:fixture'] } },
    sourceManifestHash: deferredSpendFingerprint(deferredSpendSourceManifest(files)),
    configurationHash: deferredSpendFingerprint({ projectConfiguration, migrationRegistry, packages: [] }), censusSelectors: {
      base: { revision: base, treeHash: 'a'.repeat(64), provenance }, candidate: { revision: candidate, treeHash: 'b'.repeat(64), provenance },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace',
        contentHash: deferredSpendFingerprint({ repositoryRoot: '/repo', workspaceRoot: '/workspace' }), provenance },
      projectConfiguration, migrationRegistry, productionRoots: [{ path: 'src', contentHash: deferredSpendFingerprint(members), provenance }],
      changedPaths: { method: 'reviewed-base-to-candidate-diff', baseRevision: base, candidateRevision: candidate,
        populationHash: deferredSpendFingerprint([]), provenance, entries: [] },
    } });
  const identity = structuredClone(sourceIdentity);
  identity.subject.kind = 'live';
  const deferral = { status: 'deferred', actorId: 'historical', reason: 'billing delayed',
    procedureRef: 'runbook:deferred', reconcileAfter: end };
  const hosts = DEFERRED_SPEND_RETAINED_RUNS.map(id => ({ workspaceId: 'ws', id, connectionId: 'existing-connection',
    costSignals: [{ kind: 'workspace-host-canary-cost-evidence-v1', runId: id,
      spendSettlement: structuredClone(deferral), preRunZeroBaseline: { cents: 0, observedAt: start, providerEvidenceRef: 'baseline:zero' },
      completion: { completedAt: end }, spendObservations: [], spendReconciliation: { status: 'retryable', reason: 'no-data' } }] }));
  const actorIds = ['original', 'acceptance', 'independent'];
  const lineage: DeferredSpendActionLineage = { snapshotRef: 'snapshot', complete: true, historyComplete: true,
    evidenceRefs: ['lineage:complete'], edges: [], aliases: [], actors: actorIds.map(id => ({
      id, generation: '1', principalId: 'principal:' + id, sessionId: 'session:' + id,
      workItemId: 'WI:' + id, evidenceRefs: ['actor:' + id],
    })) };
  const boundaries = { r7: { ref: 'retained-r7', generation: '1' }, g6: { ref: 'retained-g6', generation: '1' },
    r31: { ref: 'retained-r31', generation: '1' } };
  const row = (id: string, actorId: string, action: DeferredSpendActionRecord['action']): DeferredSpendActionRecord => ({
    id, workspaceId: 'ws', occurredAt: '2026-10-25T19:30:00Z', action, target: boundaries.r7,
    operationId: null, invocationId: null, writeTime: { actorId, actorGeneration: '1', principalId: 'principal:' + actorId,
      sessionId: 'session:' + actorId, workItemId: 'WI:' + actorId, sourceRef: 'source:write-time', processId: 'writer:1', buildId: 'writer' },
    authorization: null, audit: { complete: true, evidenceRefs: ['audit:complete'] }, evidenceRefs: ['row:' + id],
  });
  const independent = row('02-independent', 'independent', 'destroy');
  independent.authorization = { id: 'authorization:independent', actorId: 'independent', workItemId: 'WI:independent',
    issuedAt: '2026-10-25T19:10:00Z', action: 'destroy', target: boundaries.r7, separateCausalRoot: true,
    independentOf: ['original', 'acceptance'], lineageRefs: ['authorization:causal-root'], evidenceRefs: ['authorization:grant'] };
  const records: Record<DeferredSpendActionStream, DeferredSpendActionRecord[]> = {
    operations: [], events: [], resources: [], requests: [], admissions: [], credentials: [], invocations: [], native: [],
  };
  records.operations.push(row('01-read', 'original', 'observe'), independent);
  const hostReads = vi.fn(), actionReads = vi.fn();
  const inputs: Mutable<DeferredSpendAcceptanceInputs> = { identity,
    source: { request: { expectedIdentity: structuredClone(sourceIdentity),
      entrypoints: [{ path: 'src/collector.ts', symbol: 'collect' }], allowances: [],
      controls: [{ id: 'read-only-collector', path: 'src/collector.ts', symbol: 'collect', kind: 'literal', value: 'consistent-read-only' }] },
      snapshot: { identity: sourceIdentity, files, roots: [{ root: 'src', members }], packages: [], evidenceRefs: ['source:complete'] } },
    population: { request: { targets: DEFERRED_SPEND_RETAINED_RUNS.map(id => ({
      hostId: id, runId: id, originalDeferral: deferral, evidenceRefs: ['deferral:independent-baseline'],
    })) }, dependencies: { withSnapshot: async (expected, read) => { hostReads(); return read({
      identity: expected,
      census: async () => ({ snapshotRef: 'snapshot', upperWatermark: hosts.at(-1)!.id, hostCount: hosts.length, evidenceRefs: ['host:census'] }),
      readHosts: async (after, upperWatermark) => ({ snapshotRef: 'snapshot', configurationHash: expected.configurationHash,
        after, upperWatermark, nextAfter: null, hosts, evidenceRef: 'hosts:complete' }),
      readConnection: async id => ({ workspaceId: 'ws', id, target: 'gcp', readable: true, providerConfig: {}, evidenceRefs: ['connection:retained'] }),
      readJobs: async () => ({ snapshotRef: 'snapshot', complete: true, records: [], evidenceRefs: ['jobs:complete-empty'] }),
    }); } } },
    action: { request: { implementation: [{ actorId: 'original', startedAt: start, evidenceRefs: ['implementation:original'] }],
      acceptance: [{ actorId: 'acceptance', startedAt: '2026-10-25T19:01:00Z', evidenceRefs: ['acceptance:continuation'] }], boundaries },
      dependencies: { withSnapshot: async (expected, read) => { actionReads(); return read({
        identity: expected, readLineage: async () => lineage,
        readCensus: async stream => ({ snapshotRef: 'snapshot', complete: true, retentionComplete: true,
          window: expected.observation.window, count: records[stream].length, upperWatermark: records[stream].at(-1)?.id ?? null,
          evidenceRefs: ['census:' + stream] }),
        readPage: async (stream, after, upperWatermark) => ({ snapshotRef: 'snapshot', after, upperWatermark, nextAfter: null,
          records: records[stream], evidenceRef: 'page:' + stream }),
      }); } } },
  };
  const read = vi.fn(async () => inputs), persist = vi.fn(async (_harness: string, _path: string, _body: string) => {});
  const rubric = { rubricId: request.rubricRef, workspaceId: 'ws', revision: 7, criteriaHash: request.criteriaHash,
    subjectPlan: plan, subjectHarnessSlug: 'papercusp', criteria: Object.entries(keys).map(([key, instrumentKey]) =>
      ({ key, check: { kind: 'instrument', instrumentKey } })) } as unknown as Rubric;
  const subject = { kind: 'plan' as const, ref: plan, windowStart: start, windowEnd: end };
  return { request, identity, sourceIdentity, inputs, hosts, records, row, hostReads, actionReads, read, persist, rubric, subject,
    run: () => measureDeferredSpendAcceptance(request, { read, persist }),
    compose: () => collectDeferredSpendAcceptanceEvidence(inputs) };
}

describe('DS-P010-DISTINCT-OBSERVATIONS', () => {
  it('baseline: real P007/P008/P009 source composition validates coverage and retains its derivation', async () => {
    const f = fixture(); f.identity.subject.kind = 'source';
    const result = await f.compose();
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: f.identity, requiredSlices: ['retained-spend-population'] }, result.r007).verdict).toBe('pass');
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: f.identity, requiredSlices: ['source-census', 'action-boundary'] }, result.r008).verdict).toBe('pass');
    expect(f.hostReads).toHaveBeenCalledTimes(1); expect(f.actionReads).toHaveBeenCalledTimes(1);
    expect(result.source).toMatchObject({ census: { identity: f.sourceIdentity },
      derivation: { state: 'same-source-identity', inputIdentity: f.sourceIdentity, outputIdentity: f.sourceIdentity,
        mapping: [{ from: 'source-r008', to: 'source-census', originalSliceHash: expect.any(String), evidenceRefs: ['source:complete'] }] } });
    expect((await f.run()).criteria.r007.verdict).toBe('unknown'); // Source-only proof cannot be a live measurement.
  });
  it('counterexample: an attributable forbidden source effect propagates through the validated derivation', async () => {
    const f = fixture();
    const source = f.inputs.source;
    const file = source.snapshot.files[1];
    file.text = "export function collect() { destroyHost('prohibited'); return 'consistent-read-only'; }";
    file.contentHash = deferredSpendSourceHash(file.text);
    source.snapshot.roots[0].members[0].contentHash = file.contentHash;
    source.snapshot.identity.censusSelectors.productionRoots[0].contentHash = deferredSpendFingerprint(source.snapshot.roots[0].members);
    source.snapshot.identity.sourceManifestHash = deferredSpendFingerprint(deferredSpendSourceManifest(source.snapshot.files));
    source.request.expectedIdentity = structuredClone(source.snapshot.identity);
    Object.assign(f.identity, structuredClone(source.snapshot.identity));
    const result = await f.compose();
    const evaluated = evaluateDeferredSpendEvidence({ expectedIdentity: f.identity,
      requiredSlices: ['source-census', 'action-boundary'] }, result.r008);
    expect(evaluated.verdict).toBe('fail');
    expect(evaluated.slices[0].violations[0].reason).toContain('src/collector.ts');
    expect(evaluated.slices[1].verdict).toBe('pass');
  });
  it('baseline: one durable live manifest retains separate R007 pass and unjoined R008 unknown', async () => {
    const f = fixture(); const result = await f.run();
    expect(result.criteria.r007.verdict, JSON.stringify(result)).toBe('pass'); expect(result.criteria.r008.verdict).toBe('unknown');
    expect(result.criteria.r008.reasons.join(';')).toContain('source-to-live join');
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.persist).toHaveBeenCalledTimes(1);
    const [harness, path, bytes] = f.persist.mock.calls[0];
    const manifest = JSON.parse(bytes);
    expect(result.manifestRef).toBe('artifact:' + harness + ':' + path);
    expect(deferredSpendFingerprint(manifest)).toBe(result.manifestHash);
    expect(manifest.source.snapshot.identity.subject.kind).toBe('source');
    expect(manifest.source.census.identity.subject.kind).toBe('source');
    expect(manifest.source.derivation).toMatchObject({ state: 'unjoined', outputIdentity: null, mapping: [] });
    expect(manifest.inputs.r008.slices.map((slice: { id: string }) => slice.id)).toEqual(['action-boundary']);
  });
  it('counterexample: R007 pass never masks an attributable R008 violation with an unjoined source', async () => {
    const f = fixture(); f.records.operations.push(f.row('03-prohibited', 'original', 'provision'));
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('pass'); expect(result.criteria.r008.verdict).toBe('fail');
    expect(result.criteria.r008.evidence?.slices[0].violations[0].member).toBe('operations:03-prohibited');
  });
  it('counterexample: R007 read failure cannot erase a measured R008 violation', async () => {
    const f = fixture(); f.records.operations.push(f.row('03-prohibited', 'original', 'provision'));
    f.inputs.population.dependencies.withSnapshot = async () => { throw new Error('unreadable'); };
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.criteria.r008.verdict).toBe('fail');
  });
  it.each(['hostId', 'processId', 'buildId', 'runtimeGeneration'] as const)('counterexample: missing serving %s stays unknown', async field => {
    const f = fixture(); f.identity.observation.serving[field] = '';
    const result = await f.run(); expect(result.criteria.r007.verdict).toBe('unknown');
    expect(result.criteria.r008.verdict).toBe('unknown'); expect(f.persist).not.toHaveBeenCalled();
  });
  it.each(['source', 'foreign-workspace', 'foreign-interval'] as const)('counterexample: %s cannot become live proof', async defect => {
    const f = fixture();
    if (defect === 'source') f.identity.subject.kind = 'source';
    if (defect === 'foreign-workspace') f.request.workspaceId = 'other';
    if (defect === 'foreign-interval') f.request.windowStart = '2026-10-25T18:00:00Z';
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.criteria.r008.verdict).toBe('unknown');
    expect(f.hostReads).not.toHaveBeenCalled();
  });
  it.each(['identity', 'selectors', 'missing-control', 'missing-bytes'] as const)('counterexample: invalid source %s cannot pass through the derived slice', async defect => {
    const f = fixture(); f.identity.subject.kind = 'source';
    if (defect === 'identity') f.inputs.source.snapshot.identity.observation.id = 'other';
    if (defect === 'selectors') f.inputs.source.request.expectedIdentity.censusSelectors.base.treeHash = 'd'.repeat(64);
    if (defect === 'missing-control') f.inputs.source.request.controls = [];
    if (defect === 'missing-bytes') f.inputs.source.snapshot.files = [];
    const result = await f.compose();
    expect(evaluateDeferredSpendEvidence({ expectedIdentity: f.identity, requiredSlices: ['source-census', 'action-boundary'] }, result.r008).verdict).toBe('unknown');
  });
  it.each(['reader', 'persistence'] as const)('counterexample: %s failure cannot preserve success', async defect => {
    const f = fixture(); (defect === 'reader' ? f.read : f.persist).mockRejectedValueOnce(new Error('unreadable'));
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.criteria.r008.verdict).toBe('unknown');
    expect(result.manifestRef).toBeUndefined();
  });
  it('counterexample: absent runtime adapter is explicit unknown without an invented identity', async () => {
    const result = await measureDeferredSpendAcceptance(fixture().request);
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.identity).toBeUndefined();
  });
  it('baseline: registry resolves both keys and scorecards measures their shared collector once', async () => {
    const f = fixture(); for (const key of Object.values(keys)) expect(getRegisteredInstrument(key)?.evaluator).toBe('platform');
    const measured = vi.fn(f.run);
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject }, {
      deferredSpend: measured, now: () => Date.parse(at),
    });
    expect(measured).toHaveBeenCalledTimes(1); expect(f.hostReads).toHaveBeenCalledTimes(1); expect(f.actionReads).toHaveBeenCalledTimes(1);
    expect(snapshots?.[keys.r007]).toMatchObject({ verdict: 'pass', provenance: 'platform-computed', evidenceRef: expect.stringContaining('artifact:papercusp:') });
    expect(snapshots?.[keys.r008]).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed' });
  });
  it('counterexample: forged caller passes are replaced by two distinct measured outcomes', async () => {
    const f = fixture(); f.records.operations.push(f.row('03-prohibited', 'original', 'provision'));
    const supplied = Object.fromEntries(Object.values(keys).map(key => [key, { verdict: 'pass' as const, provenance: 'platform-computed' as const, measuredAt: at }]));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject, supplied }, { deferredSpend: f.run, now: () => Date.parse(at) });
    expect(snapshots?.[keys.r007]?.verdict).toBe('pass'); expect(snapshots?.[keys.r008]?.verdict).toBe('fail');
  });
  it.each(['resolver-error', 'missing-identity', 'wrong-plan', 'wrong-harness'] as const)('counterexample: %s cannot preserve caller success', async defect => {
    const f = fixture();
    if (defect === 'missing-identity') f.identity.observation.serving.buildId = '';
    if (defect === 'wrong-plan') f.subject.ref = 'other';
    if (defect === 'wrong-harness') f.rubric.subjectHarnessSlug = 'other';
    const measured = defect === 'resolver-error' ? vi.fn(async () => { throw new Error('unavailable'); }) : vi.fn(f.run);
    const supplied = Object.fromEntries(Object.values(keys).map(key => [key, { verdict: 'pass' as const, provenance: 'platform-computed' as const, measuredAt: at }]));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject, supplied }, { deferredSpend: measured, now: () => Date.parse(at) });
    for (const key of Object.values(keys)) expect(snapshots?.[key]?.verdict).toBe('unknown');
  });
  it('baseline: the composed path performs only retained reads, with no provider request', async () => {
    const f = fixture(); const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('provider trap'));
    try { expect((await f.run()).criteria.r007.verdict).toBe('pass'); expect(provider).not.toHaveBeenCalled(); }
    finally { provider.mockRestore(); }
  });
});
