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
import {
  calibrationRenderHost,
  describeEnforceability,
  evaluateEnforceability,
} from './enforceability';
import {
  browserIdentityFromUserAgent,
  explainRenderHostMismatch,
  renderHostFingerprint,
} from './render-host';

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
    expect(CALIBRATION.caveats.some((c) => /SAME-HOST ONLY/.test(c))).toBe(true);
  });
});

describe('P-011/D-023: enforcement is scoped to the measured host', () => {
  const CALIBRATED_HOST = 'chromium/147;probe@72px[monospace=1213.734,sans-serif=1393.102]';

  it('the shipped calibration names the machine its threshold describes', () => {
    // Without this the whole mechanism is inert: `enforceability.ts` reads a
    // missing host as "enforce nowhere", so an artifact that lost this field
    // would turn the gate off everywhere and look exactly like a gate that
    // passes. That is the failure this assertion exists to make loud.
    expect(calibrationRenderHost()).toBeTruthy();
    expect(calibrationRenderHost()).toMatch(/^chromium\/\d+;probe@72px\[/);
  });

  it('ENFORCES when the reference was ratified on the calibrated host', () => {
    // The positive control for every negative case below. A rule hardwired to
    // "never enforceable" would satisfy all of them and be worthless.
    const outcome = evaluateEnforceability(CALIBRATED_HOST, CALIBRATED_HOST);
    expect(outcome.enforceable).toBe(true);
  });

  it('does NOT enforce a reference with no recorded host (pre-cutover, uploads)', () => {
    const outcome = evaluateEnforceability(undefined, CALIBRATED_HOST);
    expect(outcome.enforceable).toBe(false);
    if (outcome.enforceable) return;
    expect(outcome.reason).toBe('reference-host-unknown');
  });

  it('does NOT enforce a reference ratified on a different machine', () => {
    const otherHost = 'chromium/147;probe@72px[monospace=1201.500,sans-serif=1370.000]';
    const outcome = evaluateEnforceability(otherHost, CALIBRATED_HOST);
    expect(outcome.enforceable).toBe(false);
    if (outcome.enforceable) return;
    expect(outcome.reason).toBe('uncalibrated-host');
  });

  it('does NOT enforce anywhere when the calibration cannot say where it was measured', () => {
    const outcome = evaluateEnforceability(CALIBRATED_HOST, null);
    expect(outcome.enforceable).toBe(false);
    if (outcome.enforceable) return;
    expect(outcome.reason).toBe('uncalibrated-host');
  });

  it('a non-enforcing outcome always says so in words, never silently', () => {
    // "The gate did not enforce" must never render identically to "the gate
    // passed" — a gate that quietly stopped enforcing is the failure this whole
    // module exists to prevent, arriving by a different door.
    const outcome = evaluateEnforceability(undefined, CALIBRATED_HOST);
    expect(describeEnforceability(outcome)).toMatch(/NOT ENFORCED/);
    expect(describeEnforceability(evaluateEnforceability(CALIBRATED_HOST, CALIBRATED_HOST))).toMatch(
      /enforceable/,
    );
  });
});

describe('P-011/D-023: the fingerprint is an instrument, so it must discriminate', () => {
  it('is stable for identical inputs and different for different fonts', () => {
    const base = {
      browserName: 'chromium',
      browserMajorVersion: '147',
      fontMetrics: { monospace: 1213.734375, 'sans-serif': 1393.1015625, serif: 1318.18359375 },
    } as const;
    // Stability first: a fingerprint that moved between two reads on ONE machine
    // would disable enforcement at random, indistinguishable from a real
    // cross-host difference.
    expect(renderHostFingerprint(base)).toBe(renderHostFingerprint({ ...base }));

    // Then discrimination — a host whose serif resolves to a different face.
    const otherFonts = { ...base, fontMetrics: { ...base.fontMetrics, serif: 1290.5 } };
    expect(renderHostFingerprint(otherFonts)).not.toBe(renderHostFingerprint(base));

    // And a browser major change, which is engine-scale.
    expect(renderHostFingerprint({ ...base, browserMajorVersion: '148' })).not.toBe(
      renderHostFingerprint(base),
    );
  });

  it('ignores the patch version, so a routine browser update does not disable the gate', () => {
    // Folding the full UA in would silently stop enforcement after any Chrome
    // patch — a gate that stops firing without anyone deciding it should.
    expect(browserIdentityFromUserAgent('… HeadlessChrome/147.0.7727.15 Safari/537.36')).toEqual({
      browserName: 'chromium',
      browserMajorVersion: '147',
    });
    expect(browserIdentityFromUserAgent('… Chrome/147.0.9999.1 Safari/537.36')).toEqual({
      browserName: 'chromium',
      browserMajorVersion: '147',
    });
  });

  it('an unrecognized agent yields an identity that cannot match a real host', () => {
    // Deliberately not a guess: a fabricated fingerprint that happened to
    // collide with a real one would enforce on an unmeasured machine.
    const unknown = browserIdentityFromUserAgent('some-crawler/1.0');
    expect(unknown.browserName).toBe('unknown');
    expect(evaluateEnforceability(undefined, 'anything').enforceable).toBe(false);
  });

  it('explains a mismatch in terms a human can act on', () => {
    const a = {
      browserName: 'chromium',
      browserMajorVersion: '147',
      fontMetrics: { monospace: 1213.734, 'sans-serif': 1393.102, serif: 1318.184 },
    } as const;
    const b = { ...a, fontMetrics: { ...a.fontMetrics, serif: 1290.5 } };
    expect(explainRenderHostMismatch(a, b)).toContain('serif advance');
  });
});
