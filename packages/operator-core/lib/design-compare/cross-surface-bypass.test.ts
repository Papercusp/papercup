/**
 * P-009 / D-020 ruling 1 — the FOURTH bypass class, end to end.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * D-020 found that semantically different surfaces in this repo produce
 * BYTE-IDENTICAL captures when their distinguishing content arrives after the
 * settle contract is satisfied. Its ruling 1 assigns P-009 one proof:
 *
 *   "prove that a reference ratified for one surface does not silently pass
 *    against a different surface whose capture is identical."
 *
 * That is not a threshold problem. The engine behaves perfectly and returns a
 * diff ratio of 0, because the two images really are the same image. The only
 * place the error can be caught is the CONTRACT: what a required case is
 * contracted against, and what the coverage matcher is willing to accept as
 * satisfying it.
 *
 * These tests are written against the real verbs, not a model of them, because
 * the defect lives in the seam between three surfaces that each look correct
 * alone: ratification records a reference, comparison records evidence, and
 * coverage decides which evidence answers which requirement.
 *
 * `ratification.ts` states the invariant under test in its own words —
 * "Requirement 9 — a passing case never covers a different one."
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
  getDesignEvidenceVerb,
  ratifyReferenceVerb,
} from './verbs';

const HARNESS = 'test-harness';
const FEATURE = 'F-020';
const REFERENCE = 'ref-host-check-banner';

/**
 * The surface the reference was ratified FROM, and a different surface that
 * D-020 measured as producing an identical capture. These are real story ids
 * from that finding: both render at 1280x800 and share sha256 77cf25fa...
 */
const RATIFIED_SURFACE = 'components-hostcheckbanner--gated-shared';
const OTHER_SURFACE = 'components-hostcheckbanner--already-acked';

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

/**
 * A provider that reports ZERO pixels different.
 *
 * This is the whole point of the class: it is not a lenient stub standing in
 * for a real engine, it is what a real engine genuinely returns for two
 * identical images. Nothing downstream may rely on the diff to tell these
 * surfaces apart, because there is no difference to find.
 */
function identicalCaptureProvider(): ComparisonProvider & { calls: number } {
  const provider = {
    calls: 0,
    engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
    async compare() {
      provider.calls += 1;
      return { pixelDifference: 0, diffArtifactWritten: true };
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
    comparison: { provider: identicalCaptureProvider(), probe: probeOk },
    ...overrides,
  };
}

function ratifyInput(overrides: Partial<RatifyReferenceInput> = {}): RatifyReferenceInput {
  return {
    featureId: FEATURE,
    referenceId: REFERENCE,
    revision: 1,
    referenceClass: 'artifact-capture',
    contentSha256: '77cf25fa'.padEnd(64, '0'),
    image: {
      mediaType: 'image/png',
      locator: '/refs/host-check-banner.png',
      byteLength: 4096,
      width: 1280,
      height: 800,
    },
    referenceEnvironment: ENV,
    requiredCases: [
      {
        caseId: 'gated-shared-desktop',
        environment: ENV,
        target: { targetId: RATIFIED_SURFACE, targetKind: 'storybook-story' },
        rationale: 'the ratified surface at its contracted breakpoint',
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
    target: {
      targetId: RATIFIED_SURFACE,
      targetKind: 'storybook-story',
      implementationRevision: 'impl-1',
    },
    environment: ENV,
    policy: POLICY,
    actualImagePath: '/tmp/actual.png',
    diffImagePath: '/tmp/diff.png',
    ...overrides,
  };
}

// ─── the fourth bypass class ─────────────────────────────────────────────────

describe('D-020 class 4: a different surface with an identical capture', () => {
  it('does not report the required case covered when the evidence came from another surface', async () => {
    const d = deps();
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);

    // The implementer captures the WRONG story. It renders identically, so the
    // engine — correctly — finds nothing to report.
    const compared = await compareRenderVerb(
      compareInput({
        target: {
          targetId: OTHER_SURFACE,
          targetKind: 'storybook-story',
          implementationRevision: 'impl-1',
        },
      }),
      CALLER,
      d,
    );
    expect(compared.ok).toBe(true);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const covered = read.coverage.find((c) => c.caseId === 'gated-shared-desktop');
    expect(covered).toBeDefined();

    // The assertion the whole class reduces to. A zero diff ratio is evidence
    // that two images match; it is not evidence that the RIGHT thing was built.
    expect(covered?.evidenceArtifactId).toBeNull();
    expect(covered?.verdict).toBeNull();
  });

  it('refuses the comparison outright, before an engine is invoked', async () => {
    const provider = identicalCaptureProvider();
    const d = deps({ comparison: { provider, probe: probeOk } });
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);

    const compared = await compareRenderVerb(
      compareInput({
        target: {
          targetId: OTHER_SURFACE,
          targetKind: 'storybook-story',
          implementationRevision: 'impl-1',
        },
      }),
      CALLER,
      d,
    );

    // Asserting a verdict of 'invalid' would not prove the engine was skipped,
    // and "we refuse before measuring" is precisely the claim: measuring an
    // unrequired surface produces a number that looks like evidence and is not.
    expect(provider.calls).toBe(0);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.result.verdict).toBe('invalid');
    expect(compared.result.invalidReason).toBe('target-mismatch');
  });

  it('still covers the case when the evidence came from the ratified surface', async () => {
    // The calibration case. Without it, the two assertions above also pass when
    // coverage is broken in the opposite direction — reporting nothing covered
    // ever — which would be a guard that proves only that it can say no.
    const d = deps();
    expect((await ratifyReferenceVerb(ratifyInput(), CALLER, d)).ok).toBe(true);
    expect((await compareRenderVerb(compareInput(), CALLER, d)).ok).toBe(true);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const covered = read.coverage.find((c) => c.caseId === 'gated-shared-desktop');
    expect(covered?.evidenceArtifactId).not.toBeNull();
    expect(covered?.verdict).toBe('pass');
  });
});

// ─── requirement 9, which D-019 makes unenforceable by environment alone ─────

describe('requirement 9: a passing case never covers a different one', () => {
  it('does not let one capture satisfy two required cases', async () => {
    // D-019 contracts every required case at the reference's OWN environment,
    // so two cases on one reference necessarily share an environment. A matcher
    // keyed on environment alone therefore cannot tell them apart at all: the
    // first evidence record answers every case at once. The surfaces are what
    // differ, which is why the case has to name one.
    const d = deps();
    const ratified = await ratifyReferenceVerb(
      ratifyInput({
        requiredCases: [
          {
            caseId: 'gated-shared-desktop',
            environment: ENV,
            target: { targetId: RATIFIED_SURFACE, targetKind: 'storybook-story' },
            rationale: 'the ratified surface',
          },
          {
            caseId: 'allowed-no-banner-desktop',
            environment: ENV,
            target: {
              targetId: 'components-hostcheckbanner--allowed-no-banner',
              targetKind: 'storybook-story',
            },
            rationale: 'the sibling surface, which D-020 measured as identical',
          },
        ],
      }),
      CALLER,
      d,
    );
    expect(ratified.ok).toBe(true);

    expect((await compareRenderVerb(compareInput(), CALLER, d)).ok).toBe(true);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const first = read.coverage.find((c) => c.caseId === 'gated-shared-desktop');
    const second = read.coverage.find((c) => c.caseId === 'allowed-no-banner-desktop');

    expect(first?.evidenceArtifactId).not.toBeNull();
    expect(second?.evidenceArtifactId).toBeNull();
  });
});
