/**
 * P-006 — the design-phase verb bodies.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * The item asks for storage, authorization, concurrency, schema-version and
 * round-trip coverage. Each is a `describe` below, and each is written to fail
 * in the direction that would otherwise be REASSURING — a forged principal that
 * gets recorded, a stale revision that gets accepted, an unreadable evidence
 * record that reads as current. A test that only proves the happy path proves
 * that the happy path exists, which was never in doubt.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type RatifyReferenceInput,
  type VerbCaller,
  type VerbDeps,
  compareRenderVerb,
  getDesignEvidenceVerb,
  ratifyReferenceVerb,
} from './verbs';

const HARNESS = 'test-harness';
const FEATURE = 'F-001';
const REFERENCE = 'ref-login-panel';

describe('structured render evidence on the existing comparison artifact', () => {
  it('round-trips observations and refuses changed capture bytes before storage', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'render-observation-'));
    try {
      const actualImagePath = join(folder, 'actual.png');
      const bytes = Buffer.from('controlled image probe input');
      await writeFile(actualImagePath, bytes);
      const environment = { ...ENV, state: 'ready', fixture: 'controlled-state' };
      const d = deps();
      await ratifyReferenceVerb(ratifyInput({ referenceEnvironment: environment,
        requiredCases: [{ caseId: 'ready', environment, target: CASE_TARGET, rationale: 'ready state' }] }), CALLER, d);
      const input = compareInput({ actualImagePath, environment });
      const renderObservation: NonNullable<CompareResult['renderObservation']> = {
        caseId: 'ready', environment, target: input.target, evidenceKind: 'fixture',
        capture: { path: actualImagePath, sha256: createHash('sha256').update(bytes).digest('hex') },
        geometry: { container: { x: 0, y: 0, width: 1280, height: 800, clientWidth: 1280, scrollWidth: 1280 },
          primary: { x: 0, y: 0, width: 900, height: 600 }, secondary: { x: 920, y: 0, width: 340, height: 600 } },
        controls: [{ name: 'Watch', visible: true, enabled: true }], readyContentVisible: true,
        placeholderVisible: false, connectivity: 'not-exercised',
      };
      const good = await compareRenderVerb({ ...input, renderObservation }, CALLER, d);
      expect(good.ok).toBe(true);
      const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
      expect(read.ok && read.evidence[0]?.renderObservation).toEqual(renderObservation);
      expect(read.ok && read.evidence[0]?.deterministic.verdict).toBe('pass');
      await writeFile(actualImagePath, 'changed after capture');
      expect(await compareRenderVerb({ ...input, renderObservation }, CALLER, d)).toMatchObject({
        ok: false, code: 'validation-failed', detail: 'render-observation-capture-bytes-mismatch',
      });
      expect(await compareRenderVerb({ ...input, renderObservation: { ...renderObservation, connectivity: 'connected' } }, CALLER, d))
        .toMatchObject({ ok: false, detail: 'fixture-connectivity-claim' });
      expect(await compareRenderVerb({ ...input, renderObservation: { ...renderObservation, target: { ...input.target, targetId: '/wrong' } } }, CALLER, d))
        .toMatchObject({ ok: false, detail: 'render-observation-target-or-environment-mismatch' });
      // Even an invalid pixel comparison cannot persist malformed metadata.
      expect(await compareRenderVerb({ ...input, environment: { ...environment, theme: 'other' }, renderObservation }, CALLER, d))
        .toMatchObject({ ok: false, detail: 'render-observation-target-or-environment-mismatch' });
    } finally { await rm(folder, { recursive: true, force: true }); }
  });
});

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
 * The surface the required cases here are contracted against, and the one
 * `compareInput` captures. Coverage matches on environment AND surface, so
 * these must agree or every case is uncovered by construction.
 */
const CASE_TARGET = {
  targetId: 'components-login--default',
  targetKind: 'storybook-story',
} as const;

