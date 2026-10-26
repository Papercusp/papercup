import { describe, expect, it, vi } from 'vitest';
import {
  DEFERRED_SPEND_ACCEPTANCE_PLAN as plan, DEFERRED_SPEND_INSTRUMENT_KEYS as keys,
  measureDeferredSpendAcceptance, type DeferredSpendAcceptanceEvidence,
} from './deferred-spend-acceptance-instruments';
import {
  deferredSpendEvidenceIdentitySchema, deferredSpendFingerprint,
  type DeferredSpendEvidenceSlice,
} from './deferred-spend-acceptance-contract';
import { getRegisteredInstrument } from '../rubric-instrument-registry';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';
import type { Rubric } from '../rubrics';

const start = '2026-10-25T19:00:00Z', end = '2026-10-25T20:00:00Z', at = '2026-10-25T20:00:02Z';
function fixture() {
  const provenance = { method: 'reviewed-source-read', selector: 'independent-base-candidate', evidenceRefs: ['review:selectors'] };
  const selector = (path: string) => ({ path, contentHash: 'a'.repeat(64), provenance });
  const request = { workspaceId: 'ws', harness: 'papercusp', planSlug: plan, rubricRef: 'acceptance-deferred-spend',
    rubricRevision: 7, criteriaHash: 'c'.repeat(64), subjectRef: plan, windowStart: start, windowEnd: end };
  const scope = { workspaceId: request.workspaceId, harness: request.harness, planSlug: plan,
    rubricRef: request.rubricRef, rubricRevision: 7, criteriaHash: request.criteriaHash };
  const identity = deferredSpendEvidenceIdentitySchema.parse({ schemaVersion: 'deferred-spend-evidence-v1', scope,
    subject: { kind: 'live', ref: plan }, observation: { id: 'observation', observedAt: at,
      window: { startAt: start, endAt: end }, serving: { hostId: 'host', processId: 'pid:1', buildId: 'loaded-build', runtimeGeneration: 'generation' },
      snapshot: { id: 'snapshot', acquiredAt: at, scopeHash: deferredSpendFingerprint(scope), consistency: 'consistent-read-only', evidenceRefs: ['snapshot:receipt'] } },
    sourceManifestHash: 'a'.repeat(64), configurationHash: 'b'.repeat(64), censusSelectors: {
      base: { revision: 'a'.repeat(40), treeHash: 'a'.repeat(64), provenance },
      candidate: { revision: 'b'.repeat(40), treeHash: 'b'.repeat(64), provenance },
      roots: { repositoryRoot: '/repo', workspaceRoot: '/workspace', contentHash: 'a'.repeat(64), provenance },
      projectConfiguration: { contentHash: 'a'.repeat(64), provenance, tsconfigs: [selector('tsconfig.json')], projectReferences: [] },
      migrationRegistry: { revision: 'b'.repeat(40), contentHash: 'a'.repeat(64), provenance, entries: [] },
      productionRoots: [selector('src')], changedPaths: { method: 'reviewed-base-to-candidate-diff', baseRevision: 'a'.repeat(40),
        candidateRevision: 'b'.repeat(40), populationHash: deferredSpendFingerprint([]), provenance, entries: [] },
    } });
  const slice = (id: string, verdict: 'pass' | 'fail' | 'unknown' = 'pass'): DeferredSpendEvidenceSlice => ({
    id, verdict, evidenceRefs: [`evidence:${id}`], ...(verdict === 'unknown' ? { reason: 'retained history incomplete' } : {}),
    violations: verdict === 'fail' ? [{ member: 'positive-control', reason: 'measured prohibited action', evidenceRefs: ['audit:violation'] }] : [],
    coverage: { state: verdict === 'unknown' ? 'partial' : 'complete', population: ['positive-control'], checked: ['positive-control'],
      notChecked: [], notApplicable: [], residue: [], gaps: verdict === 'unknown' ? ['history-gap'] : [], snapshotRef: 'snapshot',
      pageRefs: ['page:complete'], emptyPopulationEvidenceRefs: [] },
  });
  const evidence = { identity,
    r007: { identity, slices: [slice('retained-spend-population')] },
    r008: { identity, slices: [slice('source-census'), slice('action-boundary')] }, source: { manifest: ['independent-source-control'] } } satisfies DeferredSpendAcceptanceEvidence;
  const read = vi.fn(async () => evidence), persist = vi.fn(async (_harness: string, _path: string, _body: string) => {});
  const rubric = { rubricId: request.rubricRef, workspaceId: 'ws', revision: 7, criteriaHash: request.criteriaHash,
    subjectPlan: plan, subjectHarnessSlug: 'papercusp', criteria: Object.entries(keys).map(([key, instrumentKey]) =>
      ({ key, check: { kind: 'instrument', instrumentKey } })) } as unknown as Rubric;
  const subject = { kind: 'plan' as const, ref: plan, windowStart: start, windowEnd: end };
  const run = () => measureDeferredSpendAcceptance(request, { read, persist });
  return { request, identity, slice, evidence, read, persist, rubric, subject, run };
}

