import { describe, expect, it } from 'vitest';
import {
  assessLatencyCohort, assessLatencyExperiment, assertLatencyPhaseOrder, calibrateLatencyOracle, frozenOutputOracle,
  latencyAttemptId, latencyAttemptSchedule, latencyDistribution, latencyFixtureDigest,
  latencyRecipeCriterionCompatibility, pinLatencyCardFixture, latencyDataFixtures,
  latencyIntervalReference, pinLatencySiblingFixture, type LatencyReferenceInterval,
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
  it('clips intervals before partitioning overlap and never adds nested stages twice', () => {
    const input: LatencyReferenceInterval[] = [
      { id: 'model', sourceRef: 'gateway:original', kind: 'model', startMs: -10, endMs: 30 },
      { id: 'tool', sourceRef: 'native:terminal', kind: 'tool', startMs: 20, endMs: 70 },
      { id: 'stage', sourceRef: 'handler:stage', kind: 'tool', startMs: 25, endMs: 35, parentId: 'tool' },
      { id: 'next', sourceRef: 'native:next', kind: 'tool', startMs: 70, endMs: 110 },
    ];
    const result = latencyIntervalReference({ startMs: 0, endMs: 100 }, [...input, input[1]!]);
    expect(result).toMatchObject({ wallMs: 100, knownMs: 100, coveragePercent: 100,
      modelOnlyMs: 20, toolOnlyMs: 70, overlapMs: 10, unobservedMs: 0 });
    expect(result.intervals).toHaveLength(3);
    expect(result.subdivisions).toHaveLength(1);
    expect(input[0]!.startMs).toBe(-10);
  });

  it('agrees with an independent per-millisecond occupancy oracle over every small two-span placement', () => {
    for (let a = -1; a <= 5; a++) for (let b = a; b <= 6; b++)
      for (let c = -1; c <= 5; c++) for (let d = c; d <= 6; d++) {
        const result = latencyIntervalReference({ startMs: 0, endMs: 5 }, [
          { id: 'a', sourceRef: 'fixture:a', kind: 'model', startMs: a, endMs: b },
          { id: 'b', sourceRef: 'fixture:b', kind: 'tool', startMs: c, endMs: d },
        ]);
        const cells = Array.from({ length: 5 }, (_, i) => (a <= i && b > i ? 1 : 0)
          + (c <= i && d > i ? 2 : 0));
        expect([result.unobservedMs, result.modelOnlyMs, result.toolOnlyMs, result.overlapMs])
          .toEqual([0, 1, 2, 3].map(mask => cells.filter(cell => cell === mask).length));
      }
  });

  it('retains absent spans as unobserved and rejects conflicting IDs or unproved stage parents', () => {
    expect(latencyIntervalReference({ startMs: 0, endMs: 10 }, [])).toMatchObject({
      knownMs: 0, coveragePercent: 0, unobservedMs: 10 });
    const row: LatencyReferenceInterval = { id: 'a', sourceRef: 'fixture:a', kind: 'tool', startMs: 1, endMs: 5 };
    for (const rows of [[row, { ...row, endMs: 6 }], [{ ...row, parentId: 'missing' }],
      [{ ...row, endMs: 0 }], [{ ...row, endMs: NaN }], [{ ...row, sourceRef: '' }]]) {
      expect(() => latencyIntervalReference({ startMs: 0, endMs: 10 }, rows)).toThrow(/LATENCY-M1/);
    }
  });

  it('pins sibling order, original recipe and explicit recipe absence; rejects clipped or wrong-scope pages', () => {
    const reference = { issueId: 'card-a', rubricRef: 'rubric-a', subjectRef: 'subject-a' };
    const snapshot = { ...reference, rerunRecipe: { evaluator: 'fixture:read', args: { subject: 'subject-a' } },
      count: 1, hasMore: false, truncatedByLimit: false, nextCursor: null,
      siblings: [{ ...reference, createdAt: '2026-11-07T00:00:00Z', supersededBy: null, retracted: false }] };
    expect(pinLatencySiblingFixture(reference, snapshot)).toMatchObject({ count: 1, recipePresent: true });
    expect(pinLatencySiblingFixture(reference, { ...snapshot, rerunRecipe: null })).toMatchObject({ recipePresent: false });
    for (const patch of [{ count: 2 }, { hasMore: true }, { truncatedByLimit: true }, { nextCursor: {} },
      { subjectRef: 'wrong' }, { rerunRecipe: { omittedChars: { args: 20 } } },
      { siblings: [{ ...snapshot.siblings[0]!, rubricRef: 'wrong' }] }]) {
      expect(() => pinLatencySiblingFixture(reference, { ...snapshot, ...patch })).toThrow(/LATENCY-M1/);
    }
    const check = (observed: unknown, authorized: boolean) => frozenOutputOracle(snapshot, observed, authorized);
    expect(calibrateLatencyOracle(check, { positive: snapshot,
      incorrect: { ...snapshot, rerunRecipe: null }, incomplete: { ...snapshot, siblings: [] } }))
      .toEqual({ positive: true, incorrect: false, incomplete: false, unauthorized: false });
  });

  it('materializes the frozen 10000-row populations with stable scope, identities and explicit controls', () => {
    const fixture = latencyDataFixtures();
    expect(latencyFixtureDigest(fixture)).toBe(latencyFixtureDigest(latencyDataFixtures()));
    expect(fixture.seed).toBe('LATENCY-M1-v2-20261107');
    expect(fixture.anchorMs).toBe(Date.parse('2026-11-06T00:00:00.000Z'));
    expect(fixture.workItems).toHaveLength(10_000);
    expect(fixture.conditionEnvelopes).toHaveLength(10_000);
    expect(new Set(fixture.workItems.map(row => row.feature_id)).size).toBe(10_000);
    expect(new Set(fixture.conditionEnvelopes.map(row => row.msg_id)).size).toBe(10_000);
    expect(fixture.coverageReference.map(row => row.eligibleIds)).toEqual([
      ['WI-8000000'], ['WI-8000001'], ['WI-8000002'], ['WI-8000003'],
      ['WI-8000005'], ['WI-8000006'], ['WI-8000009'], [], [],
    ]);
    expect(fixture.workItems[3]!.status).toBe('done');
    expect(fixture.workItems[4]!.payload._claimHold).toBe(true);
    expect(fixture.workItems[5]!.payload._claimHold).toBeUndefined();
    expect(fixture.workItems[7]!.summary).toBe('Plan: latency-acceptance-coverage item P-0060');
    expect(fixture.workItems[8]!.summary).toBe('xPlan: latency-acceptance-coverage item P-006');
    expect(fixture.workItems[10]!.workspace_id).toBe('latency-acceptance-other');
    expect(fixture.workItems[11]!.harness_slug).toBe('other-harness');
  });

  it('calibrates complete hold-set evidence against lost old holds, extra keys and denied authority', () => {
    const fixture = latencyDataFixtures();
    const reference = fixture.conditionReference;
    const busy = 'latency-acceptance:busy:';
    expect(Object.values(reference).flat()).toHaveLength(20);
    const oldAlarms = fixture.conditionEnvelopes.slice(0, 20);
    expect(oldAlarms.every(row => row.ts === '2026-10-07T00:00:00.000Z')).toBe(true);
    const check = (observed: unknown, authorized: boolean) => frozenOutputOracle(reference, observed, authorized);
    expect(calibrateLatencyOracle(check, { positive: reference,
      incorrect: { ...reference, [busy]: [...reference[busy]!, busy + 'closed-exact'] },
      incomplete: { ...reference, [busy]: reference[busy]!.slice(1) } }))
      .toEqual({ positive: true, incorrect: false, incomplete: false, unauthorized: false });
    const changed = latencyDataFixtures();
    changed.conditionEnvelopes.pop();
    expect(latencyFixtureDigest(changed)).not.toBe(latencyFixtureDigest(fixture));
    changed.workItems[0]!.payload = {};
    expect(fixture.workItems[0]!.payload).toHaveProperty('plan_item');
  });

  it('keeps 60 matched pairs in complete baseline/candidate phases with identical within-arm order', () => {
    const schedule = latencyAttemptSchedule();
    expect(schedule).toHaveLength(120);
    expect(new Set(schedule.map(latencyAttemptId)).size).toBe(120);
    for (const task of Array.from({ length: 10 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`)) {
      for (const stratum of ['cold', 'warm']) {
        expect(schedule.filter(a => a.task === task && a.stratum === stratum).map(a => a.arm))
          .toEqual(['baseline', 'baseline', 'baseline', 'candidate', 'candidate', 'candidate']);
      }
    }
    expect(schedule.slice(0, 60).every(a => a.arm === 'baseline')).toBe(true);
    expect(schedule.slice(60).every(a => a.arm === 'candidate')).toBe(true);
    expect(schedule.slice(0, 60).map(({ arm, ...key }) => key))
      .toEqual(schedule.slice(60).map(({ arm, ...key }) => key));
  });

  function phaseReceipts(): Parameters<typeof assertLatencyPhaseOrder>[0][number][] {
    const samples = calibrationSamples();
    const events: ReturnType<typeof phaseReceipts> = [{ kind: 'baseline-ready', atMs: 0,
      evidenceRef: 'calibration:preflight', producerId: 'producer', contractSha256: 'a'.repeat(64),
      sourceSha256: 'b'.repeat(64), calibrationSha256: 'c'.repeat(64), environmentSha256: 'd'.repeat(64) }];
    for (const [i, attempt] of samples.slice(0, 60).entries()) events.push({ kind: 'attempt',
      startedAtMs: i * 101 + 1, atMs: i * 101 + 101, evidenceRef: `calibration:baseline:${i}`, attempt });
    events.push({ kind: 'baseline-accepted', atMs: 6061, evidenceRef: 'calibration:independent-review',
      reviewerId: 'independent-reviewer', baselineSha256: latencyFixtureDigest(events) });
    events.push({ kind: 'product-edit', atMs: 6062, evidenceRef: 'calibration:edit' });
    events.push({ kind: 'candidate-ready', atMs: 6063, evidenceRef: 'calibration:candidate',
      contractSha256: 'a'.repeat(64), sourceSha256: 'e'.repeat(64), calibrationSha256: 'c'.repeat(64),
      baselineEnvironmentSha256: 'd'.repeat(64), environmentSha256: 'f'.repeat(64),
      comparability: 'comparable', comparabilityEvidenceRef: 'calibration:environment-comparison' });
    for (const [i, attempt] of samples.slice(60).entries()) events.push({ kind: 'attempt',
      startedAtMs: i * 81 + 6064, atMs: i * 81 + 6144, evidenceRef: `calibration:candidate:${i}`, attempt });
    return events;
  }

  it('admits only independently accepted baseline bytes before edits and pinned candidate measurements', () => {
    const events = phaseReceipts();
    expect(assertLatencyPhaseOrder(events.slice(0, 61))).toMatchObject({ attempts: 60, baselineAccepted: false });
    expect(assessLatencyExperiment(events)).toMatchObject({ verdict: 'pass',
      phase: { complete: true, baselineAccepted: true, candidateReady: true, comparable: true } });
  });

  it('refuses early edits/candidates, reordered/duplicate/extra attempts, and overlapping measured tasks', () => {
    const rows = phaseReceipts();
    for (const events of [
      [rows[0]!, rows[62]!],
      [...rows.slice(0, 61), rows[63]!],
      [...rows.slice(0, 64), rows[65]!, rows[64]!],
      [...rows, rows.at(-1)!],
      [...rows.slice(0, 60), rows[61]!],
      [rows[0]!, rows[1]!, { ...rows[2]!, startedAtMs: 1 }],
    ]) expect(() => assertLatencyPhaseOrder(events)).toThrow(/LATENCY-M1/);
  });

  it('refuses self acceptance, changed baseline bytes, missing review and changed candidate contracts', () => {
    for (const patch of [{ reviewerId: 'producer' }, { baselineSha256: '0'.repeat(64) }, { evidenceRef: '' }]) {
      const events = phaseReceipts();
      events[61] = { ...events[61]!, ...patch };
      expect(() => assertLatencyPhaseOrder(events)).toThrow(/LATENCY-M1/);
    }
    for (const patch of [{ contractSha256: '0'.repeat(64) }, { calibrationSha256: '0'.repeat(64) },
      { baselineEnvironmentSha256: '0'.repeat(64) }, { comparabilityEvidenceRef: '' }]) {
      const events = phaseReceipts();
      events[63] = { ...events[63]!, ...patch };
      expect(() => assertLatencyPhaseOrder(events)).toThrow(/LATENCY-M1/);
    }
  });

  it('keeps missing phases and unresolved unrelated environment drift UNKNOWN despite fast arithmetic', () => {
    const events = phaseReceipts();
    expect(assessLatencyExperiment(events.slice(0, 61)).verdict).toBe('unknown');
    events[63] = { ...events[63]!, comparability: 'unknown' } as typeof events[number];
    expect(assessLatencyExperiment(events)).toMatchObject({ verdict: 'unknown', phase: { comparable: false } });
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
      rows[60] = { ...rows[60]!, actualElapsedMs: 0, ...change };
      expect(assessLatencyCohort(rows).verdict).toBe('fail');
    }
  });

  it('keeps undefined speedup from a zero baseline unknown', () => {
    const rows = calibrationSamples();
    for (const row of rows) { row.actualElapsedMs = 0; row.gatewayAttemptIds = []; }
    expect(assessLatencyCohort(rows).verdict).toBe('unknown');
  });
});