/** A provider that reports a fixed difference and records what it was asked. */
function fakeProvider(pixelDifference: number): ComparisonProvider & { calls: number } {
  const provider = {
    calls: 0,
    engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
    async compare() {
      provider.calls += 1;
      return { pixelDifference, diffArtifactWritten: true };
    },
  };
  return provider;
}

/**
 * A provider that FAILS the test if it is ever invoked.
 *
 * This is how the precondition tests are made falsifiable: asserting that a
 * result says 'environment-mismatch' does not prove the engine was skipped,
 * and "we refuse before invoking an engine" is precisely the claim.
 */
function forbiddenProvider(): ComparisonProvider {
  return {
    engine: { engine: 'forbidden', engineVersion: '0' },
    async compare() {
      throw new Error('the engine was invoked, but this comparison should have been refused first');
    },
  };
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
    comparison: { provider: fakeProvider(0), probe: probeOk },
    ...overrides,
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
      locator: '/refs/login.png',
      byteLength: 4096,
      width: 1280,
      height: 800,
    },
    referenceEnvironment: ENV,
    requiredCases: [
      {
        caseId: 'desktop-default',
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
    target: {
      targetId: 'components-login--default',
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

// ─── round trip ──────────────────────────────────────────────────────────────

describe('round trip: ratify → compare → read', () => {
  it('produces a passing verdict and reports the required case as covered', async () => {
    const d = deps();

    const ratified = await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    expect(ratified.ok).toBe(true);

    const compared = await compareRenderVerb(compareInput(), CALLER, d);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.result.verdict).toBe('pass');
    expect(compared.result.reference.revision).toBe(1);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.reference?.activeRevision).toBe(1);
    expect(read.evidence).toHaveLength(1);
    expect(read.evidence[0]!.current).toBe(true);
    expect(read.staleCount).toBe(0);
    expect(read.coverage).toEqual([
      expect.objectContaining({
        caseId: 'desktop-default',
        evidenceArtifactId: compared.artifactId,
        verdict: 'pass',
      }),
    ]);
  });

  it('reports a required case as uncovered when no evidence exists for it', async () => {
    const d = deps();
    const mobile: CaptureEnvironment = { ...ENV, viewport: { width: 390, height: 844 } };

    // Requirement 9 — a passing case never covers a different one — expressed at
    // the grain the model actually supports. D-019: a revision carries ONE
    // image, so a second viewport is a second REFERENCE, not a second case on
    // this one. (This fixture previously declared both viewports as cases of a
    // single reference, which ratification now refuses precisely because no
    // comparison for the mobile case could ever have passed.)
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await ratifyReferenceVerb(
      ratifyInput({
        referenceId: 'ref-checkout-mobile',
        contentSha256: 'c'.repeat(64),
        referenceEnvironment: mobile,
        image: {
          mediaType: 'image/png',
          locator: '/refs/login-mobile.png',
          byteLength: 2048,
          width: 390,
          height: 844,
        },
        requiredCases: [
          { caseId: 'mobile', environment: mobile, target: CASE_TARGET, rationale: 'mobile breakpoint' },
        ],
      }),
      CALLER,
      d,
    );
    await compareRenderVerb(compareInput(), CALLER, d);

    const desktop = await getDesignEvidenceVerb(
      { featureId: FEATURE, referenceId: REFERENCE },
      CALLER,
      d,
    );
    expect(desktop.ok).toBe(true);
    if (!desktop.ok) return;
    expect(desktop.coverage.map((c) => [c.caseId, c.verdict])).toEqual([['desktop-default', 'pass']]);

    const mobileRead = await getDesignEvidenceVerb(
      { featureId: FEATURE, referenceId: 'ref-checkout-mobile' },
      CALLER,
      d,
    );
    expect(mobileRead.ok).toBe(true);
    if (!mobileRead.ok) return;
    // The mobile case must read as null, NOT inherit the desktop pass. This is
    // the shape of the bug that would silently ship an unverified breakpoint.
    expect(mobileRead.coverage.map((c) => [c.caseId, c.verdict])).toEqual([['mobile', null]]);
  });
});

// ─── authorization ───────────────────────────────────────────────────────────

describe('authorization', () => {
  it('records the HOST-supplied principal, ignoring anything the caller claims', async () => {
    const d = deps();
    // The input type has no `ratifiedBy` field at all, so this is the shape a
    // caller would actually try: smuggle it inside `provenance`, which IS
    // caller-supplied. It must not reach the stored provenance.
    const forged = ratifyInput({
      provenance: {
        source: 'artifact-capture',
        sourceRef: 'artifact://abc',
        ...({ ratifiedBy: 'ceo@example.com' } as object),
      } as RatifyReferenceInput['provenance'],
    });

    const outcome = await ratifyReferenceVerb(forged, { actorId: 'spawn-9', role: 'designer' }, d);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.ratifiedBy).toBe('designer:spawn-9');

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.reference?.ratifiedBy).toBe('designer:spawn-9');
    expect(JSON.stringify(read.reference)).not.toContain('ceo@example.com');
  });

  it('refuses to ratify at all when the host supplied no principal', async () => {
    const outcome = await ratifyReferenceVerb(ratifyInput(), { actorId: '', role: 'reviewer' }, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unauthenticated');
  });

  it('does not write anything when it refuses an unauthenticated ratification', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), { actorId: '', role: 'reviewer' }, d);
    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.reference).toBeNull();
    expect(read.revisions).toEqual([]);
  });
});

