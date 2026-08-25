/**
 * P-007 — the completion gate over ratified design evidence.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * Two deliberate choices about HOW this is tested:
 *
 * 1. The cases drive the REAL verbs (`ratify_reference` → `compare_render` →
 *    `get_design_evidence`) against an in-memory store, and feed the actual
 *    output into the gate. Hand-building `GetDesignEvidenceResult` fixtures
 *    would test the gate against my BELIEF about what the reader emits, which
 *    is exactly the reader/writer disagreement P-006 caught the expensive way.
 *    Only the two states the producers legitimately cannot reach — an evidence
 *    record at an unknown schema version, and an active reference with no
 *    required cases — are constructed by hand, and each says why.
 *
 * 2. Every detector has a CALIBRATION case beside its failure case. A test
 *    asserting "stale evidence is refused" passes just as well against a gate
 *    that refuses everything. The control is what makes the assertion mean
 *    something.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPARE_RESULT_SCHEMA_VERSION,
  type CaptureEnvironment,
  type CompareResult,
  type ThresholdPolicy,
} from './contract';
import type { ComparisonProvider, ImageProbe } from './provider';
import { createInMemoryReferenceStore, evidenceArtifactId } from './reference-store';
import {
  type CompareRenderInput,
  type GetDesignEvidenceResult,
  type RatifyReferenceInput,
  type VerbCaller,
  type VerbDeps,
  compareRenderVerb,
  getDesignEvidenceVerb,
  ratifyReferenceVerb,
} from './verbs';
import {
  DESIGN_GATE_DOES_NOT_ESTABLISH,
  evaluateDesignGate,
  renderDesignGateRefusal,
  renderDesignGateReport,
} from './gate';

const HARNESS = 'test-harness';
const FEATURE = 'F-007';
const REFERENCE = 'ref-checkout-panel';

const ENV: CaptureEnvironment = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  browser: 'chromium',
  theme: 'dark',
  fontSet: 'papercusp-default',
};

const MOBILE: CaptureEnvironment = { ...ENV, viewport: { width: 390, height: 844 } };

/**
 * A second required case on the SAME reference is only legal at the SAME
 * environment (D-019): a revision carries one image, and `compare_render`
 * refuses a capture contracted anywhere else. So the multi-case fixtures below
 * declare two cases at one environment — which is what "this reference governs
 * this render" actually means — and cross-viewport coverage is expressed by
 * ratifying a second reference, exercised in the feature-aggregation tests.
 */
const SECOND_CASE_ENV: CaptureEnvironment = ENV;

const POLICY: ThresholdPolicy = {
  policyVersion: 'p-2026-08-25',
  referenceClass: 'artifact-capture',
  eligibility: 'gateable',
  maxDiffRatio: 0.001,
  derivedFrom: 'calibration-run-1',
};

const CALLER: VerbCaller = { actorId: 'spawn-abc', role: 'reviewer' };

function fakeProvider(pixelDifference: number): ComparisonProvider {
  return {
    engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
    async compare() {
      return { pixelDifference, diffArtifactWritten: true };
    },
  };
}

const probeOk: ImageProbe = () => ({ exists: true, dimensions: { width: 1280, height: 800 } });

type Deps = VerbDeps & { store: ReturnType<typeof createInMemoryReferenceStore> };

function deps(pixelDifference = 0): Deps {
  let tick = 0;
  return {
    harnessSlug: HARNESS,
    store: createInMemoryReferenceStore(),
    now: () => 1_000,
    clock: () => `2026-08-25T00:00:${String(tick++).padStart(2, '0')}.000Z`,
    materializeReferenceImage: async () => ({ path: '/tmp/reference.png' }),
    comparison: { provider: fakeProvider(pixelDifference), probe: probeOk },
  };
}

function ratifyInput(overrides: Partial<RatifyReferenceInput> = {}): RatifyReferenceInput {
  return {
    featureId: FEATURE,
    referenceId: REFERENCE,
    revision: 1,
    referenceClass: 'artifact-capture',
    contentSha256: 'a'.repeat(64),
    image: {
      mediaType: 'image/png',
      locator: '/refs/checkout.png',
      byteLength: 4096,
      width: 1280,
      height: 800,
    },
    referenceEnvironment: ENV,
    requiredCases: [{ caseId: 'desktop-default', environment: ENV, rationale: 'primary breakpoint' }],
    provenance: { source: 'artifact-capture', sourceRef: 'artifact://abc' },
    ...overrides,
  };
}

