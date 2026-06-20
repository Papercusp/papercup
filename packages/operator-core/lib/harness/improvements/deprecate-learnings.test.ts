/**
 * deprecate-learnings.test.ts — pins the Queen↔Scout deprecate→learnings
 * observation builder (queen-scout-feedback-loop-2026-06-20 P-006 / B10).
 *
 * PURE tests: buildDeprecateLearningsObservation does no I/O, so every invariant
 * is asserted without PG. emitDeprecateLearnings is exercised with a fake writer.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildDeprecateLearningsObservation,
  emitDeprecateLearnings,
  DEPRECATE_LEARNINGS_OBSERVATION_KIND,
  type DeprecateLearningsInput,
} from './deprecate-learnings';
import type { CaptureImprovementInput, CaptureImprovementResult } from './capture-core';
import type { StructuredObservation } from './observation-types';

const base: DeprecateLearningsInput = {
  planSlug: 'flaky-test-detector-2026-06-20',
  deprecatedBy: 'Queen',
  sourceHive: 'papercusp',
  learnings: {
    tried: 'A heuristic clustering retried CI lines into a flake score.',
    stalled: 'The score had no ground truth to calibrate against, so it never beat a coin flip.',
    salvageable: 'The retry-marker parser is reusable; the scoring premise is not.',
  },
  createdBy: 'su-abc',
};

/** Pull the StructuredObservation that rides payload.observation. */
function obsOf(input: CaptureImprovementInput): StructuredObservation {
  return (input.payloadExtra?.observation ?? {}) as StructuredObservation;
}
function deprecateMetaOf(input: CaptureImprovementInput): Record<string, unknown> {
  return (input.payloadExtra?.deprecateLearnings ?? {}) as Record<string, unknown>;
}

describe('buildDeprecateLearningsObservation — capture shape', () => {
  it('emits into the observation lane, source-tagged + force, organic', () => {
    const out = buildDeprecateLearningsObservation(base);
    expect(out.lane).toBe('observation');
    expect(out.origin).toBe('organic');
    expect(out.force).toBe(true);
    expect(out.kind).toBe('change');
    expect(out.severity).toBe('nit');
    // Source-tag rides the existing scope axis (the digest's per-Hive lens).
    expect(out.scope).toBe('harness:papercusp');
    expect(out.createdBy).toBe('su-abc');
  });

  it('title carries the slug + stall reason (so the digest clusters dead-ends)', () => {
    const out = buildDeprecateLearningsObservation(base);
    expect(out.title).toContain('flaky-test-detector-2026-06-20');
    expect(out.title).toContain('no ground truth');
  });

  it('truncates a very long stall reason in the title', () => {
    const out = buildDeprecateLearningsObservation({
      ...base,
      learnings: { ...base.learnings, stalled: 'x'.repeat(400) },
    });
    expect(out.title.length).toBeLessThan(200);
    expect(out.title).toContain('…');
  });

  it('body carries all three free-text learnings + provenance', () => {
    const out = buildDeprecateLearningsObservation(base);
    const body = out.body ?? '';
    expect(body).toContain(base.learnings.tried);
    expect(body).toContain(base.learnings.stalled);
    expect(body).toContain(base.learnings.salvageable);
    expect(body).toContain('Source hive: papercusp');
    expect(body).toContain('Decided by: Queen');
  });
});

