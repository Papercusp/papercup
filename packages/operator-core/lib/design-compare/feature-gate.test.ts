/**
 * P-007 — the feature-level design-evidence obligation, and its bypasses.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * The bypass cases here are the point of the file. A per-reference gate is easy
 * to satisfy dishonestly at the FEATURE level — ratify the surface you already
 * match, leave the hard breakpoint unratified, or point the gate at one
 * reference and never mention the other. Each of those is written below as an
 * attempt that must fail, alongside a control proving the gate can still say
 * yes.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureEnvironment, ThresholdPolicy } from './contract';
import type { ComparisonProvider, ImageProbe } from './provider';
import { createInMemoryReferenceStore } from './reference-store';
import {
  type CompareRenderInput,
  type RatifyReferenceInput,
  type VerbCaller,
  type VerbDeps,
  compareRenderVerb,
  ratifyReferenceVerb,
} from './verbs';
import {
  DesignGateUnavailableError,
  evaluateFeatureDesignGate,
  renderFeatureDesignGate,
} from './feature-gate';

const HARNESS = 'test-harness';
const FEATURE = 'F-007';
const DESKTOP_REF = 'ref-checkout-desktop';
const MOBILE_REF = 'ref-checkout-mobile';

const DESKTOP: CaptureEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  browser: 'chromium',
  theme: 'dark',
  fontSet: 'papercusp-default',
};
const MOBILE: CaptureEnvironment = { ...DESKTOP, viewport: { width: 390, height: 844 } };

const POLICY: ThresholdPolicy = {
  policyVersion: 'p-2026-08-25',
  referenceClass: 'artifact-capture',
  eligibility: 'gateable',
  maxDiffRatio: 0.001,
  derivedFrom: 'calibration-run-1',
};

const CALLER: VerbCaller = { actorId: 'spawn-abc', role: 'reviewer' };

function provider(pixelDifference = 0): ComparisonProvider {
  return {
    engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
    async compare() {
      return { pixelDifference, diffArtifactWritten: true };
    },
  };
}

/** Probes report the dimensions of whichever environment is being captured. */
function probeFor(env: CaptureEnvironment): ImageProbe {
  return () => ({ exists: true, dimensions: { ...env.viewport } });
}

type Ctx = { store: ReturnType<typeof createInMemoryReferenceStore>; verbDeps: VerbDeps };

function ctx(env: CaptureEnvironment = DESKTOP, pixelDifference = 0): Ctx {
  const store = createInMemoryReferenceStore();
  let tick = 0;
  return {
    store,
    verbDeps: {
      harnessSlug: HARNESS,
      store,
      now: () => 1_000,
      clock: () => `2026-08-25T00:00:${String(tick++).padStart(2, '0')}.000Z`,
      materializeReferenceImage: async () => ({ path: '/tmp/reference.png' }),
      comparison: { provider: provider(pixelDifference), probe: probeFor(env) },
    },
  };
}

function ratifyFor(
  referenceId: string,
  env: CaptureEnvironment,
  sha: string,
): RatifyReferenceInput {
  return {
    featureId: FEATURE,
    referenceId,
    revision: 1,
    referenceClass: 'artifact-capture',
    contentSha256: sha.repeat(64).slice(0, 64),
    image: {
      mediaType: 'image/png',
      locator: `/refs/${referenceId}.png`,
      byteLength: 4096,
      width: env.viewport.width,
      height: env.viewport.height,
    },
    referenceEnvironment: env,
    requiredCases: [{ caseId: `${referenceId}-case`, environment: env, rationale: 'breakpoint' }],
    provenance: { source: 'artifact-capture', sourceRef: 'artifact://abc' },
  };
}

function compareFor(referenceId: string, env: CaptureEnvironment): CompareRenderInput {
  return {
    featureId: FEATURE,
    referenceId,
    target: {
      targetId: `components-checkout--${referenceId}`,
      targetKind: 'storybook-story',
      implementationRevision: 'impl-1',
    },
    environment: env,
    policy: POLICY,
    actualImagePath: '/tmp/actual.png',
    diffImagePath: '/tmp/diff.png',
  };
}

function evaluate(c: Ctx) {
  return evaluateFeatureDesignGate(
    { harnessSlug: HARNESS, featureId: FEATURE },
    { store: c.store, verbDeps: c.verbDeps, caller: CALLER },
  );
}

describe('applicability across a feature', () => {
  it('imposes nothing when the feature has no references at all', async () => {
    const result = await evaluate(ctx());
    expect(result.applicable).toBe(false);
    expect(renderFeatureDesignGate(result)).toBeUndefined();
  });

  it('is satisfied when every ratified reference has current passing evidence', async () => {
    const c = ctx();
    await ratifyReferenceVerb(ratifyFor(DESKTOP_REF, DESKTOP, 'a'), CALLER, c.verbDeps);
    await compareRenderVerb(compareFor(DESKTOP_REF, DESKTOP), CALLER, c.verbDeps);

    const result = await evaluate(c);
    expect(result.applicable && result.satisfied).toBe(true);
  });
});

