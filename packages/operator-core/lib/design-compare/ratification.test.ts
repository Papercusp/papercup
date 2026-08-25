import { describe, expect, it } from 'vitest';

import type { CaptureEnvironment } from './contract';
import {
  type RatifiedReference,
  type RequiredCase,
  defaultEligibilityFor,
  revisionInvalidatesEvidence,
  superseded,
  validateRatification,
} from './ratification';

const env = (over: Partial<CaptureEnvironment> = {}): CaptureEnvironment => ({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  browser: 'chromium',
  theme: 'light',
  fontSet: 'inter-v4',
  ...over,
});

const requiredCase = (over: Partial<RequiredCase> = {}): RequiredCase => ({
  caseId: 'desktop-default',
  environment: env(),
  target: { targetId: 'components-login--default', targetKind: 'storybook-story' },
  rationale: 'primary breakpoint',
  ...over,
});

const ref = (over: Partial<RatifiedReference> = {}): RatifiedReference => ({
  identity: {
    referenceId: 'ref-a',
    revision: 1,
    referenceClass: 'artifact-capture',
    contentSha256: 'a'.repeat(64),
  },
  state: 'active',
  provenance: {
    source: 'artifact-capture',
    sourceRef: 'https://example.invalid/artifact/1',
    ratifiedBy: 'owner',
    ratifiedAt: '2026-08-25T00:00:00.000Z',
  },
  referenceEnvironment: env(),
  requiredCases: [requiredCase()],
  ...over,
});

