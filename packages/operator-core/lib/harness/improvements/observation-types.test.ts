/**
 * observation-types.test.ts — the structured-observation v2 contract
 * (rubric-driven-observations-2026-06-20 P-001 / D-002 / D-003).
 *
 * Pure unit tests: the mandatory-evidence gate + the read-side surfacing helper.
 */
import { describe, it, expect } from 'vitest';
import {
  validateObservationRatings,
  validateScorecardCompleteness,
  asStructuredObservation,
  ObservationEvidenceError,
  OBSERVATION_RATING_SCALE,
  type StructuredObservation,
} from './observation-types';

describe('OBSERVATION_RATING_SCALE', () => {
  it('is the reconciled 4-value scale (D-003)', () => {
    expect(OBSERVATION_RATING_SCALE).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
  });
});

describe('validateObservationRatings — the D-002 mandatory-evidence gate', () => {
  it('passes a free-text observation (no ratings) — free-text stays first-class', () => {
    expect(() => validateObservationRatings({ kind: 'friction', confidence: 'high' })).not.toThrow();
    expect(() => validateObservationRatings(undefined)).not.toThrow();
    expect(() => validateObservationRatings(null)).not.toThrow();
    expect(() => validateObservationRatings({})).not.toThrow();
  });

  it('passes an empty ratings block', () => {
    expect(() => validateObservationRatings({ rubricRef: 'r', ratings: {} })).not.toThrow();
  });

  it('rejects ratings without a rubricRef (a rating must name its rubric)', () => {
    expect(() =>
      validateObservationRatings({ ratings: { 'placement-health': { rating: 'healthy', evidence: 'e' } } }),
    ).toThrow(ObservationEvidenceError);
    expect(() =>
      validateObservationRatings({ rubricRef: '   ', ratings: { k: { rating: 'healthy', evidence: 'e' } } }),
    ).toThrow(/must name the rubric/);
  });

  it('rejects a rating with missing / blank evidence (the core invariant)', () => {
    expect(() =>
      validateObservationRatings({ rubricRef: 'r', ratings: { 'placement-health': { rating: 'broken', evidence: '' } } }),
    ).toThrow(/missing required evidence/);
    expect(() =>
      validateObservationRatings({ rubricRef: 'r', ratings: { 'placement-health': { rating: 'broken', evidence: '   ' } } }),
    ).toThrow(ObservationEvidenceError);
  });

  it('rejects a blank rating value', () => {
    expect(() =>
      validateObservationRatings({ rubricRef: 'r', ratings: { k: { rating: '', evidence: 'e' } } }),
    ).toThrow(/rating is required/);
  });

  it('rejects an empty criterion key', () => {
    expect(() =>
      validateObservationRatings({ rubricRef: 'r', ratings: { '': { rating: 'healthy', evidence: 'e' } } }),
    ).toThrow(/empty criterion key/);
  });

  it('rejects a non-object rating entry', () => {
    expect(() =>
      // a malformed payload (e.g. from a hand-rolled writer) must not slip through.
      validateObservationRatings({ rubricRef: 'r', ratings: { k: 'healthy' as unknown as { rating: string; evidence: string } } }),
    ).toThrow(/not a \{rating, evidence\} object/);
  });

  it('passes a fully-evidenced scorecard', () => {
    const obs: StructuredObservation = {
      scope: 'papercusp',
      rubricRef: 'hive-coordination-health',
      ratings: {
        'end-to-end-flow': { rating: 'healthy', evidence: '8 completions/hr last window (hive_throughput_ticks)' },
        'watchdog-determinism': { rating: 'degraded', evidence: 'EI-1607 throttle still live' },
        'tool-utilization': { rating: 'unknown', evidence: 'no tool-call samples this idle wake' },
      },
    };
    expect(() => validateObservationRatings(obs)).not.toThrow();
  });
});

