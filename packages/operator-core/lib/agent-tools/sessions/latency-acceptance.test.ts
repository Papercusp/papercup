import { describe, expect, it } from 'vitest';
import {
  assessLatencyCohort, calibrateLatencyOracle, frozenOutputOracle,
  latencyAttemptId, latencyAttemptSchedule, latencyDistribution, latencyFixtureDigest,
  latencyRecipeCriterionCompatibility, pinLatencyCardFixture,
  type LatencyAttempt, type LatencyCardReference, type LatencyCardSnapshot,
} from '../../../test/_latency-acceptance';

// Simulated samples calibrate accounting. They are NOT baseline task receipts.
function calibrationSamples(): LatencyAttempt[] {
  return latencyAttemptSchedule().map(key => ({
    ...key,
    status: 'passed',
    actualElapsedMs: key.arm === 'baseline' ? 100 : 80,
    gatewayAttemptIds: key.arm === 'baseline' ? ['a', 'b', 'c', 'd'] : ['a', 'b', 'c'],
    pairFingerprint: 'a'.repeat(64),
    provenanceRef: `calibration-only:${latencyAttemptId(key)}`,
    oracle: { passed: true, evidenceRef: 'calibration-only', referenceSha256: 'b'.repeat(64) },
  }));
}

describe('LATENCY-M1 frozen experiment preparation', () => {
  it('keeps all 60 pairs and the predeclared AB/BA/AB order in both cache strata', () => {
    const schedule = latencyAttemptSchedule();
    expect(schedule).toHaveLength(120);
    expect(new Set(schedule.map(latencyAttemptId)).size).toBe(120);
    for (const task of Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`)) {
      for (const stratum of ['cold', 'warm']) {
        expect(schedule.filter(a => a.task === task && a.stratum === stratum).map(a => a.arm))
          .toEqual(['baseline', 'candidate', 'candidate', 'baseline', 'baseline', 'candidate']);
      }
    }
  });

  it('uses average-of-central-pair median and nearest-rank p95 without mutating raw samples', () => {
    const values = [100, 1, 3, 2];
    expect(latencyDistribution(values)).toEqual({ count: 4, median: 2.5, p95: 100 });
    expect(values).toEqual([100, 1, 3, 2]);
    expect(latencyDistribution([7, 2, 3])).toEqual({ count: 3, median: 3, p95: 7 });
    expect(latencyDistribution(Array.from({ length: 20 }, (_, i) => i + 1)).p95).toBe(19);
  });

  it.for([[], [NaN], [Infinity], [-1]])('rejects unmeasured/invalid distributions (%j)', values => {
    expect(() => latencyDistribution(values)).toThrow(/finite nonnegative/);
  });

  it('pins fixture bytes independently of object insertion order and refuses lossy values', () => {
    expect(latencyFixtureDigest({ z: [1, 2], a: 'fixed' }))
      .toBe(latencyFixtureDigest({ a: 'fixed', z: [1, 2] }));
    expect(latencyFixtureDigest({ a: 'fixed', z: [1, 2] }))
      .not.toBe(latencyFixtureDigest({ a: 'fixed', z: [2, 1] }));
    expect(() => latencyFixtureDigest({ invalid: NaN })).toThrow();
  });

  it('pins each card rubric population independently of the saved recipe rubric', () => {
    for (const count of [8, 6]) {
      const keys = Array.from({ length: count }, (_, i) => `criterion-${i}`);
      const reference: LatencyCardReference = { issueId: `card-${count}`, rubricRef: `rubric-${count}`,
        subjectRef: 'frozen-subject', keys };
      const snapshot: LatencyCardSnapshot = { ...reference, nKeys: count, complete: true,
        missingKeys: [], extraKeys: [], criteria: keys.map(key => ({ key, rating: 'pass', evidence: 'retained' })) };
      expect(pinLatencyCardFixture(reference, snapshot)).toMatchObject({ count, keys });
      const savedNine = ['traceability', 'fixture-calibration', 'falsifiability', 'correct-layer',
        'oracle-independence', 'execution-integrity', 'freshness', 'plan-class-risk-floor', 'disclosed-gap'];
      expect(latencyRecipeCriterionCompatibility(keys, savedNine)).toEqual({
        compatible: false, missing: keys, unexpected: savedNine,
      });
      expect(latencyRecipeCriterionCompatibility(keys, [...keys].reverse()).compatible).toBe(true);
    }
  });

  it('rejects missing, duplicate, wrong-card and incomplete historical evidence before measurement', () => {
    const reference: LatencyCardReference = { issueId: 'selected-card', rubricRef: 'selected-rubric',
      subjectRef: 'selected-subject', keys: ['a', 'b'] };
    const snapshot: LatencyCardSnapshot = { ...reference, nKeys: 2, complete: true, missingKeys: [], extraKeys: [],
      criteria: reference.keys.map(key => ({ key, rating: 'pass', evidence: `full-${key}` })) };
    for (const change of [
      { issueId: 'different-card' }, { rubricRef: 'different-rubric' }, { subjectRef: null },
      { nKeys: 9 }, { complete: false }, { missingKeys: ['b'] }, { extraKeys: ['c'] },
      { criteria: snapshot.criteria.slice(0, 1) },
      { criteria: [snapshot.criteria[0]!, snapshot.criteria[0]!] },
      { criteria: [...snapshot.criteria].reverse() },
      { criteria: snapshot.criteria.map(c => ({ ...c, evidence: '' })) },
      { criteria: snapshot.criteria.map(c => ({ ...c, rating: '' })) },
    ]) expect(() => pinLatencyCardFixture(reference, { ...snapshot, ...change })).toThrow();
    expect(() => pinLatencyCardFixture({ ...reference, keys: ['a', 'a'] }, snapshot)).toThrow();
    expect(() => latencyRecipeCriterionCompatibility([], ['a'])).toThrow();
    expect(() => latencyRecipeCriterionCompatibility(['a'], ['a', 'a'])).toThrow();
  });

  it('calibrates complete, wrong, incomplete and unauthorized controls before either arm', () => {
    const reference = { ids: ['hold-1', 'hold-2'], gap: 'unknown' };
    const check = (observed: unknown, authorized: boolean) => frozenOutputOracle(reference, observed, authorized);
    expect(calibrateLatencyOracle(check, { positive: reference,
      incorrect: { ids: ['hold-1', 'other'], gap: 'unknown' }, incomplete: { ids: ['hold-1'] } }))
      .toEqual({ positive: true, incorrect: false, incomplete: false, unauthorized: false });
    expect(() => calibrateLatencyOracle(() => true,
      { positive: reference, incorrect: {}, incomplete: {} })).toThrow(/calibration failed/);
    expect(() => calibrateLatencyOracle(() => false,
      { positive: reference, incorrect: {}, incomplete: {} })).toThrow(/calibration failed/);
  });

  it('computes thresholds separately for cold, warm and pooled cohorts at the exact boundaries', () => {
    const result = assessLatencyCohort(calibrationSamples());
    expect(result.verdict).toBe('pass');
    expect(result.strata.map(s => s.baseline?.elapsed.count)).toEqual([30, 30, 60]);
    expect(result.strata.map(s => s.ratios)).toEqual(Array(3).fill({ requests: 0.75, elapsed: 0.8, p95: 0.8 }));
    expect(result.recordedAttempts).toBe(120);
  });

  it('rejects a warm regression even when the pooled median meets its bar', () => {
    const rows = calibrationSamples();
    for (const row of rows) if (row.arm === 'candidate') row.actualElapsedMs = row.stratum === 'cold' ? 30 : 120;
    const result = assessLatencyCohort(rows);
    expect(result.strata.find(s => s.stratum === 'pooled')?.ratios?.elapsed).toBe(0.75);
    expect(result.strata.find(s => s.stratum === 'warm')?.passed).toBe(false);
    expect(result.verdict).toBe('fail');
  });

  it.each(['failed', 'aborted'] as const)('retains a %s attempt with the 600000ms penalty and actual elapsed', status => {
    const rows = calibrationSamples();
    rows[1] = { ...rows[1]!, status, actualElapsedMs: 17 };
    const result = assessLatencyCohort(rows);
    expect(result.verdict).toBe('fail');
    expect(result.recordedAttempts).toBe(120);
    expect(result.failed).toEqual([latencyAttemptId(rows[1]!)]);
    expect(result.samples[1]).toMatchObject({ actualElapsedMs: 17, scoredElapsedMs: 600_000 });
  });

  it('does not convert missing timings, missing evidence or missing attempts into zero or success', () => {
    const rows = calibrationSamples();
    rows[0] = { ...rows[0]!, actualElapsedMs: null };
    rows[1] = { ...rows[1]!, oracle: null };
    rows.pop();
    const result = assessLatencyCohort(rows);
    expect(result.verdict).toBe('unknown');
    expect(result.unknown).toHaveLength(2);
    expect(result.missing).toHaveLength(1);
    expect(result.samples[0]!.scoredElapsedMs).toBeNull();
    expect(result.strata.every(s => s.ratios === null)).toBe(true);
    expect(assessLatencyCohort([]).verdict).toBe('unknown');
  });

  it('counts provider retries while deduplicating only immutable gateway-attempt copies', () => {
    const rows = calibrationSamples();
    rows[1]!.gatewayAttemptIds = ['attempt-1', 'attempt-1', 'retry-2', 'retry-3'];
    expect(assessLatencyCohort(rows).samples[1]!.requests).toBe(3);
  });

  it('refuses duplicate and extra identities instead of changing the cohort denominator', () => {
    const rows = calibrationSamples();
    expect(() => assessLatencyCohort([...rows, rows[0]!])).toThrow(/Duplicate/);
    expect(() => assessLatencyCohort([...rows, { ...rows[0]!, task: 'T11' }])).toThrow(/Unexpected/);
  });

  it('rejects pair fixture or oracle drift and any failed quality control despite fast timings', () => {
    for (const change of [
      { pairFingerprint: 'c'.repeat(64) },
      { oracle: { passed: true, evidenceRef: 'changed', referenceSha256: 'd'.repeat(64) } },
      { oracle: { passed: false, evidenceRef: 'failed-control', referenceSha256: 'b'.repeat(64) } },
    ]) {
      const rows = calibrationSamples();
      rows[1] = { ...rows[1]!, actualElapsedMs: 0, ...change };
      expect(assessLatencyCohort(rows).verdict).toBe('fail');
    }
  });

  it('keeps undefined speedup from a zero baseline unknown', () => {
    const rows = calibrationSamples();
    for (const row of rows) { row.actualElapsedMs = 0; row.gatewayAttemptIds = []; }
    expect(assessLatencyCohort(rows).verdict).toBe('unknown');
  });
});