describe('validateRatification', () => {
  it('accepts a well-formed first ratification', () => {
    expect(validateRatification(ref())).toEqual([]);
  });

  it('refuses a ratification that declares no required cases', () => {
    const errors = validateRatification(ref({ requiredCases: [] }));
    expect(errors.map((e) => e.code)).toContain('no-required-cases');
    expect(errors[0]!.message).toContain('vacuously');
  });

  it('refuses duplicate case ids', () => {
    const errors = validateRatification(
      ref({ requiredCases: [requiredCase(), requiredCase()] }),
    );
    expect(errors.map((e) => e.code)).toContain('duplicate-case');
  });

  /**
   * D-020 class 4, at the ratification end.
   *
   * D-019 forces every case onto the reference's single environment, so the
   * SURFACE is the only thing distinguishing two cases. Two cases naming the
   * same surface are therefore indistinguishable to the coverage matcher, and
   * one capture satisfies both — requirement 9's failure with an extra step.
   * Refusing here keeps the matcher's one-evidence-one-case property true by
   * construction rather than by the author's care.
   */
  it('refuses two cases contracted against the same surface', () => {
    const errors = validateRatification(
      ref({
        requiredCases: [
          requiredCase({ caseId: 'a' }),
          requiredCase({ caseId: 'b' }), // same default target as 'a'
        ],
      }),
    );
    expect(errors.map((e) => e.code)).toContain('duplicate-case-target');
    // The message must name BOTH cases, or the author cannot tell which pair collided.
    const message = errors.find((e) => e.code === 'duplicate-case-target')!.message;
    expect(message).toContain("'a'");
    expect(message).toContain("'b'");
  });

  it('CALIBRATION: accepts two cases at the same environment on DIFFERENT surfaces', () => {
    // Without this, the test above also passes when the rule is over-broad and
    // rejects every multi-case reference — which would forbid the legitimate
    // shape it exists to make meaningful.
    const errors = validateRatification(
      ref({
        requiredCases: [
          requiredCase({ caseId: 'a' }),
          requiredCase({
            caseId: 'b',
            target: { targetId: 'components-login--error', targetKind: 'storybook-story' },
          }),
        ],
      }),
    );
    expect(errors.map((e) => e.code)).not.toContain('duplicate-case-target');
    expect(errors).toEqual([]);
  });

  /**
   * D-019 (surfaced by P-007). A revision carries ONE reference image, and
   * `compare_render` refuses a capture whose environment differs from
   * `referenceEnvironment`. A required case at any other environment is
   * therefore unsatisfiable by construction: every comparison for it returns
   * `invalid: environment-mismatch`, so the reference reads as stricter than a
   * single-case one while being a gate no implementation can ever pass.
   */
  it('refuses a required case contracted at a different viewport from the reference image', () => {
    const errors = validateRatification(
      ref({
        requiredCases: [
          requiredCase(),
          requiredCase({
            caseId: 'mobile',
            // A distinct surface, so this fixture isolates the environment
            // concern under test rather than also tripping duplicate-case-target.
            target: { targetId: 'components-login--mobile', targetKind: 'storybook-story' },
            environment: env({ viewport: { width: 390, height: 844 } }),
          }),
        ],
      }),
    );
    expect(errors.map((e) => e.code)).toContain('case-environment-mismatch');
    // The message must point at the remedy, not just state the mismatch.
    expect(errors.find((e) => e.code === 'case-environment-mismatch')!.message).toContain(
      'separate reference',
    );
  });

  it('refuses a required case that differs only by interaction state', () => {
    const errors = validateRatification(
      ref({ requiredCases: [requiredCase({ caseId: 'error', environment: env({ state: 'error' }) })] }),
    );
    expect(errors.map((e) => e.code)).toContain('case-environment-mismatch');
  });

  /**
   * CALIBRATION. Without this, a validator that rejected every required case
   * would satisfy both assertions above.
   */
  it('accepts a required case contracted at the reference environment', () => {
    expect(validateRatification(ref({ requiredCases: [requiredCase()] }))).toEqual([]);
  });

  it('requires a revision to increase', () => {
    const previous = ref({ identity: { ...ref().identity, revision: 4 } });
    const errors = validateRatification(ref({ identity: { ...ref().identity, revision: 4 } }), previous);
    expect(errors.map((e) => e.code)).toContain('revision-not-monotonic');
  });

  it('accepts a properly incremented revision', () => {
    const previous = ref({ identity: { ...ref().identity, revision: 4 } });
    const next = ref({ identity: { ...ref().identity, revision: 5 } });
    expect(validateRatification(next, previous)).toEqual([]);
  });

  it('refuses a reference class change across revisions', () => {
    const previous = ref();
    const next = ref({
      identity: { ...ref().identity, revision: 2, referenceClass: 'figma-export' },
    });
    const errors = validateRatification(next, previous);
    expect(errors.map((e) => e.code)).toContain('class-mismatch');
  });

  it('refuses a derived reference that does not record what it was derived from', () => {
    const errors = validateRatification(
      ref({ identity: { ...ref().identity, referenceClass: 'derived-reference' } }),
    );
    expect(errors.map((e) => e.code)).toContain('missing-derivation');
  });

  it('accepts a derived reference that records its origin', () => {
    const errors = validateRatification(
      ref({
        identity: { ...ref().identity, referenceClass: 'derived-reference' },
        provenance: { ...ref().provenance, derivedFrom: 'ref-original-mockup' },
      }),
    );
    expect(errors).toEqual([]);
  });

  it('reports every problem at once rather than only the first', () => {
    const errors = validateRatification(
      ref({
        identity: { ...ref().identity, referenceClass: 'derived-reference' },
        requiredCases: [],
      }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('revisionInvalidatesEvidence', () => {
  it('keeps evidence bound to the current revision', () => {
    expect(revisionInvalidatesEvidence(3, 3)).toBe(false);
  });

  it('invalidates evidence from an older revision', () => {
    expect(revisionInvalidatesEvidence(2, 3)).toBe(true);
  });

  it('invalidates evidence claiming a newer revision than the current one', () => {
    expect(revisionInvalidatesEvidence(4, 3)).toBe(true);
  });
});

describe('superseded', () => {
  it('marks the previous reference superseded and records the replacement', () => {
    const out = superseded(ref(), 2);
    expect(out.state).toBe('superseded');
    expect(out.supersededByRevision).toBe(2);
  });

  it('leaves identity and provenance untouched', () => {
    const original = ref();
    const out = superseded(original, 2);
    expect(out.identity).toEqual(original.identity);
    expect(out.provenance).toEqual(original.provenance);
  });
});

describe('defaultEligibilityFor', () => {
  /**
   * D-007: a model-painted raster starts advisory-only and must EARN a gate.
   * If this ever flips to 'gateable' by default, ratified raster mockups would
   * silently begin gating on a ratio that cannot mean anything.
   */
  it('starts a raster mockup as advisory-only', () => {
    expect(defaultEligibilityFor('raster-mockup')).toBe('advisory-only');
  });

  it.each(['artifact-capture', 'figma-export', 'derived-reference'] as const)(
    'starts %s as gateable',
    (cls) => {
      expect(defaultEligibilityFor(cls)).toBe('gateable');
    },
  );
});
