/**
 * The threshold derivation, and the controls that prove it can refuse.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (P-008).
 *
 * A derivation that has only ever been run on the committed artifact is a
 * derivation nobody has watched say no. So every refusal below is driven with a
 * hand-built measurement kept PERMANENTLY in this file as a control, alongside a
 * calibration case the real artifact must pass. Without the calibration cases,
 * the controls would still pass if `derivePolicyFor` simply returned
 * advisory-only for everything.
 *
 * Nothing here mutates a file on disk: the subject is a pure function of a
 * measurement, so the repo's mutation-probe tier-1 applies — a deliberately
 * wrong input, never a deliberately wrong tree.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { computeVerdict } from './contract';
import { SEPARATION_FLOOR } from './corpus/harness';
import {
  CALIBRATION,
  CURRENT_POLICY_VERSION,
  UncalibratedReferenceClassError,
  UnknownPolicyVersionError,
  calibratedClasses,
  derivePolicyFor,
  explainPolicy,
  resolvePolicy,
} from './policy';
import type { ClassCalibration } from './policy-shape';

/** The legacy build-regression threshold D-005 forbids inheriting. */
const FORBIDDEN_LEGACY_THRESHOLD = 0.05;

function measurement(overrides: Partial<ClassCalibration> = {}): ClassCalibration {
  return {
    referenceClass: 'artifact-capture',
    cohorts: ['real-surface'],
    noise: { n: 4, maxDiffRatio: 0.0001, samples: [] },
    regression: { n: 4, minDiffRatio: 0.01, samples: [] },
    indistinguishablePairs: [],
    fidelityCorpus: { faithfulMaxDiffRatio: null, driftedMinDiffRatio: null, samples: [] },
    captureRuntime: { n: 4, p50Ms: 1000, maxMs: 1200 },
    comparisonRuntime: { n: 4, p50Ms: 1, maxMs: 2 },
    smallestPixelsTotal: 1_024_000,
    ...overrides,
  };
}