// ─── concurrency ─────────────────────────────────────────────────────────────

describe('concurrency', () => {
  it('refuses a second ratification of the same revision instead of overwriting it', async () => {
    const d = deps();
    const first = await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    expect(first.ok).toBe(true);

    const second = await ratifyReferenceVerb(
      ratifyInput({ contentSha256: 'b'.repeat(64) }),
      { actorId: 'spawn-other', role: 'architect' },
      d,
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('revision-conflict');

    // The FIRST writer's bytes must still be what is ratified. A conflict that
    // reported an error while quietly applying the loser's write would be worse
    // than no check at all.
    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.reference?.contentSha256).toBe('a'.repeat(64));
  });

  it('refuses a revision number below the highest ever recorded, even after a supersede', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput({ revision: 1 }), CALLER, d);
    await ratifyReferenceVerb(ratifyInput({ revision: 2, contentSha256: 'b'.repeat(64) }), CALLER, d);

    const stale = await ratifyReferenceVerb(
      ratifyInput({ revision: 1, contentSha256: 'c'.repeat(64) }),
      CALLER,
      d,
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.code).toBe('revision-conflict');
  });

  it('distinguishes a retryable conflict from a malformed submission', async () => {
    // The two refusals ask the caller for different things, and handing back
    // the wrong one sends it down the wrong path: retrying a malformed
    // submission loops forever; not retrying a conflict abandons good work.
    const malformed = await ratifyReferenceVerb(ratifyInput({ requiredCases: [] }), CALLER, deps());
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.code).toBe('validation-failed');
    expect(malformed.errors?.map((e) => e.code)).toContain('no-required-cases');
  });

  it('reports evidence invalidated by a new revision, and reads it back as stale', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput({ revision: 1 }), CALLER, d);
    const compared = await compareRenderVerb(compareInput(), CALLER, d);
    expect(compared.ok).toBe(true);

    const revised = await ratifyReferenceVerb(
      ratifyInput({ revision: 2, contentSha256: 'b'.repeat(64) }),
      CALLER,
      d,
    );
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.supersededRevision).toBe(1);
    expect(revised.invalidatedEvidence.map((e) => e.referenceRevision)).toEqual([1]);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.staleCount).toBe(1);
    expect(read.evidence[0]!.current).toBe(false);
    expect(read.coverage[0]!.verdict).toBeNull();
  });
});

