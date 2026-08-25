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
