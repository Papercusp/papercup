/**
 * P-009 — "prove no mask-based bypass".
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * `IgnoredRegion` carries the invariant in its own docstring: "an unexplained
 * mask is a bypass." Until this file existed, that sentence was the whole
 * enforcement — `ignoredRegions` had ZERO test coverage in any casing, and the
 * P-009 inventory that first went looking for its proof matched on the word
 * "mask" and found `overlay-not-gateable.test.ts`, which is about the Figma
 * OVERLAY UX and has nothing to do with region masking. The class was recorded
 * as proven while being untested.
 *
 * What is actually true today, measured rather than assumed: `ignoredRegions`
 * is threaded from `CompareRenderInput` through the provider and STAMPED onto
 * the stored result, but no code anywhere reads a region's geometry. The mask
 * is INERT — a region declared ignored is still fully compared.
 *
 * That is fail-safe in the direction that matters (you cannot hide a real diff
 * behind a mask) and misleading in the other (the stored evidence says regions
 * were excluded when none were). Both halves are pinned here, because the
 * dangerous moment is not now — it is when someone wires up real masking and
 * inherits a field that already appears on records, with no validation of who
 * authorized it and no guard against a mask that covers the whole image.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureEnvironment, IgnoredRegion, ThresholdPolicy } from './contract';
import type { ComparisonProvider, ImageProbe } from './provider';
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

/** A mask covering the ENTIRE reference — the maximal bypass attempt. */
const WHOLE_IMAGE_MASK: IgnoredRegion = {
  x: 0,
  y: 0,
  width: 1280,
  height: 800,
  justification: 'flaky avatar',
  authorizedBy: 'spawn-abc',
};

/** A mask with no real justification or authority behind it. */
const UNEXPLAINED_MASK: IgnoredRegion = {
  x: 0,
  y: 0,
  width: 40,
  height: 40,
  justification: '',
  authorizedBy: '',
};

/** Reports a difference far above policy — a real, failing implementation. */
function failingProvider(): ComparisonProvider & { sawRegions: unknown } {
  const provider = {
    sawRegions: undefined as unknown,
    engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
    async compare(request: { readonly ignoredRegions?: unknown }) {
      provider.sawRegions = request.ignoredRegions;
      // 25% of a 1280x800 image differs: three orders of magnitude over policy.
      return { pixelDifference: 256_000, diffArtifactWritten: true };
    },
  };
  return provider as ComparisonProvider & { sawRegions: unknown };
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

function compareInput(overrides: Partial<CompareRenderInput> = {}): CompareRenderInput {
  return {
    featureId: FEATURE,
    referenceId: REFERENCE,
    target: { ...CASE_TARGET, implementationRevision: 'impl-1' },
    environment: ENV,
    policy: POLICY,
    actualImagePath: '/tmp/actual.png',
    diffImagePath: '/tmp/diff.png',
    ...overrides,
  };
}

describe('a mask cannot turn a failing comparison into a passing one', () => {
  it('still fails when the ENTIRE image is declared ignored', async () => {
    const d = deps();
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);

    const compared = await compareRenderVerb(
      compareInput({ ignoredRegions: [WHOLE_IMAGE_MASK] }),
      CALLER,
      d,
    );

    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    // The maximal bypass attempt: if a mask could ever suppress a verdict, a
    // mask covering every pixel would be the one that did it.
    expect(compared.result.verdict).toBe('fail');
  });

  it('still fails when the mask carries no justification or authority', async () => {
    const d = deps();
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);

    const compared = await compareRenderVerb(
      compareInput({ ignoredRegions: [UNEXPLAINED_MASK] }),
      CALLER,
      d,
    );

    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.result.verdict).toBe('fail');
  });

  it('does not let a mask satisfy a required case through the gate view', async () => {
    const d = deps();
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);
    await compareRenderVerb(compareInput({ ignoredRegions: [WHOLE_IMAGE_MASK] }), CALLER, d);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const covered = read.coverage.find((c) => c.caseId === 'panel-desktop');
    // Evidence EXISTS for the case, so it is not uncovered — but its verdict is
    // the failing one, which is what the gate refuses on. A mask changes
    // neither fact.
    expect(covered?.verdict).toBe('fail');
  });

  it('CALIBRATION: the same setup passes when the implementation actually matches', async () => {
    // Without this, every assertion above also passes if compare_render were
    // broken into always failing — a guard that proves only that it can say no.
    const passing: ComparisonProvider = {
      engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
      async compare() {
        return { pixelDifference: 0, diffArtifactWritten: true };
      },
    };
    const d = deps({ comparison: { provider: passing, probe: probeOk } });
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);

    const compared = await compareRenderVerb(
      compareInput({ ignoredRegions: [WHOLE_IMAGE_MASK] }),
      CALLER,
      d,
    );
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.result.verdict).toBe('pass');
  });
});

describe('masks are recorded but inert, and that must not drift silently', () => {
  it('records the declared regions on the stored evidence', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput({ ignoredRegions: [WHOLE_IMAGE_MASK] }), CALLER, d);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // The regions ARE persisted, which is exactly why the next test matters:
    // a reader of this record sees an exclusion that was never performed.
    expect(read.evidence[0]!.deterministic.ignoredRegions).toEqual([WHOLE_IMAGE_MASK]);
  });

  it('passes the regions to the engine rather than applying them itself', async () => {
    const provider = failingProvider();
    const d = deps({ comparison: { provider, probe: probeOk } });
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput({ ignoredRegions: [WHOLE_IMAGE_MASK] }), CALLER, d);

    /**
     * The adapter hands regions to the engine and performs no masking of its
     * own (D-002: Papercusp owns orchestration, never pixel mathematics).
     *
     * This pins WHERE responsibility sits. Today no engine path honours the
     * regions, so they are inert; if that changes, masking becomes capable of
     * suppressing real differences and the tests above become load-bearing in a
     * way they are not yet. Whoever makes that change must come through here.
     */
    expect(provider.sawRegions).toEqual([WHOLE_IMAGE_MASK]);
  });
});