// ─── storage ─────────────────────────────────────────────────────────────────

describe('storage', () => {
  it('re-running the same comparison replaces its evidence rather than adding a rival', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);

    const first = await compareRenderVerb(compareInput(), CALLER, d);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Same reference revision, same target, same implementation revision, same
    // environment — but a different measurement. Two rows here would be a
    // contradiction a gate cannot resolve, and a caller could re-roll until it
    // liked the answer.
    const d2: VerbDeps = { ...d, comparison: { provider: fakeProvider(50_000), probe: probeOk } };
    const second = await compareRenderVerb(compareInput(), CALLER, d2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.artifactId).toBe(first.artifactId);

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.evidence).toHaveLength(1);
    expect(read.evidence[0]!.deterministic.verdict).toBe('fail');
  });

  it('gives a different environment its own evidence row', async () => {
    const d = deps();
    const mobile: CaptureEnvironment = { ...ENV, viewport: { width: 390, height: 844 } };
    await ratifyReferenceVerb(
      ratifyInput({
        referenceEnvironment: mobile,
        requiredCases: [
          { caseId: 'mobile', environment: mobile, target: CASE_TARGET, rationale: 'mobile' },
        ],
      }),
      CALLER,
      d,
    );
    const a = await compareRenderVerb(compareInput({ environment: mobile }), CALLER, d);
    const b = await compareRenderVerb(
      compareInput({ environment: { ...mobile, state: 'error' } }),
      CALLER,
      d,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.artifactId).not.toBe(b.artifactId);
  });

  it('keeps advisory prose out of the deterministic half of a read', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(
      compareInput({ advisoryNotes: 'the header font looks heavier than the mockup' }),
      CALLER,
      d,
    );

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const view = read.evidence[0]!;
    expect(view.advisory.notes).toContain('header font');
    // D-004: prose may explain a failure and may never establish one. It must
    // not appear anywhere a gate reads.
    expect(JSON.stringify(view.deterministic)).not.toContain('header font');
  });
});

// ─── schema version ──────────────────────────────────────────────────────────

describe('schema version', () => {
  it('never reports a record of an unknown schema version as current', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    const compared = await compareRenderVerb(compareInput(), CALLER, d);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;

    // Rewrite the stored record as if a future build had written it. The
    // reference revision still matches, so revision-matching alone WOULD call
    // this current — which is the failure being guarded: a gate passing on
    // evidence whose shape it cannot parse.
    const store = d.store as ReturnType<typeof createInMemoryReferenceStore>;
    const row = store.evidenceRows.get(compared.artifactId)!;
    const future: CompareResult = { ...row.result, schemaVersion: 999 as never };
    store.evidenceRows.set(compared.artifactId, { ...row, result: future });

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.evidence[0]!.schemaVersionMismatch).toBe(true);
    expect(read.evidence[0]!.current).toBe(false);
    expect(read.staleCount).toBe(1);
    expect(read.coverage[0]!.verdict).toBeNull();
  });

  it('calibration: an unmodified record of the CURRENT schema version reads as current', async () => {
    // Without this, a `current` that was hardwired to false would pass the test
    // above perfectly while making the whole read verb useless.
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput(), CALLER, d);
    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.evidence[0]!.deterministic.schemaVersion).toBe(COMPARE_RESULT_SCHEMA_VERSION);
    expect(read.evidence[0]!.schemaVersionMismatch).toBe(false);
    expect(read.evidence[0]!.current).toBe(true);
  });

  it('stamps the current schema version on every result it writes', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    const compared = await compareRenderVerb(compareInput(), CALLER, d);
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.result.schemaVersion).toBe(COMPARE_RESULT_SCHEMA_VERSION);
  });
});

// ─── the refusal / invalid boundary ──────────────────────────────────────────

