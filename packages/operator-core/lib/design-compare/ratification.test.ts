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
// R3(b): the gate itself, so this file can assert AUTHORITY and not only state.
import { createInMemoryReferenceStore, retractReference } from './reference-store';
import { type VerbCaller, type VerbDeps, compareRenderVerb, ratifyReferenceVerb } from './verbs';
import { evaluateFeatureDesignGate } from './feature-gate';

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

/**
 * R3(b) — the GATE, run at each lifecycle state.
 *
 * ─── WHY THIS BLOCK EXISTS IN A STATE-MACHINE FILE ───────────────────────────
 *
 * Everything above this line tests the state machine: which transitions are
 * legal, what `superseded()` returns, when evidence goes stale. None of it runs
 * the gate. That is the BINDING drift this criterion names explicitly — the
 * bound files "partitioning into 'lifecycle states' and 'persistence' with
 * NEITHER exercising the gate's behaviour at those states, i.e. the whole
 * criterion resting on state transitions while the claim is about AUTHORITY".
 *
 * A state machine can be perfectly correct while the gate consults it wrongly,
 * or not at all. `state === 'retracted'` is a fact about a row; "a retracted
 * surface no longer constrains completion" is a fact about the gate, and only
 * the second one is what this criterion claims. So each case below drives the
 * REAL `evaluateFeatureDesignGate` over a REAL store and asserts what the gate
 * concluded — never what the row says.
 *
 * The window is asserted from BOTH sides, because either alone is satisfied by
 * a broken gate: a gate hardwired to impose nothing passes the unratified and
 * retracted cases, and a gate hardwired to always constrain passes the ratified
 * one. Only the transitions between them pin the actual window.
 */