describe('bypass attempts at the feature level', () => {
  /**
   * The load-bearing one. Two breakpoints are ratified, only the easy one is
   * compared. Because references are DISCOVERED rather than supplied, the
   * uncompared one still binds — the exact hole a caller-named reference list
   * would leave open.
   */
  it('a second ratified reference cannot be omitted by not mentioning it', async () => {
    const c = ctx();
    await ratifyReferenceVerb(ratifyFor(DESKTOP_REF, DESKTOP, 'a'), CALLER, c.verbDeps);
    await ratifyReferenceVerb(ratifyFor(MOBILE_REF, MOBILE, 'b'), CALLER, c.verbDeps);
    await compareRenderVerb(compareFor(DESKTOP_REF, DESKTOP), CALLER, c.verbDeps);

    const result = await evaluate(c);
    expect(result.applicable && result.satisfied).toBe(false);
    if (!result.applicable) return;
    expect(result.blocking.map((b) => b.referenceId)).toEqual([MOBILE_REF]);
    expect(renderFeatureDesignGate(result)).toContain(MOBILE_REF);
  });

  it('CALIBRATION: the same two references pass once both are compared', async () => {
    // Each reference is compared with a probe reporting ITS environment's
    // dimensions, which is what a real per-breakpoint capture does.
    const store = createInMemoryReferenceStore();
    const base = (env: CaptureEnvironment): VerbDeps => ({
      harnessSlug: HARNESS,
      store,
      now: () => 1_000,
      clock: () => '2026-08-25T00:00:00.000Z',
      materializeReferenceImage: async () => ({ path: '/tmp/reference.png' }),
      comparison: { provider: provider(0), probe: probeFor(env) },
    });

    await ratifyReferenceVerb(ratifyFor(DESKTOP_REF, DESKTOP, 'a'), CALLER, base(DESKTOP));
    await ratifyReferenceVerb(ratifyFor(MOBILE_REF, MOBILE, 'b'), CALLER, base(MOBILE));
    await compareRenderVerb(compareFor(DESKTOP_REF, DESKTOP), CALLER, base(DESKTOP));
    await compareRenderVerb(compareFor(MOBILE_REF, MOBILE), CALLER, base(MOBILE));

    const result = await evaluateFeatureDesignGate(
      { harnessSlug: HARNESS, featureId: FEATURE },
      { store, verbDeps: base(DESKTOP), caller: CALLER },
    );
    expect(result.applicable && result.satisfied).toBe(true);
  });

  it('a retracted reference stops binding, and that exit is visible in the result', async () => {
    const c = ctx();
    await ratifyReferenceVerb(ratifyFor(DESKTOP_REF, DESKTOP, 'a'), CALLER, c.verbDeps);
    const scope = { harnessSlug: HARNESS, featureId: FEATURE, referenceId: DESKTOP_REF };
    const rows = await c.store.listRevisions(scope);
    await c.store.setLifecycle(scope, rows[0]!.artifactId, { state: 'retracted' });

    const result = await evaluate(c);
    // Retraction IS a legitimate way out — D-001 makes an unratified surface
    // unconstrained. It is recorded as an explicit lifecycle transition by a
    // named principal, which is what separates it from evading the gate: the
    // reference still appears in the result, reported as retracted.
    expect(result.applicable).toBe(false);
    expect(result.references.map((r) => r.referenceId)).toEqual([DESKTOP_REF]);
    const verdict = result.references[0]!.verdict;
    expect(verdict.applicable).toBe(false);
    if (verdict.applicable) return;
    expect(verdict.reason).toBe('retracted');
  });
});

describe('unavailability is never a pass', () => {
  it('throws rather than returning satisfied when the reference list cannot be read', async () => {
    const c = ctx();
    const broken = {
      ...c.store,
      listFeatureReferenceIds: async () => {
        throw new Error('connection reset');
      },
    };
    await expect(
      evaluateFeatureDesignGate(
        { harnessSlug: HARNESS, featureId: FEATURE },
        { store: broken, verbDeps: c.verbDeps, caller: CALLER },
      ),
    ).rejects.toBeInstanceOf(DesignGateUnavailableError);
  });

  it('throws rather than silently dropping a reference whose evidence cannot be read', async () => {
    const c = ctx();
    await ratifyReferenceVerb(ratifyFor(DESKTOP_REF, DESKTOP, 'a'), CALLER, c.verbDeps);
    const broken = {
      ...c.store,
      listRevisions: async () => {
        throw new Error('connection reset');
      },
    };
    await expect(
      evaluateFeatureDesignGate(
        { harnessSlug: HARNESS, featureId: FEATURE },
        { store: broken, verbDeps: { ...c.verbDeps, store: broken }, caller: CALLER },
      ),
    ).rejects.toBeInstanceOf(DesignGateUnavailableError);
  });
});
