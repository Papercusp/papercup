import { describe, expect, it } from 'vitest';

import { SEVERITY_RANK } from './artifact-trust';
import {
  WORKSPACE_HOST_IMAGE_SCAN_POLICY,
  evaluateImageScanPolicy,
  type ImageScanPolicy,
  type ImageScanPolicyInput,
} from './image-scan-policy';

/**
 * A breakdown whose counts always reconcile against the total, so a test that means
 * to exercise ONE rule cannot accidentally trip `severity-breakdown-mismatch` and
 * pass for the wrong reason.
 */
function scan(bySeverity: Record<string, unknown>, secretFindings = 0): ImageScanPolicyInput {
  const total = Object.values(bySeverity).reduce<number>(
    (sum, value) => sum + (typeof value === 'number' ? value : 0),
    0,
  );
  return { vulnerabilityFindings: total, vulnerabilityBySeverity: bySeverity, secretFindings };
}

const codes = (input: ImageScanPolicyInput, policy?: ImageScanPolicy): string[] =>
  evaluateImageScanPolicy(input, policy).failures.map((failure) => failure.code);

describe('workspace-host image scan policy', () => {
  it('ratifies deny-at-or-above-high with zero tolerated secrets', () => {
    expect(WORKSPACE_HOST_IMAGE_SCAN_POLICY).toEqual({
      denyVulnerabilitiesAtOrAbove: 'high',
      maxSecretFindings: 0,
    });
  });

  it('ranks severities from artifact-trust, so the two gates cannot disagree', () => {
    // Calibration: if artifact-trust ever re-ranks a severity, this fails here rather
    // than silently changing what the image gate admits.
    expect(SEVERITY_RANK).toMatchObject({ unknown: -1, low: 0, medium: 1, high: 2, critical: 3 });
  });

  describe('the defect this module exists to fix', () => {
    it('admits a real distribution image whose findings are all below the threshold', () => {
      // The measured shape from EI-21770579023793724: thousands of matches across a
      // stock Ubuntu userland, none of them at or above HIGH. The old gate demanded
      // zero at ANY severity and so could never pass this.
      const verdict = evaluateImageScanPolicy(
        scan({ Negligible: 1804, Low: 1500, Medium: 618 }),
      );
      expect(verdict.accepted).toBe(true);
      expect(verdict.totalVulnerabilities).toBe(3922);
      expect(verdict.policyViolatingVulnerabilities).toBe(0);
      expect(verdict.toleratedVulnerabilities).toBe(3922);
    });

    it('still denies a single finding at the threshold', () => {
      // Positive control for the test above: the policy is not vacuous — the SAME
      // image shape plus one High is rejected.
      const verdict = evaluateImageScanPolicy(
        scan({ Negligible: 1804, Low: 1500, Medium: 618, High: 1 }),
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.policyViolatingVulnerabilities).toBe(1);
      expect(verdict.failures.map((f) => f.code)).toContain('vulnerability-threshold');
    });

    it('denies critical, which outranks the threshold', () => {
      expect(codes(scan({ Critical: 1 }))).toContain('vulnerability-threshold');
    });

    it('reads grype’s capitalised labels', () => {
      // grype emits 'Critical'/'High'/...; the ratified rank table is lower-case.
      // A case-sensitive lookup would treat every real label as unrecognised.
      expect(evaluateImageScanPolicy(scan({ MEDIUM: 5, ' low ': 2 })).accepted).toBe(true);
      expect(codes(scan({ CRITICAL: 1 }))).toEqual(['vulnerability-threshold']);
    });
  });

  describe('fails closed — a measurement it cannot account for is never a pass', () => {
    it('rejects an empty breakdown that claims findings exist', () => {
      // THE control that matters most. This is the exact shape of the original
      // defect: a counter that reads as clean because the instrument produced
      // nothing. Zero violations must never be inferred from an absent measurement.
      const verdict = evaluateImageScanPolicy({
        vulnerabilityFindings: 3922,
        vulnerabilityBySeverity: {},
        secretFindings: 0,
      });
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((f) => f.code)).toContain('severity-breakdown-mismatch');
    });

    it('rejects a breakdown that accounts for only some findings', () => {
      expect(
        codes({ vulnerabilityFindings: 100, vulnerabilityBySeverity: { Low: 40 }, secretFindings: 0 }),
      ).toContain('severity-breakdown-mismatch');
    });

    it('counts an unrecognised severity as violating rather than safe', () => {
      // A label this build has never seen is not evidence of safety. It turns the
      // gate red and gets a human's attention instead of quietly widening what passes.
      const verdict = evaluateImageScanPolicy(scan({ Moderate: 3 }));
      expect(verdict.accepted).toBe(false);
      expect(verdict.policyViolatingVulnerabilities).toBe(3);
      expect(verdict.failures.map((f) => f.code)).toContain('unrecognized-severity');
    });

    it.each([
      ['a non-integer count', { vulnerabilityFindings: 1, vulnerabilityBySeverity: { Low: 1.5 }, secretFindings: 0 }],
      ['a negative count', { vulnerabilityFindings: 1, vulnerabilityBySeverity: { Low: -1 }, secretFindings: 0 }],
      ['a string count', { vulnerabilityFindings: 1, vulnerabilityBySeverity: { Low: '1' }, secretFindings: 0 }],
      ['a null breakdown', { vulnerabilityFindings: 0, vulnerabilityBySeverity: null, secretFindings: 0 }],
      ['an array breakdown', { vulnerabilityFindings: 0, vulnerabilityBySeverity: [], secretFindings: 0 }],
      ['a negative total', { vulnerabilityFindings: -1, vulnerabilityBySeverity: {}, secretFindings: 0 }],
      ['a non-integer secret count', { vulnerabilityFindings: 0, vulnerabilityBySeverity: {}, secretFindings: 0.5 }],
    ])('rejects %s', (_label, input) => {
      const verdict = evaluateImageScanPolicy(input as unknown as ImageScanPolicyInput);
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.length).toBeGreaterThan(0);
    });

    it('rejects an unusable policy instead of admitting on it', () => {
      expect(
        codes(scan({}), { denyVulnerabilitiesAtOrAbove: 'nonsense', maxSecretFindings: 0 } as unknown as ImageScanPolicy),
      ).toEqual(['invalid-policy']);
      expect(
        codes(scan({}), { denyVulnerabilitiesAtOrAbove: 'high', maxSecretFindings: -1 }),
      ).toEqual(['invalid-policy']);
    });
  });

  describe('the secret bar is NOT loosened', () => {
    it('denies any secret finding under the ratified policy', () => {
      const verdict = evaluateImageScanPolicy(scan({ Low: 1 }, 280));
      expect(verdict.accepted).toBe(false);
      expect(verdict.failures.map((f) => f.code)).toContain('secret-threshold');
      expect(verdict.secretFindings).toBe(280);
    });

    it('denies even a single secret finding', () => {
      expect(codes(scan({}, 1))).toContain('secret-threshold');
    });

    it('reports vulnerability and secret failures independently', () => {
      // A red must name every reason it is red; triaging one should not hide another.
      expect(codes(scan({ Critical: 2 }, 5)).sort()).toEqual(['secret-threshold', 'vulnerability-threshold']);
    });
  });

  it('treats unknown severity as below the threshold, matching the ratified ordering', () => {
    // Deliberate: artifact-trust ranks `unknown` at -1, below `low`. This module
    // reuses that rather than inventing a stricter reading — but the count is still
    // reported so a reviewer can see it.
    const verdict = evaluateImageScanPolicy(scan({ Unknown: 7 }));
    expect(verdict.accepted).toBe(true);
    expect(verdict.toleratedVulnerabilities).toBe(7);
  });

  it('accepts a genuinely clean image', () => {
    const verdict = evaluateImageScanPolicy(scan({}, 0));
    expect(verdict.accepted).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  /**
   * Permanent falsifiability controls.
   *
   * A guard that has never failed is a guard nobody has tested. These run the two
   * load-bearing cases against deliberately-wrong implementations kept here for
   * exactly this purpose, and assert those implementations get the answer WRONG —
   * so if `evaluateImageScanPolicy` ever degenerates into either one, the suite
   * above stops being able to pass by accident.
   *
   * They live in the test file rather than being produced by mutating the source,
   * because this is a shared working tree: an in-tree mutation can be swept into a
   * commit by the background git-sync while the probe is still running.
   */
  describe('falsifiability controls', () => {
    const REAL_IMAGE = scan({ Negligible: 1804, Low: 1500, Medium: 618 });
    const DEAD_INSTRUMENT = {
      vulnerabilityFindings: 3922,
      vulnerabilityBySeverity: {},
      secretFindings: 0,
    } satisfies ImageScanPolicyInput;

    /** The gate as it was: zero grype matches at ANY severity. */
    const zeroToleranceGate = (input: ImageScanPolicyInput): boolean =>
      input.vulnerabilityFindings === 0 && input.secretFindings === 0;

    /** The tempting shortcut: trust the breakdown, never reconcile it. */
    const unreconciledGate = (input: ImageScanPolicyInput): boolean => {
      const bySeverity = (input.vulnerabilityBySeverity ?? {}) as Record<string, number>;
      const violating = ['high', 'critical'].reduce(
        (sum, key) =>
          sum +
          Object.entries(bySeverity)
            .filter(([label]) => label.toLowerCase() === key)
            .reduce((inner, [, count]) => inner + count, 0),
        0,
      );
      return violating === 0 && input.secretFindings === 0;
    };

    it('the old zero-tolerance gate rejects the image this policy admits', () => {
      expect(evaluateImageScanPolicy(REAL_IMAGE).accepted).toBe(true);
      expect(zeroToleranceGate(REAL_IMAGE)).toBe(false);
    });

    it('an unreconciled gate admits the dead instrument this policy rejects', () => {
      expect(unreconciledGate(DEAD_INSTRUMENT)).toBe(true);
      expect(evaluateImageScanPolicy(DEAD_INSTRUMENT).accepted).toBe(false);
    });
  });
});