describe('R3(b): the gate binds exactly the ratified window', () => {
  const GATE_HARNESS = 'test-harness';
  const GATE_FEATURE = 'F-window';
  const GATE_REF = 'ref-window';
  const GATE_ENV: CaptureEnvironment = env();
  const CALLER: VerbCaller = { actorId: 'su-window', role: 'reviewer' };

  function gateCtx() {
    const store = createInMemoryReferenceStore();
    let tick = 0;
    const verbDeps: VerbDeps = {
      harnessSlug: GATE_HARNESS,
      store,
      now: () => 1_000,
      clock: () => `2026-08-25T00:00:${String(tick++).padStart(2, '0')}.000Z`,
      materializeReferenceImage: async () => ({ path: '/tmp/reference.png' }),
      comparison: {
        provider: {
          engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
          async compare() {
            return { pixelDifference: 0, diffArtifactWritten: true };
          },
        },
        probe: () => ({ exists: true, dimensions: { ...GATE_ENV.viewport } }),
      },
    };
    return { store, verbDeps };
  }

  const scope = { harnessSlug: GATE_HARNESS, featureId: GATE_FEATURE, referenceId: GATE_REF };

  const ratifyInput = {
    featureId: GATE_FEATURE,
    referenceId: GATE_REF,
    revision: 1,
    referenceClass: 'artifact-capture' as const,
    contentSha256: 'c'.repeat(64),
    image: {
      mediaType: 'image/png' as const,
      locator: `/refs/${GATE_REF}.png`,
      byteLength: 4096,
      width: GATE_ENV.viewport.width,
      height: GATE_ENV.viewport.height,
    },
    referenceEnvironment: GATE_ENV,
    requiredCases: [
      {
        caseId: `${GATE_REF}-case`,
        environment: GATE_ENV,
        target: {
          targetId: `components-window--${GATE_REF}`,
          targetKind: 'storybook-story' as const,
        },
        rationale: 'primary breakpoint',
      },
    ],
    provenance: { source: 'artifact-capture' as const, sourceRef: 'artifact://window' },
  };

  const RETRACTION = {
    actor: 'su-window',
    reason: 'the surface was redesigned and this reference no longer describes it',
    at: '2026-08-25T01:00:00.000Z',
  };

  const runGate = (c: ReturnType<typeof gateCtx>) =>
    evaluateFeatureDesignGate(
      { harnessSlug: GATE_HARNESS, featureId: GATE_FEATURE },
      { store: c.store, verbDeps: c.verbDeps, caller: CALLER },
    );

  it('imposes NOTHING on a surface that was never ratified', async () => {
    // The unratified end of the window. Exploration is unrestricted (D-001):
    // a gate that constrained here would make ratifying a design strictly worse
    // than never touching the system.
    const result = await runGate(gateCtx());
    expect(result.applicable).toBe(false);
  });

  it('constrains once ratified, and STOPS constraining once retracted', async () => {
    // The whole criterion in one case: the same feature, the same gate, three
    // readings — and the transitions between them are what pin the window.
    const c = gateCtx();

    await ratifyReferenceVerb(ratifyInput, CALLER, c.verbDeps);

    // (1) RATIFIED, no evidence yet → the obligation is live and unmet.
    const ratified = await runGate(c);
    expect(ratified.applicable).toBe(true);
    expect(ratified.applicable && ratified.satisfied).toBe(false);
    expect(ratified.applicable && ratified.blocking.map((b) => b.referenceId)).toEqual([GATE_REF]);

    // (2) RETRACTED → the surface returns to unconstrained. This is the
    //     assertion that the state-machine tests above cannot make: it is about
    //     what the GATE concluded, not about what the row now says.
    await retractReference(c.store, scope, RETRACTION);
    const retracted = await runGate(c);
    expect(retracted.applicable).toBe(false);
  });

  it('lifts the constraint WITHOUT destroying the evidence trail', async () => {
    // PROPERTY drift marker: "retraction implemented as a hard delete that
    // destroys the evidence trail". The constraint must lift while the history
    // of what was ratified, and what was measured against it, survives — a
    // retraction that erased its own subject would be unauditable.
    const c = gateCtx();
    await ratifyReferenceVerb(ratifyInput, CALLER, c.verbDeps);
    await compareRenderVerb(
      {
        featureId: GATE_FEATURE,
        referenceId: GATE_REF,
        target: {
          targetId: `components-window--${GATE_REF}`,
          targetKind: 'storybook-story',
          implementationRevision: 'impl-1',
        },
        environment: GATE_ENV,
        policy: {
          policyVersion: 'p-2026-08-25',
          referenceClass: 'artifact-capture',
          eligibility: 'gateable',
          maxDiffRatio: 0.001,
          derivedFrom: 'calibration-run-1',
        },
        actualImagePath: '/tmp/actual.png',
        diffImagePath: '/tmp/diff.png',
      },
      CALLER,
      c.verbDeps,
    );
    expect((await runGate(c)).applicable).toBe(true);

    const outcome = await retractReference(c.store, scope, RETRACTION);

    // The gate has released the surface …
    expect((await runGate(c)).applicable).toBe(false);

    // … and the record of it survives: the revision is still there, marked
    // retracted and attributed, and the evidence rows are reported invalidated
    // rather than deleted.
    const rows = await c.store.listRevisions(scope);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reference.state).toBe('retracted');
    expect(rows[0]!.reference.retraction).toMatchObject({ actor: RETRACTION.actor });
    expect(outcome.invalidatedEvidence.length).toBeGreaterThan(0);
    expect(await c.store.listEvidence(scope)).toHaveLength(outcome.invalidatedEvidence.length);
  });

  it('still DISTINGUISHES a retracted surface from one that was never ratified', async () => {
    // Both read `applicable: false` at the gate, and that is correct — neither
    // constrains. But they must not become the same fact underneath, or
    // "withdrawn after review" silently becomes "never reviewed" and the
    // difference is unrecoverable.
    const c = gateCtx();
    await ratifyReferenceVerb(ratifyInput, CALLER, c.verbDeps);
    await retractReference(c.store, scope, RETRACTION);

    expect(
      await c.store.listFeatureReferenceIds({
        harnessSlug: GATE_HARNESS,
        featureId: GATE_FEATURE,
      }),
    ).toEqual([GATE_REF]);

    const never = gateCtx();
    expect(
      await never.store.listFeatureReferenceIds({
        harnessSlug: GATE_HARNESS,
        featureId: GATE_FEATURE,
      }),
    ).toEqual([]);
  });

  it('FALSIFIABILITY CONTROL: a gate that ignored lifecycle would pass the ratified case and fail these', async () => {
    // The deliberately-wrong implementation, kept permanently in the file
    // (CLAUDE.md's prescribed tier for an imported module).
    //
    // `ignoresLifecycle` is the drift this criterion is written against: a gate
    // that decides applicability from "does a reference row exist" rather than
    // "is a revision ACTIVE". It agrees with the real gate on the ratified case
    // — which is exactly why the ratified assertion alone proves nothing — and
    // disagrees on the retracted one, keeping a withdrawn surface constrained
    // forever.
    const ignoresLifecycle = async (c: ReturnType<typeof gateCtx>) =>
      (
        await c.store.listFeatureReferenceIds({
          harnessSlug: GATE_HARNESS,
          featureId: GATE_FEATURE,
        })
      ).length > 0;

    const c = gateCtx();
    await ratifyReferenceVerb(ratifyInput, CALLER, c.verbDeps);

    // Indistinguishable while ratified: both say "constrained".
    expect((await runGate(c)).applicable).toBe(true);
    expect(await ignoresLifecycle(c)).toBe(true);

    await retractReference(c.store, scope, RETRACTION);

    // Now they part company, and the real gate is the one that releases.
    expect((await runGate(c)).applicable).toBe(false);
    expect(await ignoresLifecycle(c)).toBe(true);
  });
});
