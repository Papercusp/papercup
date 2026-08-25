/**
 * P-009 — "prove no mask-based bypass" — and EI-21414614584540571, its sequel.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * HISTORY, because the current shape only makes sense against it: an earlier
 * revision ACCEPTED `ignoredRegions` on `CompareRenderInput` and STAMPED it
 * onto the stored result — while `provider.compare()` took two image paths, a
 * diff path and a threshold, and nothing else. No code anywhere read a
 * region's geometry. The mask was INERT: a region declared ignored was still
 * fully compared, and the stored evidence said otherwise. That was fail-safe
 * in the direction that matters (you could not hide a real diff behind a mask)
 * and misleading in the other (evidence asserted an exclusion that never
 * happened — a false statement in the one table this subsystem cannot afford
 * one in).
 *
 * EI-21414614584540571 resolved that by REMOVING the field rather than wiring
 * it through: real masking is a design decision (engine support, non-empty
 * justification/authority validation, a mask-area cap), not something to
 * inherit from a field that was never connected. What this file now pins:
 *
 *  1. A compare request that still supplies `ignoredRegions` — the TS type no
 *     longer carries it, but a JSON-boundary caller can — is REFUSED loudly
 *     (`validation-failed`), and NO evidence is minted for it. Neither silent
 *     option is acceptable: recording the mask asserts an exclusion that never
 *     happened, and dropping it leaves the caller believing pixels were
 *     excluded that were fully compared.
 *  2. The engine never receives anything region-shaped.
 *  3. Stored evidence never carries an `ignoredRegions` field.
 *  4. CALIBRATION: a mask-free compare still passes when the implementation
 *     matches — the refusal is about masks, not a verb that always says no.
 *
 * The day someone implements masking for real, tests 1–3 fail, and they are
 * forced to answer the question the original file was waiting for: what stops
 * a mask from suppressing a real difference?
 */
import { describe, expect, it } from 'vitest';
import type { CaptureEnvironment, ThresholdPolicy } from './contract';
import type { ComparisonProvider, ImageProbe, ProviderRequest } from './provider';
import { createInMemoryReferenceStore } from './reference-store';
import {
  type CompareRenderInput,
  type RatifyReferenceInput,
  type VerbCaller,
  type VerbDeps,
  compareRenderVerb,
  getDesignEvidenceVerb,
  ratifyReferenceVerb,
} from './verbs';

const HARNESS = 'test-harness';
const FEATURE = 'F-009';
const REFERENCE = 'ref-masked-panel';

const ENV: CaptureEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  browser: 'chromium',
  theme: 'dark',
  fontSet: 'papercusp-default',
};

const POLICY: ThresholdPolicy = {
  policyVersion: 'p-2026-08-25',
  referenceClass: 'artifact-capture',
  eligibility: 'gateable',
  maxDiffRatio: 0.001,
  derivedFrom: 'calibration-run-1',
};

const CALLER: VerbCaller = { actorId: 'spawn-abc', role: 'reviewer' };

const CASE_TARGET = {
  targetId: 'components-panel--default',
  targetKind: 'storybook-story',
} as const;

/** The shape the retired field used to carry. Local on purpose: the contract no longer exports it. */
interface RegionAttempt {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly justification: string;
  readonly authorizedBy: string;
}

/** A mask covering the ENTIRE reference — the maximal bypass attempt. */
const WHOLE_IMAGE_MASK: RegionAttempt = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  justification: 'flaky avatar',
  authorizedBy: 'spawn-abc',
};

/** A mask with no real justification or authority behind it. */
const UNEXPLAINED_MASK: RegionAttempt = {
  x: 0,
  y: 0,
  width: 40,
  height: 40,
  justification: '',
  authorizedBy: '',
};

/**
 * Reports a difference far above policy — a real, failing implementation —
 * and records the exact request object the adapter handed it.
 */
function failingProvider(): ComparisonProvider & { sawRequest: ProviderRequest | undefined } {
  const provider = {
    sawRequest: undefined as ProviderRequest | undefined,
    engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
    async compare(request: ProviderRequest) {
      provider.sawRequest = request;
      // 25% of a 1280x800 image differs: three orders of magnitude over policy.
      return { pixelDifference: 256_000, diffArtifactWritten: true };
    },
  };
  return provider;
}

const probeOk: ImageProbe = () => ({ exists: true, dimensions: { width: 1280, height: 800 } });

function deps(overrides: Partial<VerbDeps> = {}): VerbDeps {
  let tick = 0;
  return {
    harnessSlug: HARNESS,
    store: createInMemoryReferenceStore(),
    now: () => 1_000,
    clock: () => `2026-08-25T00:00:${String(tick++).padStart(2, '0')}.000Z`,
    materializeReferenceImage: async () => ({ path: '/tmp/reference.png' }),
    comparison: { provider: failingProvider(), probe: probeOk },
    ...overrides,
  };
}

