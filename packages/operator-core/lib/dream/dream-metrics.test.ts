import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { computeDreamMetrics, type DreamMetricRow, type DreamMetricsScope } from './dream-metrics';
import { DREAM_RUN_TERMINAL_STATUSES, type DreamRun } from './dream-run-store';
import { dreamCapabilityRun, type DreamRunAssessment } from './dream-run-provenance';
import { capabilityProposalHash } from './capability-review';
import { buildCapabilitySamplingSnapshot, sampleCapabilityCombination } from './capability-sampler';

const scope: DreamMetricsScope = {
  workspaceId: 'metrics-unit', potSlug: 'papercusp', since: '2026-09-07T00:00:00Z', until: '2026-09-08T00:00:00Z',
};
describe('Dream metrics reconcile evidence rather than wording, retries or missing receipts', () => {
  let fixture: Awaited<ReturnType<typeof createDreamCapabilityFixture>>;
  beforeAll(async () => { fixture = await createDreamCapabilityFixture(scope.workspaceId, scope.potSlug); });
  afterAll(async () => { if (fixture) await rm(fixture.root, { recursive: true, force: true }); });
  function row(id: string, status: DreamRun['status'] = 'accepted'): DreamMetricRow {
    const run = structuredClone(fixture.run);
    Object.assign(run, { runId: id, status, completedAt: status === 'running' ? null : run.startedAt });
    return { run, routed: null, experiments: [] };
  }
  function assess(r: DreamMetricRow, familyId: string | null, overrides: Partial<DreamRunAssessment> = {}) {
    const a: DreamRunAssessment = {
      schemaVersion: 'dream-run-assessment-v1', id: 'assessment-1', assessor: 'human:curator',
      recordedAt: '2026-09-07T18:00:00.000Z', candidateHash: String(r.run.review!.candidateHash),
      evidenceHash: String(r.run.review!.evidenceHash), familyId,
      novelty: 'supported', usefulness: 'supported', maintainability: 'unknown',
      evidenceRefs: ['test:held-out-case'], experimentBatteryIds: [], ...overrides,
    };
    r.run.outcome!.assessments = [...(r.run.outcome!.assessments as DreamRunAssessment[] ?? []), a];
    return a;
  }

  it('reports every terminal outcome and running attempts once, including replayed deliveries', () => {
    const rows = ['running', ...DREAM_RUN_TERMINAL_STATUSES].map(s => row(s, s as DreamRun['status']));
    const noPair = rows.find(r => r.run.status === 'no-pair')!;
    const provenance = dreamCapabilityRun(noPair.run)!;
    noPair.run.outcome = { verdict: 'none', capabilityRun: {
      ...provenance, calls: [], sampling: { status: 'no-pair', reason: 'insufficient-units', log: provenance.sampling!.log },
    } };
    noPair.run.costUsd = 0; noPair.run.review = null;
    const report = computeDreamMetrics([...rows, ...rows], scope);
    expect(report.population.attempts).toBe(8);
    expect(report.funnel.terminal).toBe(7);
    expect(Object.values(report.funnel.statuses)).toEqual(Array(8).fill(1));
    expect(report.funnel.noPairRate).toEqual({ numerator: 1, denominator: 8, value: 0.125 });
    expect(report.cost.knownCallUsd).toBeCloseTo(0.49);
  });

  it('counts reworded accepted proposals in the same assessed family once', () => {
    const a = row('original'), b = row('reworded');
    const candidate = structuredClone(fixture.candidate);
    candidate.behavior = 'Use the B check to verify the output from A.';
    b.run.outcome!.insight = { ...fixture.insight, capability: candidate };
    b.run.review!.candidateHash = capabilityProposalHash(candidate);
    assess(a, 'compose-output-check'); assess(b, 'compose-output-check');
    const report = computeDreamMetrics([a, b, structuredClone(a)], scope);
    expect(report.funnel.proposalAttempts).toBe(2);
    expect(report.funnel.qualifiedFamilies).toBe(1);
    expect(report.novelty.repeatedFamilyRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 });
    expect(report.leading.qualifiedFamiliesPerUsd).toBeCloseTo(1 / 0.14);
    expect(report.quality.maintainability).toEqual({ supported: 0, disproven: 0, unknown: 2 });
  });

  it('keeps unassessed quality unknown and never infers a family from a text hash', () => {
    const report = computeDreamMetrics([row('one'), row('same-words')], scope);
    expect(report.novelty.identifiedFamilies).toBe(0);
    expect(report.novelty.unidentifiedProposalAttempts).toBe(2);
    expect(report.novelty.qualificationUnknown).toBe(2);
    expect(report.quality.usefulness.unknown).toBe(2);
    expect(report.leading.qualifiedFamiliesPerUsd).toBeNull();
  });

  it('preserves unknown charges and reports their reservation separately from actual spend', () => {
    const r = row('unknown', 'error');
    const p = dreamCapabilityRun(r.run)!;
    p.calls[1] = { ...p.calls[1]!, status: 'unknown', usage: null, error: 'lost reply' };
    r.run.outcome!.capabilityRun = p;
    r.run.costUsd = 0.15;
    const report = computeDreamMetrics([r], scope);
    expect(report.cost.knownCallUsd).toBeCloseTo(0.05);
    expect(report.cost.unresolvedBoundUsd).toBeCloseTo(0.1);
    expect(report.cost.unknownUsageCount).toBe(1);
    expect(report.cost.fullyAttributedDiscoveryUsd).toBeNull();
    expect(report.cost.phases['control-a']!.actualUsd).toBeNull();
    expect(report.cost.reconciliationErrors).toEqual([]);
  });

  it('does not turn legacy missing usage or selected calls with missing receipts into zero', () => {
    const legacy = row('legacy', 'error');
    legacy.run.outcome = null; legacy.run.review = null; legacy.run.costUsd = 0;
    const missing = row('missing', 'error');
    const p = dreamCapabilityRun(missing.run)!;
    missing.run.outcome!.capabilityRun = { ...p, calls: [] }; missing.run.costUsd = 0;
    const report = computeDreamMetrics([legacy, missing], scope);
    expect(report.population.legacy).toBe(1);
    expect(report.cost.unknownUsageCount).toBe(2);
    expect(report.cost.phases.generation!.actualUsd).toBeNull();
    expect(report.cost.fullyAttributedCallUsd).toBeNull();
  });

  it('requires reconciled totals even if all phase calls claim actual usage', () => {
    const r = row('mismatch'); r.run.costUsd = 2;
    assess(r, 'f');
    const report = computeDreamMetrics([r], scope);
    expect(report.cost.reconciliationErrors).toEqual(['mismatch: phase charges do not reconcile']);
    expect(report.leading.qualifiedFamiliesPerUsd).toBeNull();
  });

  it('counts current independent assessors, reports disagreement, and excludes conflicting quality', () => {
    const r = row('disagree');
    assess(r, 'f');
    assess(r, 'f', { id: 'revision', recordedAt: '2026-09-07T19:00:00.000Z' });
    assess(r, 'f', { id: 'second', assessor: 'human:second', usefulness: 'disproven' });
    const report = computeDreamMetrics([r], scope);
    expect(report.reviewerDisagreement).toEqual({ numerator: 1, denominator: 1, value: 1 });
    expect(report.quality.usefulness.unknown).toBe(1);
    expect(report.funnel.qualifiedFamilies).toBe(0);
  });

  it('separates reused packet costs from cold-start history and refuses to call historical cost fully attributed', () => {
    const a = row('a');
    const p = dreamCapabilityRun(a.run)!;
    if (p.sampling?.status !== 'selected') throw new Error('Fixture selection missing');
    p.sampling.selection.a.packet.extraction.costUsd = 0.3;
    a.run.outcome!.capabilityRun = p;
    const b = structuredClone(a); b.run.runId = 'b';
    const report = computeDreamMetrics([a, b], scope);
    expect(report.cost.packetColdStartUsd).toBeCloseTo(0.6);
    expect(report.cost.distinctPacketHistoricalUsd).toBeCloseTo(0.3);
    expect(report.cost.packetAmortizedUsdPerUse).toBeCloseTo(0.075);
    expect(report.cost.fullyAttributedDiscoveryUsd).toBeNull();
  });

  it('uses the sampler-written population, not sequential draw counts, and preserves old unknown census', async () => {
    const snapshot = await buildCapabilitySamplingSnapshot({
      rootPath: fixture.root, scope: fixture.scope, manifest: fixture.manifest, packets: fixture.packets,
    });
    const sampling = sampleCapabilityCombination(snapshot, {
      seed: 'metrics', promptVersion: fixture.header.dreamPromptVersion, now: Date.parse(scope.since), arity: 2,
    });
    expect(sampling.log.eligibleUnitIds).toEqual(fixture.packets.map(p => p.unit.id));
    const r = row('census');
    r.run.outcome!.capabilityRun = { ...dreamCapabilityRun(r.run), sampling };
    const report = computeDreamMetrics([r], scope);
    expect(report.coverage.sourcePopulationCoverage).toEqual({ numerator: 2, denominator: 2, value: 1 });
    expect(report.coverage.snapshotsWithUnknownPopulation).toBe(0);
    expect(computeDreamMetrics([row('old-census')], scope).coverage.snapshotsWithUnknownPopulation).toBe(1);
  });

  it('never coerces an unknown packet acquisition cost to zero or a fully attributed dollar rate', () => {
    const r = row('unknown-packet');
    const p = dreamCapabilityRun(r.run)!;
    if (p.sampling?.status !== 'selected') throw new Error('Fixture selection missing');
    p.sampling.selection.a.packet.extraction.costUsd = null;
    r.run.outcome!.capabilityRun = p;
    assess(r, 'f');
    const report = computeDreamMetrics([r], scope);
    expect(report.cost.unknownPackets).toBe(1);
    expect(report.cost.packetColdStartUsd).toBeNull();
    expect(report.cost.distinctPacketHistoricalUsd).toBeNull();
    expect(report.cost.packetAmortizedUsdPerUse).toBeNull();
    expect(report.cost.fullyAttributedDiscoveryUsd).toBeNull();
    expect(report.leading.qualifiedFamiliesPerUsd).toBeNull();
    expect(report.discoveryCurve.points[0]?.costIncomplete).toBe(true);
  });

  it('joins downstream grades and real experiments without calling an unexecuted proposal a win', () => {
    const r = row('outcomes'); r.run.routedRef = 'wi:EI-1';
    r.routed = { rail: 'improvement', humanGrade: 4, outcome: 'pending' };
    assess(r, 'f', { experimentBatteryIds: ['planned', 'executed'] });
    r.experiments = ['planned', 'executed'].map((batteryId, i) => ({
      batteryId, testId: 'replay', tier: 'offline', baselineId: 'baseline', winner: i ? 'candidate' : null,
      arms: [{ id: 'candidate', label: 'candidate', meanScore: i ? 0.8 : null, cells: i, scored: i, costUsd: i * 0.1 }],
      totalCostUsd: i * 0.1, budgetExhausted: false, decision: 'proposed', createdAt: scope.since,
    }));
    const duplicate = structuredClone(r); duplicate.run.runId = 'same-family';
    const report = computeDreamMetrics([r, duplicate], scope);
    expect(report.experiments).toMatchObject({ linked: 2, executed: 1, winning: 1, recordedCostUsd: 0.1 });
    expect(report.funnel.routedAttempts).toBe(2);
    expect(report.funnel.uniqueRoutedArtifacts).toBe(1);
    expect(report.downstream.grades).toEqual({ '4': 1 });
    expect(report.downstream.outcomes).toEqual({ pending: 1 });
    expect(report.experiments.engineeringTimeMs).toBeNull();
  });

  it('reports unresolved experiment links and a bounded curve without hiding the total population', () => {
    const r = row('missing-result');
    assess(r, 'f', { experimentBatteryIds: ['not-run-yet'] });
    const rows = Array.from({ length: 270 }, (_, i) => {
      const copy = structuredClone(r); copy.run.runId = String(i).padStart(3, '0'); return copy;
    });
    const report = computeDreamMetrics(rows, scope);
    expect(report.experiments).toMatchObject({ declaredLinks: 1, linked: 0, missingResults: 1, executed: 0, winning: 0 });
    expect(report.population.attempts).toBe(270);
    expect(report.discoveryCurve.points).toHaveLength(256);
    expect(report.discoveryCurve.omittedEarlierPoints).toBe(14);
    expect(report.discoveryCurve.points.at(-1)?.qualifiedFamilies).toBe(1);
    expect(report.discoveryCurve.points.at(-1)?.knownCallUsd).toBeCloseTo(18.9);
  });

  it('selects a later terminal snapshot, respects the half-open window, and rejects cross-pot rows', () => {
    const running = row('replay', 'running');
    const done = row('replay'); done.run.updatedAt = '2026-09-07T19:00:00Z';
    const boundary = row('excluded'); boundary.run.startedAt = scope.until;
    expect(computeDreamMetrics([running, done, boundary], scope).funnel.statuses.accepted).toBe(1);
    const foreign = row('foreign'); foreign.run.potSlug = 'another-pot';
    expect(() => computeDreamMetrics([foreign], scope)).toThrow(/crosses/);
    expect(() => computeDreamMetrics([], { ...scope, until: '2027-01-01T00:00:00Z' })).toThrow(/31 days/);
    const empty = computeDreamMetrics([], scope);
    expect(empty.funnel.noPairRate.value).toBeNull();
    expect(empty.leading.qualifiedFamiliesPerUsd).toBeNull();
  });
});