describe('validateScorecardCompleteness — the P-014a completeness gate', () => {
  const required = ['placement', 'wake', 'federation'];

  it('passes a complete scorecard (every required criterion rated)', () => {
    expect(() =>
      validateScorecardCompleteness(
        {
          rubricRef: 'hive-coordination-health',
          ratings: {
            placement: { rating: 'healthy', evidence: 'e' },
            wake: { rating: 'healthy', evidence: 'e' },
            federation: { rating: 'degraded', evidence: 'e' },
          },
        },
        required,
      ),
    ).not.toThrow();
  });

  it('rejects a partial scorecard, naming the missing key(s) (the D-005 silent-truncation)', () => {
    let err: unknown;
    try {
      validateScorecardCompleteness(
        { rubricRef: 'hive-coordination-health', ratings: { placement: { rating: 'healthy', evidence: 'e' } } },
        required,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ObservationEvidenceError);
    const msg = String((err as Error).message);
    expect(msg).toContain('INCOMPLETE');
    expect(msg).toContain('wake'); // both missing keys are named (fail-loud)
    expect(msg).toContain('federation');
  });

  it('passes a free-text / no-ratings observation (rubrics augment, never force)', () => {
    expect(() => validateScorecardCompleteness({ kind: 'friction' }, required)).not.toThrow();
    expect(() => validateScorecardCompleteness(undefined, required)).not.toThrow();
    expect(() => validateScorecardCompleteness({ rubricRef: 'r', ratings: {} }, required)).not.toThrow();
  });

  it('skips when requiredKeys is null/empty (unknown or criteria-less rubric — unenforceable)', () => {
    const partial: StructuredObservation = {
      rubricRef: 'r',
      ratings: { placement: { rating: 'healthy', evidence: 'e' } },
    };
    expect(() => validateScorecardCompleteness(partial, null)).not.toThrow();
    expect(() => validateScorecardCompleteness(partial, [])).not.toThrow();
  });

  it('ignores EXTRA rated keys beyond the rubric (only MISSING keys fail — completeness, not exactness)', () => {
    expect(() =>
      validateScorecardCompleteness(
        {
          rubricRef: 'hive-coordination-health',
          ratings: {
            placement: { rating: 'healthy', evidence: 'e' },
            wake: { rating: 'healthy', evidence: 'e' },
            federation: { rating: 'healthy', evidence: 'e' },
            extraKey: { rating: 'healthy', evidence: 'e' },
          },
        },
        required,
      ),
    ).not.toThrow();
  });
});

describe('asStructuredObservation — read-side payload surfacing', () => {
  it('round-trips a full v2 observation', () => {
    const out = asStructuredObservation({
      kind: 'friction',
      scope: 'papercusp',
      confidence: 'high',
      refs: ['tool:pot:survey', 'WI-1'],
      sourceHive: 'papercusp',
      targetHive: 'shared-hive-test',
      rubricRef: 'hive-coordination-health',
      ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'e1' } },
    });
    expect(out).toBeDefined();
    expect(out?.kind).toBe('friction');
    expect(out?.sourceHive).toBe('papercusp');
    expect(out?.targetHive).toBe('shared-hive-test');
    expect(out?.rubricRef).toBe('hive-coordination-health');
    expect(out?.ratings?.['end-to-end-flow']).toEqual({ rating: 'healthy', evidence: 'e1' });
    expect(out?.refs).toEqual(['tool:pot:survey', 'WI-1']);
  });

  it('ignores unknown keys so B10 learnings/observationKind can ride alongside', () => {
    const out = asStructuredObservation({ rubricRef: 'r', learnings: ['x'], observationKind: 'deprecation' });
    expect(out?.rubricRef).toBe('r');
    expect((out as Record<string, unknown>).learnings).toBeUndefined();
  });

  it('drops malformed ratings entries but keeps the valid ones', () => {
    const out = asStructuredObservation({
      ratings: { good: { rating: 'healthy', evidence: 'e' }, missingEvidence: { rating: 'healthy' }, junk: 5 },
    });
    expect(out?.ratings?.good).toEqual({ rating: 'healthy', evidence: 'e' });
    expect(out?.ratings?.missingEvidence).toBeUndefined();
    expect(out?.ratings?.junk).toBeUndefined();
  });

  it('returns undefined for non-object / empty / unknown-only input', () => {
    expect(asStructuredObservation(null)).toBeUndefined();
    expect(asStructuredObservation(5)).toBeUndefined();
    expect(asStructuredObservation('x')).toBeUndefined();
    expect(asStructuredObservation({})).toBeUndefined();
    expect(asStructuredObservation({ unknownOnly: 1 })).toBeUndefined();
  });
});