function ratifyInput(overrides: Partial<RatifyReferenceInput> = {}): RatifyReferenceInput {
  return {
    featureId: FEATURE,
    referenceId: REFERENCE,
    revision: 1,
    referenceClass: 'artifact-capture',
    contentSha256: 'c'.repeat(64),
    image: {
      mediaType: 'image/png',
      locator: '/refs/panel.png',
      byteLength: 4096,
      width: 1280,
      height: 800,
    },
    referenceEnvironment: ENV,
    requiredCases: [
      {
        caseId: 'panel-desktop',
        environment: ENV,
        target: CASE_TARGET,
        rationale: 'primary breakpoint',
      },
    ],
    provenance: { source: 'artifact-capture', sourceRef: 'artifact://abc' },
    ...overrides,
  };
}

function compareInput(): CompareRenderInput {
  return {
    featureId: FEATURE,
    referenceId: REFERENCE,
    target: { ...CASE_TARGET, implementationRevision: 'impl-1' },
    environment: ENV,
    policy: POLICY,
    actualImagePath: '/tmp/actual.png',
    diffImagePath: '/tmp/diff.png',
  };
}

/**
 * What a JSON-boundary caller can still send: the compare input WITH the
 * retired field attached. The TS type no longer admits it, which is exactly
 * why the cast exists — the runtime guard, not the type, is the enforcement.
 */
function compareInputWithMask(regions: readonly RegionAttempt[]): CompareRenderInput {
  return { ...compareInput(), ignoredRegions: regions } as CompareRenderInput;
}

describe('a compare request carrying ignoredRegions is refused, never silently run', () => {
  it('refuses the maximal bypass attempt — the ENTIRE image declared ignored', async () => {
    const d = deps();
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);

    const compared = await compareRenderVerb(compareInputWithMask([WHOLE_IMAGE_MASK]), CALLER, d);

    expect(compared.ok).toBe(false);
    if (compared.ok) return;
    expect(compared.code).toBe('validation-failed');
    expect(compared.detail).toContain('ignoredRegions');
  });

  it('refuses an unexplained mask identically — the refusal is structural, not a policy call', async () => {
    const d = deps();
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);

    const compared = await compareRenderVerb(compareInputWithMask([UNEXPLAINED_MASK]), CALLER, d);

    expect(compared.ok).toBe(false);
    if (compared.ok) return;
    expect(compared.code).toBe('validation-failed');
  });

  it('mints NO evidence for a refused mask request', async () => {
    const d = deps();
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);
    await compareRenderVerb(compareInputWithMask([WHOLE_IMAGE_MASK]), CALLER, d);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // A refusal is not a comparison. Were an evidence row minted here, a host
    // misconfiguration would enter the evidence table wearing the clothes of
    // evidence — the exact confusion the verb header forbids.
    expect(read.evidence).toHaveLength(0);
    const covered = read.coverage.find((c) => c.caseId === 'panel-desktop');
    expect(covered?.verdict).toBeNull();
  });
});

describe('nothing region-shaped survives anywhere downstream', () => {
  it('never hands the engine anything beyond paths and threshold on a normal compare', async () => {
    const provider = failingProvider();
    const d = deps({ comparison: { provider, probe: probeOk } });
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    const compared = await compareRenderVerb(compareInput(), CALLER, d);

    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.result.verdict).toBe('fail');

    // The engine seam is exactly four fields. The day regions are threaded
    // through, this fails, and whoever did it must answer the bypass question
    // deliberately: what stops a mask from suppressing a real difference?
    expect(provider.sawRequest).toBeDefined();
    expect(Object.keys(provider.sawRequest!).sort()).toEqual([
      'actualImagePath',
      'diffImagePath',
      'referenceImagePath',
      'threshold',
    ]);
  });

  it('stored evidence never carries an ignoredRegions field', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput(), CALLER, d);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    expect(read.evidence).toHaveLength(1);
    // Not "empty" or "undefined" — ABSENT. Evidence must not even hint that
    // region exclusion is a thing this pipeline can do.
    expect('ignoredRegions' in read.evidence[0]!.deterministic).toBe(false);
  });
});

describe('CALIBRATION: the refusal is about masks, not a verb that always says no', () => {
  it('a mask-free compare still passes when the implementation actually matches', async () => {
    const passing: ComparisonProvider = {
      engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
      async compare() {
        return { pixelDifference: 0, diffArtifactWritten: true };
      },
    };
    const d = deps({ comparison: { provider: passing, probe: probeOk } });
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);

    const compared = await compareRenderVerb(compareInput(), CALLER, d);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.result.verdict).toBe('pass');
  });
});