describe('buildDeprecateLearningsObservation — payload.observation (StructuredObservation v2)', () => {
  it('writes the v2 fields camelCase under payload.observation', () => {
    const obs = obsOf(buildDeprecateLearningsObservation(base));
    expect(obs.sourceHive).toBe('papercusp'); // camelCase — converges with B1
    expect(obs.kind).toBe('gap');
    expect(obs.scope).toBe('harness');
    expect(obs.confidence).toBe('med');
    expect(obs.targetHive).toBeUndefined();
    expect(obs.rubricRef).toBeUndefined();
    expect(obs.ratings).toBeUndefined();
  });

  it('always grounds refs on the deprecated plan, de-duping provided evidence', () => {
    const obs = obsOf(
      buildDeprecateLearningsObservation({
        ...base,
        evidence: ['wi:WI-42', 'plan:flaky-test-detector-2026-06-20'],
      }),
    );
    expect(obs.refs?.[0]).toBe('plan:flaky-test-detector-2026-06-20');
    expect(obs.refs).toContain('wi:WI-42');
    // The plan ref appears exactly once (provided dup folded in).
    expect(obs.refs?.filter((r) => r === 'plan:flaky-test-detector-2026-06-20')).toHaveLength(1);
  });

  it('carries targetHive (cross-hive) into the observation + body', () => {
    const out = buildDeprecateLearningsObservation({ ...base, targetHive: 'sheets' });
    expect(obsOf(out).targetHive).toBe('sheets');
    expect(out.body).toContain('Target hive: sheets');
  });

  it('forwards a rubric-graded variant (rubricRef + ratings) through to the observation', () => {
    const out = buildDeprecateLearningsObservation({
      ...base,
      rubricRef: 'idea-quality',
      ratings: { premise: { rating: 'broken', evidence: 'never beat a coin flip in 200 runs' } },
    });
    const obs = obsOf(out);
    expect(obs.rubricRef).toBe('idea-quality');
    expect(obs.ratings?.premise).toEqual({ rating: 'broken', evidence: 'never beat a coin flip in 200 runs' });
  });
});

describe('buildDeprecateLearningsObservation — deprecate metadata + attribution', () => {
  it('records the deprecate-specific metadata under payload.deprecateLearnings', () => {
    const meta = deprecateMetaOf(buildDeprecateLearningsObservation(base));
    expect(meta.kind).toBe(DEPRECATE_LEARNINGS_OBSERVATION_KIND);
    expect(meta.planSlug).toBe('flaky-test-detector-2026-06-20');
    expect(meta.deprecatedBy).toBe('Queen');
    expect(meta.tried).toBe(base.learnings.tried);
    expect(meta.stalled).toBe(base.learnings.stalled);
    expect(meta.salvageable).toBe(base.learnings.salvageable);
  });

  it('maps deprecatedBy → the capture sourceRole (owner → human)', () => {
    expect(buildDeprecateLearningsObservation({ ...base, deprecatedBy: 'Queen' }).sourceRole).toBe('Queen');
    expect(buildDeprecateLearningsObservation({ ...base, deprecatedBy: 'Scout' }).sourceRole).toBe('Scout');
    expect(buildDeprecateLearningsObservation({ ...base, deprecatedBy: 'owner' }).sourceRole).toBe('human');
  });

  it('omits createdBy when not supplied', () => {
    const { createdBy: _omit, ...noCreator } = base;
    expect(buildDeprecateLearningsObservation(noCreator).createdBy).toBeUndefined();
  });
});

describe('emitDeprecateLearnings', () => {
  const fakeResult: CaptureImprovementResult = {
    ok: true,
    created: true,
    possibleDuplicates: [],
    issue: { id: 'EI-999' } as CaptureImprovementResult['issue'],
  };

  it('hands the built input to the injected writer and returns its result', async () => {
    const captureImprovement = vi.fn().mockResolvedValue(fakeResult);
    const res = await emitDeprecateLearnings(base, { captureImprovement });
    expect(captureImprovement).toHaveBeenCalledTimes(1);
    const passed = captureImprovement.mock.calls[0][0] as CaptureImprovementInput;
    expect(passed).toEqual(buildDeprecateLearningsObservation(base));
    expect(passed.lane).toBe('observation');
    expect(res).toBe(fakeResult);
  });

  it('forwards a rubric-graded variant so capture-core can run the v2 evidence gate', async () => {
    const captureImprovement = vi.fn().mockResolvedValue(fakeResult);
    await emitDeprecateLearnings(
      { ...base, rubricRef: 'idea-quality', ratings: { premise: { rating: 'broken', evidence: 'e' } } },
      { captureImprovement },
    );
    const passed = captureImprovement.mock.calls[0][0] as CaptureImprovementInput;
    const obs = (passed.payloadExtra?.observation ?? {}) as StructuredObservation;
    expect(obs.rubricRef).toBe('idea-quality');
    expect(obs.ratings?.premise.evidence).toBe('e');
  });
});