describe('DS-P010-DISTINCT-OBSERVATIONS', () => {
  it('baseline: persists a complete identified manifest and keeps two successful observations distinct', async () => {
    const f = fixture(); const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('pass'); expect(result.criteria.r008.verdict).toBe('pass');
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.persist).toHaveBeenCalledTimes(1);
    const [harness, path, bytes] = f.persist.mock.calls[0];
    expect(harness).toBe('papercusp'); expect(result.manifestRef).toBe(`artifact:${harness}:${path}`);
    const manifest = JSON.parse(bytes);
    expect(deferredSpendFingerprint(manifest)).toBe(result.manifestHash);
    expect(manifest.inputs).toEqual({ r007: f.evidence.r007, r008: f.evidence.r008 });
    expect(manifest.source).toEqual(f.evidence.source);
  });
  it.each(['fail', 'unknown'] as const)('counterexample: R007 pass never masks an R008 %s', async verdict => {
    const f = fixture(); f.evidence.r008.slices = [f.slice('source-census'), f.slice('action-boundary', verdict)];
    const result = await f.run();
    expect(result.criteria.r007.verdict).toBe('pass'); expect(result.criteria.r008.verdict).toBe(verdict);
  });
  it('counterexample: a measured action violation dominates missing source evidence', async () => {
    const f = fixture(); f.evidence.r008.slices = [f.slice('action-boundary', 'fail')];
    expect((await f.run()).criteria.r008.verdict).toBe('fail');
  });
  it.each(['hostId', 'processId', 'buildId', 'runtimeGeneration'] as const)('counterexample: missing serving %s stays unknown', async field => {
    const f = fixture(); f.identity.observation.serving[field] = '';
    const result = await f.run(); expect(result.criteria.r007.verdict).toBe('unknown');
    expect(result.criteria.r008.verdict).toBe('unknown'); expect(f.persist).not.toHaveBeenCalled();
  });
  it.each(['source', 'foreign-workspace', 'foreign-interval', 'selector-skew'] as const)('counterexample: %s cannot become live proof', async defect => {
    const f = fixture();
    if (defect === 'source') f.identity.subject.kind = 'source';
    if (defect === 'foreign-workspace') f.request.workspaceId = 'other';
    if (defect === 'foreign-interval') f.request.windowStart = '2026-10-25T18:00:00Z';
    if (defect === 'selector-skew') {
      const changed = structuredClone(f.identity); changed.censusSelectors.base.treeHash = 'd'.repeat(64);
      f.evidence.r008 = { identity: changed, slices: f.evidence.r008.slices };
    }
    const result = await f.run();
    expect(result.criteria.r008.verdict).toBe('unknown');
    if (defect !== 'selector-skew') expect(result.criteria.r007.verdict).toBe('unknown');
  });
  it.each(['reader', 'persistence'] as const)('counterexample: %s failure cannot preserve success', async defect => {
    const f = fixture(); (defect === 'reader' ? f.read : f.persist).mockRejectedValueOnce(new Error('unreadable'));
    const result = await f.run(); expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.criteria.r008.verdict).toBe('unknown');
    expect(result.manifestRef).toBeUndefined();
  });
  it('counterexample: absent runtime adapter is explicit unknown with no invented measurement identity', async () => {
    const result = await measureDeferredSpendAcceptance(fixture().request);
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.identity).toBeUndefined();
  });
  it('baseline: registry resolves both keys and a scorecard call measures once', async () => {
    const f = fixture(); for (const key of Object.values(keys)) expect(getRegisteredInstrument(key)?.evaluator).toBe('platform');
    const measured = vi.fn(f.run);
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject }, {
      deferredSpend: measured, now: () => Date.parse(at),
    });
    expect(measured).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
    for (const key of Object.values(keys)) expect(snapshots?.[key]).toMatchObject({ verdict: 'pass', provenance: 'platform-computed', evidenceRef: expect.stringContaining('artifact:papercusp:') });
  });
  it('counterexample: forged caller passes are replaced by distinct measured outcomes', async () => {
    const f = fixture(); f.evidence.r008.slices = [f.slice('action-boundary', 'fail')];
    const supplied = Object.fromEntries(Object.values(keys).map(key => [key, { verdict: 'pass' as const, provenance: 'platform-computed' as const, measuredAt: at }]));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject, supplied }, {
      deferredSpend: f.run, now: () => Date.parse(at),
    });
    expect(snapshots?.[keys.r007]?.verdict).toBe('pass'); expect(snapshots?.[keys.r008]?.verdict).toBe('fail');
  });
  it('counterexample: resolver errors replace every forged caller pass', async () => {
    const f = fixture(); const measured = vi.fn(async () => { throw new Error('resolver unavailable'); });
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject }, {
      deferredSpend: measured, now: () => Date.parse(at),
    });
    expect(measured).toHaveBeenCalledTimes(1);
    for (const key of Object.values(keys)) expect(snapshots?.[key]?.verdict).toBe('unknown');
  });
});