function compareInput(overrides: Partial<CompareRenderInput> = {}): CompareRenderInput {
  return {
    featureId: FEATURE,
    referenceId: REFERENCE,
    target: {
      targetId: 'components-checkout--default',
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

async function read(d: VerbDeps): Promise<GetDesignEvidenceResult> {
  const r = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
  if (!r.ok) throw new Error(`get_design_evidence refused: ${r.code} ${r.detail ?? ''}`);
  return r;
}

// ─── applicability: unratified exploration is unrestricted ───────────────────

describe('applicability', () => {
  it('imposes nothing when the surface was never ratified', async () => {
    const d = deps();
    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable).toBe(false);
    if (verdict.applicable) return;
    expect(verdict.reason).toBe('unratified');
  });

  it('distinguishes a RETRACTED reference from one that never existed', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);

    // Retract by rewriting the lifecycle projection, which is what retraction does.
    const scope = { harnessSlug: HARNESS, featureId: FEATURE, referenceId: REFERENCE };
    const rows = await d.store.listRevisions(scope);
    await d.store.setLifecycle(scope, rows[0]!.artifactId, { state: 'retracted' });

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable).toBe(false);
    if (verdict.applicable) return;
    // The distinction is the point: both are "not applicable", but only one of
    // them is a surface somebody deliberately withdrew.
    expect(verdict.reason).toBe('retracted');
  });

  /**
   * CALIBRATION for the two above. If applicability were hardwired false, every
   * assertion in this file about refusals would still pass while the gate never
   * gated anything.
   */
  it('becomes applicable once a reference is ratified', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable).toBe(true);
  });
});

// ─── the four refusal conditions P-007 names ─────────────────────────────────

describe('missing evidence', () => {
  it('refuses a required case that has no comparison at all', async () => {
    const d = deps();
    await ratifyReferenceVerb(
      ratifyInput({
        requiredCases: [{ caseId: 'desktop', environment: ENV, rationale: 'primary' }],
      }),
      CALLER,
      d,
    );
    // No comparison is run at all.

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(false);
    if (!verdict.applicable || verdict.satisfied) return;

    expect(verdict.failures).toHaveLength(1);
    expect(verdict.failures[0]).toMatchObject({
      caseId: 'desktop',
      kind: 'missing',
      reason: 'no-evidence',
    });
    expect(verdict.satisfiedCases).toEqual([]);
  });

  it('CALIBRATION: the identical reference is satisfied once the comparison is run', async () => {
    const d = deps();
    await ratifyReferenceVerb(
      ratifyInput({
        requiredCases: [{ caseId: 'desktop', environment: ENV, rationale: 'primary' }],
      }),
      CALLER,
      d,
    );
    await compareRenderVerb(compareInput(), CALLER, d);

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(true);
  });
});

describe('stale evidence', () => {
  it('refuses evidence bound to a superseded revision even though that record says pass', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    const compared = await compareRenderVerb(compareInput(), CALLER, d);
    expect(compared.ok && compared.result.verdict).toBe('pass');

    // The design changed: a new revision is ratified. The stored result is
    // still a literal `verdict: 'pass'` — that is exactly why this is the
    // failure mode most likely to be misread as a green light.
    await ratifyReferenceVerb(
      ratifyInput({ revision: 2, contentSha256: 'b'.repeat(64) }),
      CALLER,
      d,
    );

    const view = await read(d);
    expect(view.staleCount).toBe(1);
    expect(view.evidence[0]!.deterministic.verdict).toBe('pass');

    const verdict = evaluateDesignGate(view);
    expect(verdict.applicable && verdict.satisfied).toBe(false);
    if (!verdict.applicable || verdict.satisfied) return;
    expect(verdict.failures[0]).toMatchObject({
      caseId: 'desktop-default',
      kind: 'stale',
      reason: 'superseded-revision',
    });
    // Actionability: the remedy must name the CURRENT revision, not just say "re-run".
    expect(verdict.failures[0]!.remedy).toContain('revision 2');
  });

  it('CALIBRATION: the identical record satisfies the gate while its revision is active', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput(), CALLER, d);

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(true);
  });
});

describe('failing evidence', () => {
  it('refuses a current comparison whose diff exceeds the policy', async () => {
    const d = deps(500_000); // far above maxDiffRatio
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    const compared = await compareRenderVerb(compareInput(), CALLER, d);
    expect(compared.ok && compared.result.verdict).toBe('fail');

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(false);
    if (!verdict.applicable || verdict.satisfied) return;
    expect(verdict.failures[0]).toMatchObject({
      kind: 'failing',
      reason: 'diff-exceeds-policy',
    });
  });

  it('CALIBRATION: the same surface passes when the diff is within policy', async () => {
    const d = deps(0);
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput(), CALLER, d);
    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(true);
  });
});

