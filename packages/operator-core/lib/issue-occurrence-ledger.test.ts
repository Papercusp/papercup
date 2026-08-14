import { describe, expect, it } from 'vitest';
import {
  assessIssueAdmissionPressure,
  decideIssueAdmissionCircuit,
  selectCanonicalIssue,
} from './issue-occurrence-ledger';

describe('selectCanonicalIssue', () => {
  it('prefers exact stable identity over a higher fuzzy score', () => {
    expect(selectCanonicalIssue(
      { schemaVersion: 'admission-identity-v1', titleKey: 'title:alpha failure' },
      [
        { id: 'WI-2', title: 'near alpha failure', eligible: true, similarity: 0.99 },
        { id: 'WI-1', title: 'Alpha failure', eligible: true, similarity: 0.8 },
      ],
    )?.id).toBe('WI-1');
  });

  it('never selects an advisory-only candidate', () => {
    expect(selectCanonicalIssue(
      { schemaVersion: 'admission-identity-v1', titleKey: 'title:alpha' },
      [{ id: 'WI-1', title: 'Alpha', eligible: false, similarity: 1 }],
    )).toBeNull();
  });

  it('uses score then id for deterministic fuzzy selection', () => {
    expect(selectCanonicalIssue(
      { schemaVersion: 'admission-identity-v1', titleKey: 'title:unrelated' },
      [
        { id: 'WI-9', title: 'candidate z', eligible: true, similarity: 0.9 },
        { id: 'WI-3', title: 'candidate a', eligible: true, similarity: 0.9 },
      ],
    )?.id).toBe('WI-3');
  });
});

function spreadCounts(total: number, buckets: number): number[] {
  return Array.from({ length: buckets }, (_, index) =>
    Math.floor(total / buckets) + (index < total % buckets ? 1 : 0));
}

describe('P-005 queue-admission entropy replay', () => {
  it('does not trip on the broad 2026-08-12 cohort shape despite 455 duplicate occurrences', () => {
    const pressure = assessIssueAdmissionPressure({
      rawOccurrences: 2_949,
      duplicateOccurrences: 455,
      canonicalStock: 2_494,
      canonicalClusterCounts: spreadCounts(2_949, 140),
      emitterCounts: spreadCounts(2_949, 90),
    });

    expect(pressure).toMatchObject({
      active: false,
      mode: 'pass',
      rawOccurrences: 2_949,
      duplicateOccurrences: 455,
      canonicalStock: 2_494,
      canonicalClusters: 140,
      emitters: 90,
    });
    expect(pressure.canonicalDominantShare).toBeLessThan(0.6);
    expect(pressure.emitterDominantShare).toBeLessThan(0.6);
  });

  it('trips on a concentrated 455-report subburst across both cluster and emitter axes', () => {
    const pressure = assessIssueAdmissionPressure({
      rawOccurrences: 455,
      duplicateOccurrences: 455,
      canonicalStock: 2_494,
      canonicalClusterCounts: [430, 5, 5, 5, 5, 5],
      emitterCounts: [430, 5, 5, 5, 5, 5],
    });

    expect(pressure).toMatchObject({ active: true, mode: 'coalesce', rawOccurrences: 455 });
    expect(pressure.canonicalNormalizedEntropy).toBeLessThanOrEqual(0.45);
    expect(pressure.emitterNormalizedEntropy).toBeLessThanOrEqual(0.45);
    expect(pressure.canonicalDominantShare).toBeGreaterThanOrEqual(0.6);
    expect(pressure.emitterDominantShare).toBeGreaterThanOrEqual(0.6);
  });

  it('always passes critical novelty and a report with no canonical candidate', () => {
    const pressure = assessIssueAdmissionPressure({
      rawOccurrences: 455,
      duplicateOccurrences: 455,
      canonicalStock: 2_494,
      canonicalClusterCounts: [455],
      emitterCounts: [455],
    });
    const identity = { schemaVersion: 'admission-identity-v1' as const, titleKey: 'title:novel critical' };

    expect(decideIssueAdmissionCircuit({
      identity,
      candidates: [{ id: 'EI-1', title: 'nearby issue', eligible: true, similarity: 0.91 }],
      pressure,
      severity: 'critical',
    })).toMatchObject({ action: 'pass', reason: 'critical-novelty', canonical: null });
    expect(decideIssueAdmissionCircuit({ identity, candidates: [], pressure })).toMatchObject({
      action: 'pass',
      reason: 'no-canonical-candidate',
      canonical: null,
    });
  });
});
