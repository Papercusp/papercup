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
  validateScorecardRatingValues,
  canonicalScorecardRating,
  normalizeScorecardRatings,
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
      rubricRef: 'pot-coordination-health',
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
          rubricRef: 'pot-coordination-health',
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
        { rubricRef: 'pot-coordination-health', ratings: { placement: { rating: 'healthy', evidence: 'e' } } },
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

  it('rejects EXTRA rated keys and names them (WI-4761 trend-pollution guard)', () => {
    expect(() =>
      validateScorecardCompleteness(
        {
          rubricRef: 'pot-coordination-health',
          ratings: {
            placement: { rating: 'healthy', evidence: 'e' },
            wake: { rating: 'healthy', evidence: 'e' },
            federation: { rating: 'healthy', evidence: 'e' },
            extraKey: { rating: 'healthy', evidence: 'e' },
          },
        },
        required,
      ),
    ).toThrow(/unexpected criterion key\(s\): extraKey/);
  });

  it('reports missing and extra keys together so one retry can repair the whole scorecard', () => {
    expect(() =>
      validateScorecardCompleteness(
        {
          rubricRef: 'pot-coordination-health',
          ratings: {
            placement: { rating: 'healthy', evidence: 'e' },
            invented: { rating: 'healthy', evidence: 'e' },
          },
        },
        required,
      ),
    ).toThrow(/missing required criterion key\(s\): wake, federation; unexpected criterion key\(s\): invented/);
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
      rubricRef: 'pot-coordination-health',
      ratings: { 'end-to-end-flow': { rating: 'healthy', evidence: 'e1', suggestion: 'keep it' } },
      evidenceFingerprint: 'abc123',
      instrumentSnapshots: { flow: { verdict: 'pass' } },
    });
    expect(out).toBeDefined();
    expect(out?.kind).toBe('friction');
    expect(out?.sourceHive).toBe('papercusp');
    expect(out?.targetHive).toBe('shared-hive-test');
    expect(out?.rubricRef).toBe('pot-coordination-health');
    expect(out?.ratings?.['end-to-end-flow']).toEqual({ rating: 'healthy', evidence: 'e1', suggestion: 'keep it' });
    expect(out?.evidenceFingerprint).toBe('abc123');
    expect(out?.instrumentSnapshots).toEqual({ flow: { verdict: 'pass' } });
    expect(out?.refs).toEqual(['tool:pot:survey', 'WI-1']);
  });

  it('ignores unknown keys so B10 learnings/observationKind can ride alongside', () => {
    const out = asStructuredObservation({ rubricRef: 'r', learnings: ['x'], observationKind: 'deprecation' });
    expect(out?.rubricRef).toBe('r');
    expect((out as Record<string, unknown>).learnings).toBeUndefined();
  });

  // goal-mode-rubric-v2-2026-08-10 P-009. These guard a SILENT failure mode, not a
  // loud one: this parse is an allowlist, so a field added to the zod schema + the
  // interface but NOT taught here persists to payload.observation and then reads
  // back undefined forever. Nothing throws; the data is simply invisible, which is
  // exactly how the five v1 goal-mode-e2e scorecards ended up unattributable.
  it('round-trips the graded subject (the drill parameter binding)', () => {
    const out = asStructuredObservation({
      rubricRef: 'goal-mode-e2e',
      subject: {
        kind: 'agent-run',
        ref: 'su-12b70e95-84ce-4ea0-b546-8a692cdc949c',
        windowStart: '2026-08-10T00:00:00.000Z',
        windowEnd: '2026-08-10T23:59:59.000Z',
      },
    });
    expect(out?.subject).toEqual({
      kind: 'agent-run',
      ref: 'su-12b70e95-84ce-4ea0-b546-8a692cdc949c',
      windowStart: '2026-08-10T00:00:00.000Z',
      windowEnd: '2026-08-10T23:59:59.000Z',
    });
  });

  it('keeps a subject that carries only ref (window + kind are optional)', () => {
    const out = asStructuredObservation({ subject: { ref: 'WI-37831' } });
    expect(out?.subject).toEqual({ ref: 'WI-37831' });
  });

  it('DROPS a subject with no usable ref rather than half-keeping it', () => {
    // A subject block that cannot say WHAT it graded is worse than none: it reads
    // as "identity recorded" to every consumer while answering nothing.
    for (const bad of [{ kind: 'agent-run' }, { ref: '' }, { ref: '   ' }, { ref: 42 }]) {
      expect(asStructuredObservation({ rubricRef: 'r', subject: bad })?.subject).toBeUndefined();
    }
    expect(asStructuredObservation({ rubricRef: 'r', subject: 'su-123' })?.subject).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', subject: ['su-123'] })?.subject).toBeUndefined();
  });

  it('drops unknown keys INSIDE subject (the allowlist holds one level down too)', () => {
    const out = asStructuredObservation({
      subject: { ref: 'su-1', runId: 'nope', notes: 'also nope' },
    });
    expect(out?.subject).toEqual({ ref: 'su-1' });
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

  // ── the vetting stamp (consult-min-max-and-rubric-vetting-2026-08-17 P-004) ──

  it('surfaces a well-formed vetting stamp, extra keys dropped', () => {
    const out = asStructuredObservation({
      rubricRef: 'meta-acceptance-rubric',
      subject: { kind: 'rubric', ref: 'ar-some-plan' },
      vetting: { consultId: 'conv-1', rubricRevision: 7, junk: 'nope' },
    });
    expect(out?.vetting).toEqual({ consultId: 'conv-1', rubricRevision: 7 });
    expect(out?.subject).toEqual({ kind: 'rubric', ref: 'ar-some-plan' });
  });

  it('discards a vetting block that cannot name its consult (consultId is load-bearing)', () => {
    expect(asStructuredObservation({ rubricRef: 'r', vetting: { rubricRevision: 7 } })?.vetting).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', vetting: { consultId: '  ' } })?.vetting).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', vetting: 'conv-1' })?.vetting).toBeUndefined();
    expect(asStructuredObservation({ rubricRef: 'r', vetting: ['conv-1'] })?.vetting).toBeUndefined();
  });

  it('drops a non-numeric rubricRevision but keeps the consult linkage', () => {
    const out = asStructuredObservation({ rubricRef: 'r', vetting: { consultId: 'conv-1', rubricRevision: '7' } });
    expect(out?.vetting).toEqual({ consultId: 'conv-1' });
  });
});