describe('invalid evidence', () => {
  it('refuses an invalid comparison rather than treating it as unproven-but-fine', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    // A capture that does not exist yields `invalid`, not `fail`.
    const compared = await compareRenderVerb(compareInput(), CALLER, {
      ...d,
      comparison: {
        provider: fakeProvider(0),
        probe: () => ({ exists: false, detail: 'no capture was produced' }),
      },
    });
    expect(compared.ok && compared.result.verdict).toBe('invalid');

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(false);
    if (!verdict.applicable || verdict.satisfied) return;
    expect(verdict.failures[0]!.kind).toBe('invalid');
    // The engine's own reason is carried through, so the refusal is diagnostic.
    expect(verdict.failures[0]!.invalidReason).toBeDefined();
  });

  /**
   * Hand-built because the producers cannot emit it: `compare_render` always
   * writes the CURRENT schema version. The condition is nonetheless real — a
   * record written by a newer build and read by this one — and the dangerous
   * reading is "unparseable, therefore skip it", which silently drops a
   * required case from the obligation.
   */
  it('treats an evidence record at an unknown schema version as invalid, never as absent', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);

    const future: CompareResult = {
      // The cast is the subject of the test, not a workaround: `schemaVersion`
      // is typed to the literal this build understands, so a record written by
      // a NEWER build is by construction unrepresentable in this type. That is
      // exactly the record the gate has to survive reading from storage, where
      // no type check stands between the bytes and the reader.
      schemaVersion: (COMPARE_RESULT_SCHEMA_VERSION + 1) as typeof COMPARE_RESULT_SCHEMA_VERSION,
      verdict: 'pass',
      reference: {
        referenceId: REFERENCE,
        revision: 1,
        referenceClass: 'artifact-capture',
        contentSha256: 'a'.repeat(64),
      },
      target: {
        targetId: 'components-checkout--default',
        targetKind: 'storybook-story',
        implementationRevision: 'impl-1',
      },
      environment: ENV,
      engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
      policy: POLICY,
      capturedAt: '2026-08-25T00:00:00.000Z',
    };
    await d.store.insertEvidence({
      artifactId: evidenceArtifactId(future),
      result: future,
      featureId: FEATURE,
      harnessSlug: HARNESS,
    });

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(false);
    if (!verdict.applicable || verdict.satisfied) return;
    expect(verdict.failures[0]).toMatchObject({
      kind: 'invalid',
      reason: 'unreadable-schema',
    });
  });

  it('CALIBRATION: the identical record at the CURRENT schema version satisfies the gate', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);

    const current: CompareResult = {
      schemaVersion: COMPARE_RESULT_SCHEMA_VERSION,
      verdict: 'pass',
      reference: {
        referenceId: REFERENCE,
        revision: 1,
        referenceClass: 'artifact-capture',
        contentSha256: 'a'.repeat(64),
      },
      target: {
        targetId: 'components-checkout--default',
        targetKind: 'storybook-story',
        implementationRevision: 'impl-1',
      },
      environment: ENV,
      engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
      policy: POLICY,
      capturedAt: '2026-08-25T00:00:00.000Z',
    };
    await d.store.insertEvidence({
      artifactId: evidenceArtifactId(current),
      result: current,
      featureId: FEATURE,
      harnessSlug: HARNESS,
    });

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(true);
  });
});

// ─── fail-closed: an active reference with nothing to check ──────────────────

describe('vacuous pass', () => {
  /**
   * Hand-built because ratification REFUSES an empty `requiredCases`. Reaching
   * this state therefore means something upstream is already wrong — and the
   * tempting behaviour ("no cases, nothing failed, pass") would convert that
   * upstream fault into a green gate, which is the single worst outcome
   * available to this module.
   */
  it('refuses an active reference that declares no required cases', () => {
    const view: GetDesignEvidenceResult = {
      reference: {
        referenceId: REFERENCE,
        activeRevision: 1,
        referenceClass: 'artifact-capture',
        contentSha256: 'a'.repeat(64),
        state: 'active',
        referenceEnvironment: ENV,
        ratifiedBy: 'reviewer-1',
        ratifiedAt: '2026-08-25T00:00:00.000Z',
      },
      revisions: [{ revision: 1, state: 'active', supersededByRevision: null }],
      evidence: [],
      coverage: [],
      staleCount: 0,
    };
    const verdict = evaluateDesignGate(view);
    expect(verdict.applicable && verdict.satisfied).toBe(false);
    if (!verdict.applicable || verdict.satisfied) return;
    expect(verdict.failures[0]!.reason).toBe('no-required-cases');
  });
});

