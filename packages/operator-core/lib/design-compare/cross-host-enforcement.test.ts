/**
 * P-011 PROBE — the enforcement precondition D-021 named but the contract cannot state.
 *
 * D-021's scope limit: every noise sample behind the shipped threshold is
 * SAME-HOST, so "host-to-host variance is entirely unmeasured and is plausibly
 * far larger than the same-host figure", and P-011 "must not enable enforcement
 * until it has" a cross-host figure.
 *
 * This file establishes something sharper than "we lack a number": the contract
 * cannot EXPRESS the host a capture was produced on, so a cross-host comparison
 * is not merely unmeasured — it is indistinguishable from a same-host one at
 * every precondition the gate checks. That is what has to be fixed before the
 * flag can be flipped, and a threshold of 3.3816e-5 is why it matters.
 */
import { describe, expect, it } from 'vitest';

import { CALIBRATION, derivePolicyFor } from './policy';
import { defaultFontSetResolver } from './capture';
import { environmentsMatch, describeEnvironment, type CaptureEnvironment } from './contract';

/** The environment the shipped calibration was measured at. */
const CALIBRATED: CaptureEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  browser: 'chromium',
  theme: 'light',
  fontSet: 'system',
  state: 'default',
};

describe('P-011: cross-host comparison is indistinguishable from same-host', () => {
  it('CALIBRATION CONTROL: the matcher does reject a difference it CAN express', () => {
    // Without this, every assertion below is satisfied by a matcher that always
    // returns true, and the probe would prove nothing at all.
    expect(environmentsMatch(CALIBRATED, { ...CALIBRATED, theme: 'dark' })).toBe(false);
    expect(environmentsMatch(CALIBRATED, { ...CALIBRATED, fontSet: 'brand' })).toBe(false);
    expect(
      environmentsMatch(CALIBRATED, { ...CALIBRATED, viewport: { width: 390, height: 844 } }),
    ).toBe(false);
  });

  it('THE GAP: two captures on different machines match, because no field can differ', () => {
    // A capture taken on the calibration host and a capture taken on a CI runner
    // with different installed fonts are, at the contract level, this pair — there
    // is no field of CaptureEnvironment either one could set differently.
    const onCalibrationHost = { ...CALIBRATED };
    const onSomeOtherRunner = { ...CALIBRATED };

    expect(environmentsMatch(onCalibrationHost, onSomeOtherRunner)).toBe(true);
    // And a human reading a refusal cannot tell them apart either.
    expect(describeEnvironment(onCalibrationHost)).toBe(describeEnvironment(onSomeOtherRunner));
  });

  it('no field of CaptureEnvironment carries host identity', () => {
    const fullyPopulated: Required<CaptureEnvironment> = {
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      browser: 'chromium',
      theme: 'light',
      fontSet: 'system',
      fixture: 'default',
      state: 'default',
    };
    // Every field, including the optional ones. If host identity is ever added,
    // this fails and the reasoning above must be revisited rather than inherited.
    expect(Object.keys(fullyPopulated).sort()).toEqual([
      'browser',
      'deviceScaleFactor',
      'fixture',
      'fontSet',
      'state',
      'theme',
      'viewport',
    ]);
  });

  it("THE MECHANISM: fontSet 'system' asserts nothing about which fonts exist", () => {
    // capture.ts says so in its own docstring. It is a declared absence of a font
    // requirement — which is the honest design — but it means the one env field
    // that names fonts is satisfied identically by two machines whose fonts differ.
    expect(defaultFontSetResolver('system')).toEqual([]);
  });
});

describe('P-011: the magnitude that makes this matter', () => {
  it('the enforced tolerance is ~34 pixels of a 1280x800 render', () => {
    const artifactCapture = CALIBRATION.classes.find(
      (c) => c.referenceClass === 'artifact-capture',
    );
    expect(artifactCapture).toBeDefined();
    const derived = derivePolicyFor(artifactCapture!, CALIBRATION.policyVersion);

    expect(derived.policy.eligibility).toBe('gateable');
    expect(derived.policy.maxDiffRatio).toBeCloseTo(3.3816e-5, 9);

    // Translated out of ratio-space, because a ratio hides how tight this is.
    const pixelsAllowed = derived.policy.maxDiffRatio * 1_024_000;
    expect(pixelsAllowed).toBeGreaterThan(30);
    expect(pixelsAllowed).toBeLessThan(40);
  });

  it('the calibration itself declares the same-host limit', () => {
    // Pins D-021's caveat to the artifact: if the wording is ever dropped, the
    // reason enforcement is scoped must not disappear silently with it.
    expect(CALIBRATION.caveats[0]).toMatch(/SAME-HOST ONLY/);
  });
});