describe('canonical scorecard ratings (EI-12458)', () => {
  const rubric = {
    ratingScale: ['PASS', 'AT-RISK', 'FAIL', 'UNKNOWN'],
    criteria: [
      { key: 'a' },
      { key: 'b', ratingScale: ['healthy', 'degraded', 'broken', 'unknown'] },
    ],
  };

  it('resolves case-insensitively to the exact rubric spelling', () => {
    expect(canonicalScorecardRating('pass', rubric.ratingScale)).toBe('PASS');
    expect(canonicalScorecardRating(' At-Risk ', rubric.ratingScale)).toBe('AT-RISK');
    expect(canonicalScorecardRating('unknown', ['PASS', 'FAIL'])).toBe('unknown');
  });

  it('normalizes every entry without losing evidence or suggestions', () => {
    expect(
      normalizeScorecardRatings(
        {
          a: { rating: 'pass', evidence: 'metric=1', suggestion: 'retain' },
          b: { rating: 'HEALTHY', evidence: 'metric=2' },
        },
        rubric,
      ),
    ).toEqual({
      a: { rating: 'PASS', evidence: 'metric=1', suggestion: 'retain' },
      b: { rating: 'healthy', evidence: 'metric=2' },
    });
  });
});

describe('validateScorecardRatingValues — the P-002 rating-VALUE gate (rubric-system-improvements-2026-07-12)', () => {
  const rubric = {
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
    criteria: [
      { key: 'placement' },
      { key: 'wake', ratingScale: ['exemplary', 'pass', 'partial', 'fail', 'severe', 'unknown'] },
    ],
  };
  const sc = (ratings: Record<string, { rating: string; evidence: string }>): StructuredObservation => ({
    rubricRef: 'r',
    ratings,
  });

  it('passes on-scale ratings (rubric default + per-criterion override, case-insensitive)', () => {
    expect(() =>
      validateScorecardRatingValues(
        sc({
          placement: { rating: 'Healthy', evidence: 'e' },
          wake: { rating: 'exemplary', evidence: 'e' },
        }),
        rubric,
      ),
    ).not.toThrow();
  });

  it("rejects an off-scale rating, naming the key, the value, and the allowed values (the silent-exclusion class of the missing-pass-vocabulary bug)", () => {
    let err: unknown;
    try {
      validateScorecardRatingValues(sc({ placement: { rating: 'pas', evidence: 'e' } }), rubric);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ObservationEvidenceError);
    const msg = String((err as Error).message);
    expect(msg).toContain("'placement'");
    expect(msg).toContain("'pas'");
    expect(msg).toContain('healthy | degraded | broken | unknown');
  });

  it('a per-criterion scale override governs that criterion (rubric default does not leak in)', () => {
    // 'healthy' is on the RUBRIC scale but not on wake's override.
    expect(() => validateScorecardRatingValues(sc({ wake: { rating: 'healthy', evidence: 'e' } }), rubric)).toThrow(
      ObservationEvidenceError,
    );
  });

  it("'unknown' is always accepted, even off a scale that omits it", () => {
    const noUnknown = { ratingScale: ['healthy', 'degraded'], criteria: [{ key: 'c' }] };
    expect(() => validateScorecardRatingValues(sc({ c: { rating: 'unknown', evidence: 'e' } }), noUnknown)).not.toThrow();
  });

  it('skips when the rubric is null/unloaded or scale-less (unenforceable, like completeness)', () => {
    expect(() => validateScorecardRatingValues(sc({ c: { rating: 'whatever', evidence: 'e' } }), null)).not.toThrow();
    expect(() =>
      validateScorecardRatingValues(sc({ c: { rating: 'whatever', evidence: 'e' } }), { criteria: [{ key: 'c' }] }),
    ).not.toThrow();
  });

  it('passes free-text / no-ratings observations unconditionally', () => {
    expect(() => validateScorecardRatingValues({ kind: 'friction' }, rubric)).not.toThrow();
    expect(() => validateScorecardRatingValues(undefined, rubric)).not.toThrow();
  });
});