describe('refusals are not verdicts', () => {
  it('refuses without minting a CompareResult when nothing has been ratified', async () => {
    const outcome = await compareRenderVerb(compareInput(), CALLER, deps());
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('not-ratified');
    // No verdict of any kind, including 'invalid'. INVALID_REASONS describes
    // comparisons that were attempted; a reference that does not exist has no
    // identity to stamp a result with, so there is nothing to record.
    expect(outcome).not.toHaveProperty('result');
  });

  it('refuses against a retracted reference rather than gating on a withdrawn design', async () => {
    const d = deps();
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    const store = d.store as ReturnType<typeof createInMemoryReferenceStore>;
    const [artifactId] = [...store.rows.keys()];
    await store.setLifecycle(
      { harnessSlug: HARNESS, featureId: FEATURE, referenceId: REFERENCE },
      artifactId!,
      { state: 'retracted' },
    );

    const outcome = await compareRenderVerb(compareInput(), CALLER, d);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('not-ratified');
  });

  it('records an environment mismatch as evidence, and never reaches the engine', async () => {
    const d = deps({ comparison: { provider: forbiddenProvider(), probe: probeOk } });
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);

    const outcome = await compareRenderVerb(
      compareInput({ environment: { ...ENV, theme: 'light' } }),
      CALLER,
      d,
    );
    // This one IS a comparison attempt, so it produces a persisted result —
    // but an `invalid` one, never a pass.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.verdict).toBe('invalid');
    expect(outcome.result.invalidReason).toBe('environment-mismatch');
    expect(outcome.result.detail).toContain('light');

    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.evidence).toHaveLength(1);
  });

  it('calibration: the same provider IS reached when the environment matches', async () => {
    // The forbidden-provider test above proves the engine was skipped only if
    // the engine would otherwise have been called. This is that control.
    const provider = fakeProvider(0);
    const d = deps({ comparison: { provider, probe: probeOk } });
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);
    await compareRenderVerb(compareInput(), CALLER, d);
    expect(provider.calls).toBe(1);
  });

  it('refuses when the reference image cannot be materialised, without storing evidence', async () => {
    const d = deps({
      materializeReferenceImage: async () => ({ error: 'locator points nowhere on this host' }),
      comparison: { provider: forbiddenProvider(), probe: probeOk },
    });
    await ratifyReferenceVerb(ratifyInput(), CALLER, d);

    const outcome = await compareRenderVerb(compareInput(), CALLER, d);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('reference-unreadable');

    // A host that cannot read its own storage must not leave a trail of
    // `invalid` evidence implying the design was measured and found wanting.
    const read = await getDesignEvidenceVerb({ featureId: FEATURE, referenceId: REFERENCE }, CALLER, d);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.evidence).toEqual([]);
  });
});

// ─── derived identity ────────────────────────────────────────────────────────

describe('evidence identity', () => {
  it('derives the same id for the same comparison inputs and a different one otherwise', () => {
    const base = {
      schemaVersion: COMPARE_RESULT_SCHEMA_VERSION,
      verdict: 'pass',
      reference: { referenceId: REFERENCE, revision: 1, referenceClass: 'artifact-capture', contentSha256: 'x' },
      target: { targetId: 't', targetKind: 'storybook-story', implementationRevision: 'impl-1' },
      environment: ENV,
      engine: { engine: 'e', engineVersion: '1' },
      policy: POLICY,
      capturedAt: '2026-08-25T00:00:00.000Z',
    } as unknown as CompareResult;

    expect(evidenceArtifactId(base)).toBe(evidenceArtifactId({ ...base, capturedAt: 'later' }));
    expect(evidenceArtifactId(base)).not.toBe(
      evidenceArtifactId({ ...base, reference: { ...base.reference, revision: 2 } }),
    );
    // `fixture` and `state` are both optional, and a key that dropped either
    // would collapse two genuinely different renders onto one row.
    expect(evidenceArtifactId({ ...base, environment: { ...ENV, fixture: 'a' } })).not.toBe(
      evidenceArtifactId({ ...base, environment: { ...ENV, state: 'a' } }),
    );
  });
});
