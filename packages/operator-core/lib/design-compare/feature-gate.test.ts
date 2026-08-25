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
import { calibrationRenderHost } from './enforceability';
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
    requiredCases: [
      {
        caseId: `${referenceId}-case`,
        environment: env,
        // Must agree with `compareFor`'s target for the same referenceId:
        // coverage matches on environment AND surface.
        target: { targetId: `components-checkout--${referenceId}`, targetKind: 'storybook-story' },
        rationale: 'breakpoint',
      },
    ],
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

/**
 * P-011/D-023 — the PRODUCER side of enforceability.
 *
 * `cross-host-enforcement.test.ts` proves `evaluateEnforceability` decides
 * correctly when it is HANDED two host strings. That is one seam short of the
 * property this criterion claims. What actually decides refuse-versus-report is
 * `enforceableBlocking` (feature-gate.ts), and nothing exercised the path that
 * fills it: ratification records a host, the gate reads it back off the
 * reference's OWN provenance, and only then does the filter run.
 *
 * Found by independent grading (EI-21431822634786425): `enforceableBlocking`
 * appeared in none of this criterion's bound files, and `capturedOnRenderHost`
 * in no test file at all. So three separate mutations — inverting the filter,
 * dropping the field at ratification, or hardwiring `enforceable: false` — each
 * left all 17 bound files green while the gate enforced NOWHERE. That is this
 * criterion's own drift marker: a never-firing gate grading identically to a
 * correct one.
 *
 * The two directions are asserted together on purpose. A positive-only test is
 * satisfied by a filter that enforces everything, and a negative-only test by
 * one that enforces nothing; only the pair pins the filter to the host.
 */
describe('P-011/D-023: a failing reference refuses only on the host the threshold was measured for', () => {
  /** 1280x800 = 1_024_000 px, POLICY.maxDiffRatio 0.001 => >1024 differing px fails. */
  const FAILING_PIXELS = 50_000;
  /** Same shape as the calibrated host, different font metrics — a real second machine. */
  const OTHER_HOST = 'chromium/147;probe@72px[monospace=1201.500,sans-serif=1370.000]';

  function ratifyOnHost(
    referenceId: string,
    env: CaptureEnvironment,
    sha: string,
    capturedOnRenderHost: string | undefined,
  ): RatifyReferenceInput {
    const base = ratifyFor(referenceId, env, sha);
    if (capturedOnRenderHost === undefined) return base;
    return { ...base, provenance: { ...base.provenance, capturedOnRenderHost } };
  }

  /** Ratify on `host`, then record an over-threshold comparison against it. */
  async function failingOnHost(host: string | undefined) {
    const c = ctx(DESKTOP, FAILING_PIXELS);
    await ratifyReferenceVerb(ratifyOnHost(DESKTOP_REF, DESKTOP, 'a', host), CALLER, c.verbDeps);
    await compareRenderVerb(compareFor(DESKTOP_REF, DESKTOP), CALLER, c.verbDeps);
    const result = await evaluate(c);
    if (!result.applicable) throw new Error('expected a ratified reference to make the gate apply');
    return result;
  }

  it('CALIBRATION: the shipped calibration names a host, or nothing below can enforce', () => {
    // If this is ever falsy, every enforcement assertion in this block becomes
    // vacuously satisfiable by a gate that enforces nowhere.
    expect(calibrationRenderHost()).toBeTruthy();
  });

  it('CONTROL: the over-threshold diff really does block, independently of any host question', async () => {
    // Separates "the host logic works" from "the diff was never failing in the
    // first place" — without this, an enforceableBlocking of length 0 could
    // simply mean nothing was blocking at all.
    const result = await failingOnHost(calibrationRenderHost());
    expect(result.satisfied).toBe(false);
    expect(result.blocking.map((r) => r.referenceId)).toEqual([DESKTOP_REF]);
  });

  it('ENFORCES: ratified on the calibrated host, the failure reaches enforceableBlocking', async () => {
    // The end-to-end path the criterion actually claims: ratify -> provenance
    // -> read-back -> evaluateEnforceability -> the refuse-vs-report filter.
    // Hardwiring `enforceable: false`, dropping the field at ratification, or
    // inverting the filter each break THIS assertion.
    const result = await failingOnHost(calibrationRenderHost());
    expect(result.enforceableBlocking.map((r) => r.referenceId)).toEqual([DESKTOP_REF]);
  });

  it('REPORTS ONLY: ratified on a different machine, it blocks but never enforces', async () => {
    // The mirror. Inverting the filter passes the ENFORCES case above only by
    // failing this one, so the pair cannot both be satisfied by a filter that
    // ignores the host.
    const result = await failingOnHost(OTHER_HOST);
    expect(result.blocking.map((r) => r.referenceId)).toEqual([DESKTOP_REF]);
    expect(result.enforceableBlocking).toHaveLength(0);
  });

  it('REPORTS ONLY: a reference ratified with no host recorded never enforces, and says why', async () => {
    // The pre-cutover and upload case. Named by reason rather than by a bare
    // boolean so that a gate which stopped recording the host at verbs.ts is
    // distinguishable here from one that merely stopped enforcing.
    const result = await failingOnHost(undefined);
    expect(result.blocking).toHaveLength(1);
    expect(result.enforceableBlocking).toHaveLength(0);
    const [reference] = result.blocking;
    expect(reference.enforceability.enforceable).toBe(false);
    if (reference.enforceability.enforceable) return;
    expect(reference.enforceability.reason).toBe('reference-host-unknown');
  });

  it('FALSIFIABILITY CONTROL: the two wrong filters disagree with the real one on this very data', async () => {
    // CLAUDE.md's tier for an imported module: keep the deliberately-wrong
    // implementations here permanently, rather than mutating the shared tree to
    // find out. Both wrong filters are applied to the REAL `blocking` array the
    // real pipeline just produced, so this cannot drift from the subject.
    //
    // Without this the assertions above are only *believed* to discriminate.
    // The whole reason this block exists is that "green" was previously
    // indistinguishable from "never fires" (EI-21431822634786425).
    const enforced = await failingOnHost(calibrationRenderHost());
    const reported = await failingOnHost(OTHER_HOST);

    const invertedFilter = (refs: typeof enforced.blocking) =>
      refs.filter((r) => !r.enforceability.enforceable);
    const hardwiredFalse = (refs: typeof enforced.blocking) => refs.filter(() => false);

    // Both wrong filters answer 0 where the real one answers 1 — so the
    // ENFORCES assertion above genuinely separates them from the real filter.
    expect(enforced.enforceableBlocking).toHaveLength(1);
    expect(invertedFilter(enforced.blocking)).toHaveLength(0);
    expect(hardwiredFalse(enforced.blocking)).toHaveLength(0);

    // And on the mismatched host the inverted filter answers 1 where the real
    // one answers 0 — so the REPORTS ONLY assertion separates it too. Together
    // the pair pins the filter in both directions; neither alone would.
    expect(reported.enforceableBlocking).toHaveLength(0);
    expect(invertedFilter(reported.blocking)).toHaveLength(1);
  });

  it('a reported-but-not-enforced failure is still reported, never silently dropped', async () => {
    // The whole point of the report-only leg: an unenforceable failure must
    // remain visible. A gate that answered "not enforceable" by forgetting the
    // reference would pass every assertion above and lose the obligation.
    const result = await failingOnHost(OTHER_HOST);
    expect(result.satisfied).toBe(false);
    expect(renderFeatureDesignGate(result)).toMatch(/NOT ENFORCED/);
  });
});