describe('threshold derivation', () => {
  describe('calibration cases — the rule must SAY YES to a separable class', () => {
    it('derives a gateable policy when noise and a real change are well separated', () => {
      const { policy, separation } = derivePolicyFor(measurement(), 'test-1');
      expect(policy.eligibility).toBe('gateable');
      expect(separation).toBeGreaterThanOrEqual(SEPARATION_FLOOR);
    });

    it('places the threshold strictly between the noise floor and the smallest real change', () => {
      // The property that makes a threshold meaningful at all: above it, correct
      // work passes; below it, a real change is caught.
      const { policy, effectiveNoise, regressionFloor } = derivePolicyFor(measurement(), 'test-1');
      expect(policy.maxDiffRatio).toBeGreaterThan(effectiveNoise);
      expect(policy.maxDiffRatio).toBeLessThan(regressionFloor as number);
    });

    it('gives a perfectly reproducible class a non-zero threshold', () => {
      // A measured 0.0 means "finer than this measurement could see", not
      // "exactly zero forever". A literal-zero threshold fails the first time a
      // glyph lands one pixel differently, which is the failure that makes
      // people widen thresholds by hand.
      const { policy } = derivePolicyFor(
        measurement({ noise: { n: 12, maxDiffRatio: 0, samples: [] } }),
        'test-1',
      );
      expect(policy.eligibility).toBe('gateable');
      expect(policy.maxDiffRatio).toBeGreaterThan(0);
    });

    it('scales the floor with resolution rather than using a fixed epsilon', () => {
      // One pixel of a small image is a coarser distinction than one pixel of a
      // large one. A fixed epsilon would be wrong for one of them.
      const small = derivePolicyFor(
        measurement({ noise: { n: 4, maxDiffRatio: 0, samples: [] }, smallestPixelsTotal: 76_800 }),
        'test-1',
      );
      const large = derivePolicyFor(
        measurement({ noise: { n: 4, maxDiffRatio: 0, samples: [] }, smallestPixelsTotal: 1_024_000 }),
        'test-1',
      );
      expect(small.effectiveNoise).toBeGreaterThan(large.effectiveNoise);
    });
  });

  describe('controls — the rule must SAY NO, for the stated reason', () => {
    it('refuses a class with no real-surface cohort, however good its synthetic numbers', () => {
      const { policy, explainUngateable } = derivePolicyFor(
        measurement({
          cohorts: ['fixture-corpus'],
          fidelityCorpus: {
            faithfulMaxDiffRatio: 0.0001,
            driftedMinDiffRatio: 0.9,
            samples: [],
          },
        }),
        'test-1',
      );
      expect(policy.eligibility).toBe('advisory-only');
      expect(explainUngateable).toContain('real-surface');
    });

    it('refuses a class whose noise was never measured', () => {
      const { policy, explainUngateable } = derivePolicyFor(
        measurement({ noise: { n: 0, maxDiffRatio: null, samples: [] } }),
        'test-1',
      );
      expect(policy.eligibility).toBe('advisory-only');
      expect(explainUngateable).toContain('noise');
    });

    it('refuses a class with no real change to separate its noise from', () => {
      const { policy, explainUngateable } = derivePolicyFor(
        measurement({ regression: { n: 0, minDiffRatio: null, samples: [] } }),
        'test-1',
      );
      expect(policy.eligibility).toBe('advisory-only');
      expect(explainUngateable).toContain('separate');
    });

    it('refuses a class whose noise and real change are too close to tell apart', () => {
      const { policy, explainUngateable } = derivePolicyFor(
        measurement({
          noise: { n: 4, maxDiffRatio: 0.01, samples: [] },
          regression: { n: 4, minDiffRatio: 0.012, samples: [] },
        }),
        'test-1',
      );
      expect(policy.eligibility).toBe('advisory-only');
      expect(explainUngateable).toContain(`${SEPARATION_FLOOR}x`);
    });

    it('gives an ungateable class a maxDiffRatio of 0, never a plausible-looking number', () => {
      // A caller that wrongly reads maxDiffRatio without checking eligibility
      // must get a threshold that passes nothing, not one that passes anything.
      const { policy } = derivePolicyFor(measurement({ cohorts: ['fixture-corpus'] }), 'test-1');
      expect(policy.maxDiffRatio).toBe(0);
    });
  });

  describe('the derived thresholds are not the legacy 5% (D-005)', () => {
    it.each(calibratedClasses())('%s does not carry the legacy threshold', (referenceClass) => {
      expect(resolvePolicy({ referenceClass }).maxDiffRatio).not.toBe(FORBIDDEN_LEGACY_THRESHOLD);
    });

    it('has no path from a Lost Pixel config to a threshold', () => {
      // The structural form of "not inherited". Asserting the NUMBER differs
      // would still pass if someone read the config and rounded it; asserting
      // the dependency does not exist cannot be satisfied that way.
      const source = readFileSync(path.join(__dirname, 'policy.ts'), 'utf8');
      expect(source).not.toMatch(/lostpixel/i);
      expect(source).not.toMatch(/from '\.\.?\/.*config/);
    });

    it('contains no numeric threshold literal at all', () => {
      // Every maxDiffRatio is computed. A literal would be a threshold someone
      // chose, which is exactly what D-005 is about — the 5% is only the most
      // obvious instance.
      const source = readFileSync(path.join(__dirname, 'policy.ts'), 'utf8');
      const body = source
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n');
      expect(body).not.toMatch(/maxDiffRatio:\s*0\.\d/);
    });
  });
});

describe('policy resolution refuses rather than defaults', () => {
  it('refuses a superseded policy version', () => {
    expect(() =>
      resolvePolicy({ referenceClass: 'artifact-capture', policyVersion: 'dcp-ancient' }),
    ).toThrow(UnknownPolicyVersionError);
  });

  it('accepts the current version explicitly', () => {
    expect(() =>
      resolvePolicy({ referenceClass: 'artifact-capture', policyVersion: CURRENT_POLICY_VERSION }),
    ).not.toThrow();
  });

  it('refuses an uncalibrated reference class instead of borrowing a threshold', () => {
    // `derived-reference` exists in the contract and has no measurement. The
    // tempting behaviour — fall back to the nearest calibrated class — is the
    // one that produces a gate measuring the wrong thing.
    expect(() => resolvePolicy({ referenceClass: 'derived-reference' })).toThrow(
      UncalibratedReferenceClassError,
    );
  });

  it('names the calibrated classes in the refusal, so the remedy is legible', () => {
    try {
      resolvePolicy({ referenceClass: 'derived-reference' });
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain('artifact-capture');
    }
  });
});

describe('the committed calibration this build ships', () => {
  it('is the schema this code reads', () => {
    expect(CALIBRATION.schemaVersion).toBe(1);
    expect(CALIBRATION.classes.length).toBeGreaterThan(0);
  });

  it('carries a real-surface cohort, not only the synthetic corpus', () => {
    // If this ever fails, every gateable class below became gateable on
    // synthetic evidence, which P-002's calibration explicitly refused.
    expect(CALIBRATION.realSurface.storiesCaptured).toBeGreaterThan(0);
  });

  it('states its scope limits next to its numbers', () => {
    const caveats = CALIBRATION.caveats.join(' ');
    expect(caveats).toMatch(/SAME-HOST/);
  });

  it('separates noise from a real change for every class it makes gateable', () => {
    // The end-to-end property, checked against the SHIPPED artifact rather than
    // a fixture: run the recorded samples through the real verdict path and
    // require that unchanged surfaces pass and real changes fail.
    for (const measured of CALIBRATION.classes) {
      const derivation = explainPolicy(measured.referenceClass);
      if (derivation?.policy.eligibility !== 'gateable') continue;
      const policy = derivation.policy;

      for (const sample of measured.noise.samples) {
        const outcome = computeVerdict({
          counts: {
            pixelDifference: Math.round(sample.diffRatio * sample.pixelsTotal),
            pixelsTotal: sample.pixelsTotal,
          },
          policy,
        });
        expect(outcome.verdict, `unchanged surface must pass: ${sample.caseId}`).toBe('pass');
      }

      for (const sample of measured.regression.samples) {
        const outcome = computeVerdict({
          counts: {
            pixelDifference: Math.round(sample.diffRatio * sample.pixelsTotal),
            pixelsTotal: sample.pixelsTotal,
          },
          policy,
        });
        expect(outcome.verdict, `real change must fail: ${sample.caseId}`).toBe('fail');
      }
    }
  });

  it('records indistinguishable pairs rather than admitting them as regressions (D-020)', () => {
    for (const measured of CALIBRATION.classes) {
      for (const sample of measured.regression.samples) {
        // A zero here would define the regression floor as zero, asserting that
        // a real change can differ by no pixels.
        expect(sample.diffRatio, `zero-diff pair admitted as a regression: ${sample.caseId}`).
          toBeGreaterThan(0);
      }
    }
  });

  it('never lets the synthetic corpus contribute a capture-noise sample (D-021)', () => {
    for (const measured of CALIBRATION.classes) {
      for (const sample of measured.noise.samples) {
        expect(sample.caseId, 'the corpus captures nothing and cannot measure capture noise').
          not.toContain('fixture-corpus');
      }
    }
  });
});