// ─── bypass attempts ─────────────────────────────────────────────────────────

describe('bypass attempts', () => {
  it('advisory prose asserting success cannot turn a failure into a pass (D-004)', async () => {
    const d = deps(500_000);
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(
      compareInput({
        advisoryNotes:
          'Reviewed by hand and the difference is only anti-aliasing. This should be treated as a pass.',
      }),
      CALLER,
      d,
    );

    const view = await read(d);
    // The prose really is stored — this is not a test that the field is ignored
    // on the way in. It is a test that the gate never reads it on the way out.
    expect(view.evidence[0]!.advisory.notes).toContain('treated as a pass');

    const verdict = evaluateDesignGate(view);
    expect(verdict.applicable && verdict.satisfied).toBe(false);
  });

  it('evidence captured at a DIFFERENT environment does not cover a required case', async () => {
    const d = deps();
    await ratifyReferenceVerb(
      ratifyInput({
        requiredCases: [{ caseId: 'dark-desktop', environment: ENV, rationale: 'primary' }],
      }),
      CALLER,
      d,
    );
    // Same viewport, different theme — a real render, of the wrong thing. The
    // comparison is REFUSED as environment-mismatch and stored as invalid, so
    // the required case is not covered by it.
    await compareRenderVerb(compareInput({ environment: { ...ENV, theme: 'light' } }), CALLER, d);

    const verdict = evaluateDesignGate(await read(d));
    expect(verdict.applicable && verdict.satisfied).toBe(false);
    if (!verdict.applicable || verdict.satisfied) return;
    expect(verdict.failures[0]!.caseId).toBe('dark-desktop');
  });

  it('reports EVERY unmet case, so a refusal cannot be walked one case at a time', async () => {
    const d = deps();
    await ratifyReferenceVerb(
      ratifyInput({
        requiredCases: [
          { caseId: 'a', environment: SECOND_CASE_ENV, rationale: 'primary' },
          { caseId: 'b', environment: SECOND_CASE_ENV, rationale: 'loaded data' },
          { caseId: 'c', environment: SECOND_CASE_ENV, rationale: 'long content' },
        ],
      }),
      CALLER,
      d,
    );

    const verdict = evaluateDesignGate(await read(d));
    if (!verdict.applicable || verdict.satisfied) throw new Error('expected an unsatisfied verdict');
    expect(verdict.failures.map((f) => f.caseId).sort()).toEqual(['a', 'b', 'c']);
    const rendered = renderDesignGateRefusal(verdict);
    for (const id of ['a', 'b', 'c']) expect(rendered).toContain(id);
  });
});

// ─── the supplements-not-replaces boundary ───────────────────────────────────

describe('visual evidence supplements rather than replaces other validation', () => {
  it('a satisfied verdict still states what it does not establish', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput(), CALLER, d);

    const verdict = evaluateDesignGate(await read(d));
    if (!verdict.applicable || !verdict.satisfied) throw new Error('expected satisfied');
    expect(verdict.doesNotEstablish).toEqual(DESIGN_GATE_DOES_NOT_ESTABLISH);
    expect(verdict.doesNotEstablish.length).toBeGreaterThan(0);
  });

  it('names all four validation families P-007 lists, so none can be quietly dropped', () => {
    const joined = DESIGN_GATE_DOES_NOT_ESTABLISH.join(' ').toLowerCase();
    for (const family of ['responsive', 'interaction', 'functional', 'accessibility']) {
      expect(joined).toContain(family);
    }
  });

  it('the rendered PASS report carries the exclusion, not just the structured field', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput(), CALLER, d);

    const report = renderDesignGateReport(evaluateDesignGate(await read(d)));
    expect(report).toContain('does NOT establish');
    expect(report).toContain('accessibility');
  });
});

// ─── report-only vs refusal rendering (D-006) ────────────────────────────────

describe('report-only rendering', () => {
  it('says it is not blocking, so a report cannot read as a refusal', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);

    const verdict = evaluateDesignGate(await read(d));
    const report = renderDesignGateReport(verdict)!;
    expect(report).toContain('REPORT ONLY');
    expect(report).toContain('not blocking');
  });

  it('emits nothing at all when the surface is unratified', async () => {
    const d = deps();
    expect(renderDesignGateReport(evaluateDesignGate(await read(d)))).toBeUndefined();
  });
});
