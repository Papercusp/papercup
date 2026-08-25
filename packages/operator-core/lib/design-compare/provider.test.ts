/**
 * P-005: the comparison-provider adapter.
 *
 * The suite is organised around D-010's seven mandatory consequences, because
 * each of them exists to close a measured way the installed engines produce a
 * confident wrong answer. Every consequence has at least one test that fails if
 * the adapter stops enforcing it, and the ones that matter most are proved
 * against the REAL installed engine on the committed corpus rather than against
 * a fake that agrees with us by construction.
 *
 * Two test styles, deliberately:
 *
 *  - GOLDEN tests drive the real lost-pixel pixelmatch comparator over corpus
 *    images whose pixel content is pinned by digest, so the numbers are exact
 *    and a dependency bump breaks them loudly here instead of quietly in a gate.
 *  - FAILURE-PATH tests use injected providers, because the failures that matter
 *    (four different throw shapes, a hung engine, a lying percentage) cannot be
 *    provoked reliably from real inputs, and a test that cannot provoke the
 *    failure it names is not evidence.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CaptureEnvironment,
  CompareResult,
  ImplementationTarget,
  ReferenceIdentity,
  ThresholdPolicy,
} from './contract';
import { CORPUS_IMAGES } from './corpus/cases';
import {
  LOST_PIXEL_DEFAULT_ENGINE,
  type MaterialisedCorpus,
  engineVersions,
  materialiseCorpus,
} from './corpus/harness';
import {
  ENGINE_INVOCATION_THRESHOLD,
  META_ABSENT_INVALID_REASON,
  MetaIndexError,
  PIXELMATCH_ENGINE_ID,
  REQUIRED_LOST_PIXEL_COMPARE_ENGINE,
  assertCompareEngineSelected,
  compareAgainstReference,
  createPixelmatchProvider,
  describeThrown,
  metaEntryToCounts,
  parseMetaIndex,
  reconcileMetaIndex,
  resultForAbsentMetaShot,
  type ComparisonProvider,
  type ComparisonRequest,
  type ImageProbe,
  type PixelmatchCompareModule,
  type ProviderComparison,
  type ProviderRequest,
} from './provider';

const CANVAS = { width: 320, height: 240 } as const;
const PIXELS_TOTAL = CANVAS.width * CANVAS.height;

const ENVIRONMENT: CaptureEnvironment = {
  viewport: { width: CANVAS.width, height: CANVAS.height },
  deviceScaleFactor: 1,
  browser: 'chromium-131',
  theme: 'light',
  fontSet: 'inter-v13',
  state: 'default',
};

const TARGET: ImplementationTarget = {
  targetId: 'components-card--default',
  targetKind: 'storybook-story',
  implementationRevision: 'impl-1',
};

function reference(referenceClass: ReferenceIdentity['referenceClass']): ReferenceIdentity {
  return {
    referenceId: `ref-${referenceClass}`,
    revision: 1,
    referenceClass,
    contentSha256: 'a'.repeat(64),
  };
}

function policy(
  referenceClass: ThresholdPolicy['referenceClass'],
  overrides: Partial<ThresholdPolicy> = {},
): ThresholdPolicy {
  return {
    policyVersion: 'test-policy-1',
    referenceClass,
    eligibility: 'gateable',
    maxDiffRatio: 0.01,
    derivedFrom: 'P-005 provider tests',
    ...overrides,
  };
}

let workDir: string;
let corpus: MaterialisedCorpus;
let installedVersions: ReturnType<typeof engineVersions>;

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'design-compare-provider-'));
  corpus = materialiseCorpus(path.join(workDir, 'corpus'));
  installedVersions = engineVersions();
});

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

function imagePath(key: string): string {
  const found = corpus.paths.get(key);
  if (!found) throw new Error(`corpus image '${key}' was not materialised`);
  return found;
}

let diffCounter = 0;
function freshDiffPath(): string {
  diffCounter += 1;
  return path.join(workDir, 'diff', `diff-${diffCounter}.png`);
}

function request(overrides: Partial<ComparisonRequest> = {}): ComparisonRequest {
  return {
    reference: reference('artifact-capture'),
    target: TARGET,
    environment: ENVIRONMENT,
    policy: policy('artifact-capture'),
    referenceImagePath: imagePath('artifact/reference'),
    actualImagePath: imagePath('artifact/faithful'),
    diffImagePath: freshDiffPath(),
    capturedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

/** A provider that refuses to be invoked. Used to prove a guard runs BEFORE the engine. */
function neverCalledProvider(): ComparisonProvider {
  return {
    engine: { engine: PIXELMATCH_ENGINE_ID, engineVersion: '0.0.0-test' },
    compare(): Promise<ProviderComparison> {
      throw new Error('the engine was invoked, but this guard must refuse before invocation');
    },
  };
}

function fixedProvider(comparison: ProviderComparison): ComparisonProvider {
  return {
    engine: { engine: PIXELMATCH_ENGINE_ID, engineVersion: '0.0.0-test' },
    compare: async () => comparison,
  };
}

function throwingProvider(thrown: unknown): ComparisonProvider {
  return {
    engine: { engine: PIXELMATCH_ENGINE_ID, engineVersion: '0.0.0-test' },
    compare: async () => {
      throw thrown;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GOLDEN — the real engine, the committed corpus, exact numbers
// ─────────────────────────────────────────────────────────────────────────────

describe('golden: the real pixelmatch provider over the committed corpus', () => {
  it('normalises a faithful artifact-capture pair into a passing contract result', async () => {
    const provider = createPixelmatchProvider();
    const req = request({ policy: policy('artifact-capture', { maxDiffRatio: 0.01 }) });
    const result = await compareAgainstReference(req, { provider });

    expect(result.verdict).toBe('pass');
    expect(result.invalidReason).toBeUndefined();
    expect(result.schemaVersion).toBe(1);

    // Consequence 7: engine id AND version, from the installed package.
    expect(result.engine).toEqual({
      engine: PIXELMATCH_ENGINE_ID,
      engineVersion: installedVersions['lost-pixel'],
    });

    // Consequence 4: our denominator, not the engine's.
    expect(result.counts?.pixelsTotal).toBe(PIXELS_TOTAL);
    expect(result.diffRatio).toBeCloseTo(result.counts!.pixelDifference / PIXELS_TOTAL, 12);

    // The measured noise floor for this class (D-011: 0.253%). Pinned as a band
    // rather than an exact count so a pixelmatch patch release is a review, not
    // an outage — but tight enough that a real change in what counts as a
    // difference cannot slip through.
    expect(result.diffRatio).toBeGreaterThan(0.001);
    expect(result.diffRatio).toBeLessThan(0.01);

    // Consequence 3: invoked at threshold 0, so the artifact always exists.
    expect(result.artifacts?.diffImage).toBe(req.diffImagePath);
    expect(readFileSync(req.diffImagePath).length).toBeGreaterThan(0);

    // D-002: the adapter localises nothing itself.
    expect(result.diffRegions).toBeUndefined();
  });

  it('fails a genuine artifact-capture regression under the same policy', async () => {
    const provider = createPixelmatchProvider();
    const result = await compareAgainstReference(
      request({
        actualImagePath: imagePath('artifact/drifted'),
        policy: policy('artifact-capture', { maxDiffRatio: 0.01 }),
      }),
      { provider },
    );

    expect(result.verdict).toBe('fail');
    expect(result.diffRatio).toBeGreaterThan(0.02);
    expect(result.detail).toMatch(/exceeds 0\.01/);
  });

  it('refuses an advisory-only class instead of gating it', async () => {
    const provider = createPixelmatchProvider();
    const result = await compareAgainstReference(
      request({
        reference: reference('raster-mockup'),
        referenceImagePath: imagePath('mockup/reference'),
        actualImagePath: imagePath('mockup/faithful'),
        policy: policy('raster-mockup', { eligibility: 'advisory-only', maxDiffRatio: 0 }),
      }),
      { provider },
    );

    expect(result.verdict).toBe('invalid');
    expect(result.invalidReason).toBe('ungateable-reference-class');
    // The measurement still happened and is still recorded — the refusal is
    // about meaning, not about failing to look.
    expect(result.counts?.pixelsTotal).toBe(PIXELS_TOTAL);
    expect(result.diffRatio).toBeGreaterThan(0.5);
  });

  it('is repeatable: the same pair yields identical counts across runs', async () => {
    const provider = createPixelmatchProvider();
    const first = await compareAgainstReference(request(), { provider });
    const second = await compareAgainstReference(request(), { provider });
    expect(second.counts).toEqual(first.counts);
    expect(second.diffRatio).toBe(first.diffRatio);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consequence 1 — pixelmatch is SELECTED, never inherited
// ─────────────────────────────────────────────────────────────────────────────

describe('consequence 1: the engine is selected explicitly', () => {
  it('calls the pixelmatch comparator and never a dispatcher or odiff', async () => {
    const calls: unknown[][] = [];
    const module = {
      compareImagesViaPixelmatch: async (...args: unknown[]) => {
        calls.push(args);
        return { pixelDifference: 7, pixelDifferencePercentage: 0.1, isWithinThreshold: true };
      },
      // Present on the real module. If the adapter ever reaches for either of
      // these, this test fails loudly rather than silently measuring odiff.
      compareImages: () => {
        throw new Error('the config-reading dispatcher must never be called');
      },
      compareImagesViaOdiff: () => {
        throw new Error('odiff must never be called');
      },
    } as unknown as PixelmatchCompareModule;

    const provider = createPixelmatchProvider({
      module,
      version: '3.22.0',
      fileExists: () => true,
      ensureDirectory: () => {},
    });
    expect(provider.engine).toEqual({ engine: PIXELMATCH_ENGINE_ID, engineVersion: '3.22.0' });

    await provider.compare({
      referenceImagePath: '/ref.png',
      actualImagePath: '/act.png',
      diffImagePath: '/diff.png',
      threshold: ENGINE_INVOCATION_THRESHOLD,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([0, '/ref.png', '/act.png', '/diff.png']);
  });

  it('pins the reason the dispatcher is bypassed: its default here is NOT pixelmatch', () => {
    // If lost-pixel ever changes this default, the bypass is still correct but
    // its justification has moved — which is a documentation change, and this
    // failure is what forces it.
    expect(LOST_PIXEL_DEFAULT_ENGINE).toBe('odiff');
    expect(REQUIRED_LOST_PIXEL_COMPARE_ENGINE).toBe('pixelmatch');
  });

  it('refuses a lost-pixel config that would dispatch to the blind engine', () => {
    expect(() => assertCompareEngineSelected({})).toThrow(/unset/);
    expect(() => assertCompareEngineSelected({ compareEngine: 'odiff' })).toThrow(/'odiff'/);
    expect(() => assertCompareEngineSelected({ compareEngine: 'pixelmatch' })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consequence 2 — unequal dimensions refused BEFORE the engine
// ─────────────────────────────────────────────────────────────────────────────

describe('consequence 2: unequal dimensions are refused before invocation', () => {
  it('refuses the pair both engines report as a clean pass, without calling the engine', async () => {
    const result = await compareAgainstReference(
      request({
        referenceImagePath: imagePath('dimension/reference'),
        actualImagePath: imagePath('dimension/wider-same-content'),
      }),
      { provider: neverCalledProvider() },
    );

    expect(result.verdict).toBe('invalid');
    expect(result.invalidReason).toBe('dimension-mismatch');
    expect(result.detail).toMatch(/320x240/);
    expect(result.detail).toMatch(/360x240/);
    expect(result.counts).toBeUndefined();
  });

  it('is not satisfied by the images merely agreeing with each other', async () => {
    // Both images are 320x240 and agree; the CONTRACT says 375x812. That is a
    // capture taken at the wrong environment, not evidence about this reference.
    const result = await compareAgainstReference(
      request({ expectedDimensions: { width: 375, height: 812 } }),
      { provider: neverCalledProvider() },
    );
    expect(result.verdict).toBe('invalid');
    expect(result.invalidReason).toBe('environment-mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consequence 3 — always a diff path, always threshold 0
// ─────────────────────────────────────────────────────────────────────────────

describe('consequence 3: a difference path is mandatory and the threshold is 0', () => {
  it('refuses a comparison with no difference path rather than running it', async () => {
    const result = await compareAgainstReference(request({ diffImagePath: '' }), {
      provider: neverCalledProvider(),
    });
    expect(result.verdict).toBe('invalid');
    expect(result.invalidReason).toBe('unsupported-input');
    expect(result.detail).toMatch(/isWithinThreshold:true unconditionally/);
  });

  it('the provider itself refuses an empty diff path and a non-zero threshold', async () => {
    const provider = createPixelmatchProvider({
      module: {
        compareImagesViaPixelmatch: async () => ({
          pixelDifference: 0,
          pixelDifferencePercentage: 0,
          isWithinThreshold: true,
        }),
      },
      version: '3.22.0',
      fileExists: () => true,
      ensureDirectory: () => {},
    });

    const base: ProviderRequest = {
      referenceImagePath: '/ref.png',
      actualImagePath: '/act.png',
      diffImagePath: '/diff.png',
      threshold: ENGINE_INVOCATION_THRESHOLD,
    };
    await expect(provider.compare({ ...base, diffImagePath: '' })).rejects.toThrow(/mandatory/);
    await expect(provider.compare({ ...base, threshold: 0.05 })).rejects.toThrow(/threshold 0/);
  });

  it('does not claim a diff artifact the engine never wrote', async () => {
    const result = await compareAgainstReference(request(), {
      provider: fixedProvider({ pixelDifference: 0, diffArtifactWritten: false }),
    });
    expect(result.verdict).toBe('pass');
    expect(result.artifacts?.diffImage).toBeUndefined();
    expect(result.artifacts?.referenceImage).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consequence 4 — our denominator, never the engine's percentage
// ─────────────────────────────────────────────────────────────────────────────

describe('consequence 4: the denominator comes from the reference image', () => {
  it('ignores an engine percentage that disagrees with the true ratio', async () => {
    const result = await compareAgainstReference(request(), {
      provider: fixedProvider({
        pixelDifference: 768, // exactly 1% of 320x240
        engineReportedPercentage: 0.0001, // the engine's own, deliberately wrong
        engineReportedWithinThreshold: true,
        diffArtifactWritten: true,
      }),
    });

    expect(result.counts?.pixelsTotal).toBe(PIXELS_TOTAL);
    expect(result.diffRatio).toBeCloseTo(0.01, 12);
    // The advisory boolean is recorded for forensics and never consulted (D-008).
    expect(result.counts?.engineReportedWithinThreshold).toBe(true);
    // Recomputed under our policy: 1% is exactly at the bound, so it passes.
    expect(result.verdict).toBe('pass');
  });

  it('fails a difference the engine claimed was within threshold', async () => {
    // The fail-open shape, made explicit: the engine says fine, the counts say no.
    const result = await compareAgainstReference(request(), {
      provider: fixedProvider({
        pixelDifference: PIXELS_TOTAL,
        engineReportedWithinThreshold: true,
        diffArtifactWritten: true,
      }),
    });
    expect(result.verdict).toBe('fail');
    expect(result.diffRatio).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consequence 5 — every throw shape maps to invalid/engine-error
// ─────────────────────────────────────────────────────────────────────────────

describe('consequence 5: any provider throw becomes invalid, never a pass', () => {
  const thrownShapes: readonly { readonly name: string; readonly value: unknown }[] = [
    { name: 'a plain Error', value: new Error('boom') },
    { name: 'a TypeError', value: new TypeError("Cannot read properties of undefined") },
    { name: "lost-pixel's own message", value: new Error("Couldn't compare images") },
    {
      name: 'an OCaml native-binary message',
      value: new Error('internal error, uncaught exception: Failure("bad png")'),
    },
    { name: 'a bare string', value: 'odiff exited with code 1' },
    { name: 'undefined', value: undefined },
    { name: 'null', value: null },
    { name: 'a non-Error object', value: { message: 'not an Error instance' } },
    { name: 'an unserialisable object', value: { get message() { throw new Error('nope'); } } },
  ];

  for (const shape of thrownShapes) {
    it(`maps ${shape.name} to invalid/engine-error`, async () => {
      const result = await compareAgainstReference(request(), {
        provider: throwingProvider(shape.value),
      });
      expect(result.verdict).toBe('invalid');
      expect(result.invalidReason).toBe('engine-error');
      // The refusal must name the engine, or it is not actionable.
      expect(result.detail).toContain(PIXELMATCH_ENGINE_ID);
      expect(result.detail).not.toMatch(/undefined threw/);
      expect(result.counts).toBeUndefined();
    });
  }

  it('describeThrown never produces "undefined" for a non-Error', () => {
    expect(describeThrown(undefined)).toBe('thrown undefined');
    expect(describeThrown(null)).toBe('thrown null');
    expect(describeThrown('x')).toBe('thrown string: x');
    expect(describeThrown(new TypeError('t'))).toBe('TypeError: t');
    expect(describeThrown({ message: 'm' })).toBe('thrown object: m');
    expect(describeThrown(42)).toBe('thrown number: 42');
  });

  it('describeThrown cannot itself throw, whatever it is handed', () => {
    // A describer that throws lands its own error inside the catch block that
    // was supposed to contain the failure — an unhandled rejection where an
    // `invalid` result was promised.
    const hostileObject = {
      get message(): string {
        throw new Error('nope');
      },
    };
    expect(describeThrown(hostileObject)).toBe('thrown object: <unserialisable>');

    const hostileError = new Error('start');
    Object.defineProperty(hostileError, 'message', {
      get() {
        throw new Error('nope');
      },
    });
    expect(describeThrown(hostileError)).toBe('Error');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeThrown(circular)).toBe('thrown object: <unserialisable>');
  });

  it('maps a hung engine to engine-timeout, distinctly from engine-error', async () => {
    const hung: ComparisonProvider = {
      engine: { engine: PIXELMATCH_ENGINE_ID, engineVersion: '0.0.0-test' },
      compare: () => new Promise<ProviderComparison>(() => {}),
    };
    const result = await compareAgainstReference(request({ timeoutMs: 25 }), { provider: hung });
    expect(result.verdict).toBe('invalid');
    expect(result.invalidReason).toBe('engine-timeout');
    expect(result.detail).toMatch(/25ms budget/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Missing inputs and unreadable inputs
// ─────────────────────────────────────────────────────────────────────────────

describe('missing and unreadable inputs are distinguished', () => {
  it('reports a missing reference and a missing capture differently', async () => {
    const missingReference = await compareAgainstReference(
      request({ referenceImagePath: path.join(workDir, 'nope-reference.png') }),
      { provider: neverCalledProvider() },
    );
    expect(missingReference.invalidReason).toBe('missing-reference');

    const missingCapture = await compareAgainstReference(
      request({ actualImagePath: path.join(workDir, 'nope-capture.png') }),
      { provider: neverCalledProvider() },
    );
    expect(missingCapture.invalidReason).toBe('missing-capture');
  });

  it('refuses a corrupt image rather than deriving a denominator from it', async () => {
    const corruptPath = path.join(workDir, 'corrupt.png');
    writeFileSync(corruptPath, Buffer.alloc(32, 0x00));
    const result = await compareAgainstReference(request({ referenceImagePath: corruptPath }), {
      provider: neverCalledProvider(),
    });
    expect(result.verdict).toBe('invalid');
    expect(result.invalidReason).toBe('unsupported-input');
    expect(result.detail).toMatch(/unreadable/);
  });

  it('refuses a policy calibrated for a different reference class', async () => {
    const result = await compareAgainstReference(
      request({ policy: policy('figma-export') }),
      { provider: neverCalledProvider() },
    );
    expect(result.verdict).toBe('invalid');
    expect(result.invalidReason).toBe('unsupported-input');
    expect(result.detail).toMatch(/D-007/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consequence 7 — engine identity on EVERY result, refusals included
// ─────────────────────────────────────────────────────────────────────────────

describe('consequence 7: every result carries engine id and version', () => {
  it('stamps the engine even on refusals that never reached an engine', async () => {
    const probeAlwaysMissing: ImageProbe = () => ({ exists: false, detail: 'ENOENT' });
    const refusals: CompareResult[] = [
      await compareAgainstReference(request({ diffImagePath: '' }), {
        provider: neverCalledProvider(),
      }),
      await compareAgainstReference(request({ policy: policy('figma-export') }), {
        provider: neverCalledProvider(),
      }),
      await compareAgainstReference(request(), {
        provider: neverCalledProvider(),
        probe: probeAlwaysMissing,
      }),
      await compareAgainstReference(
        request({
          referenceImagePath: imagePath('dimension/reference'),
          actualImagePath: imagePath('dimension/wider-same-content'),
        }),
        { provider: neverCalledProvider() },
      ),
      await compareAgainstReference(request(), { provider: throwingProvider(new Error('x')) }),
      await compareAgainstReference(request({ timeoutMs: 20 }), {
        provider: {
          engine: { engine: PIXELMATCH_ENGINE_ID, engineVersion: '0.0.0-test' },
          compare: () => new Promise<ProviderComparison>(() => {}),
        },
      }),
    ];

    expect(refusals).toHaveLength(6);
    for (const result of refusals) {
      expect(result.verdict).toBe('invalid');
      expect(result.engine.engine).toBe(PIXELMATCH_ENGINE_ID);
      expect(result.engine.engineVersion).toBeTruthy();
      // A refusal with no detail is not actionable.
      expect(result.detail && result.detail.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consequence 6 — meta.json is a PARTIAL index
// ─────────────────────────────────────────────────────────────────────────────

describe('consequence 6: meta.json is reconciled, never iterated as the population', () => {
  const meta = {
    'card--default': { pixelDifference: 0, pixelDifferencePercentage: 0, isWithinThreshold: true },
    'card--hover': { pixelDifference: 120, pixelDifferencePercentage: 0.15, isWithinThreshold: false },
  };

  it('names the expected shot the index silently omitted', () => {
    const expected = ['card--default', 'card--hover', 'card--error'];
    const outcome = reconcileMetaIndex(expected, meta);

    expect(outcome.present.map((p) => p.shotId)).toEqual(['card--default', 'card--hover']);
    expect(outcome.absent).toEqual(['card--error']);
    expect(outcome.unexpected).toEqual([]);

    // The whole point: iterating the index sees two clean shots and no problem.
    expect(Object.keys(meta)).toHaveLength(2);
    expect(expected).toHaveLength(3);
  });

  it('treats a completely absent index as every shot missing, not as zero shots', () => {
    const outcome = reconcileMetaIndex(['a', 'b'], null);
    expect(outcome.absent).toEqual(['a', 'b']);
    expect(outcome.present).toEqual([]);
  });

  it('reports shots the index carries that nobody expected', () => {
    const outcome = reconcileMetaIndex(['card--default'], meta);
    expect(outcome.unexpected).toEqual(['card--hover']);
  });

  it('turns an absent shot into invalid/missing-reference, never a pass', () => {
    const result = resultForAbsentMetaShot({
      reference: reference('artifact-capture'),
      target: TARGET,
      environment: ENVIRONMENT,
      policy: policy('artifact-capture'),
      engine: { engine: PIXELMATCH_ENGINE_ID, engineVersion: '3.22.0' },
      capturedAt: '2026-08-25T00:00:00.000Z',
      shotId: 'card--error',
    });
    expect(result.verdict).toBe('invalid');
    expect(result.invalidReason).toBe(META_ABSENT_INVALID_REASON);
    expect(META_ABSENT_INVALID_REASON).toBe('missing-reference');
    expect(result.detail).toMatch(/does not mean the shot compared cleanly/);
    expect(result.counts).toBeUndefined();
  });

  it('requires an explicit denominator, because meta.json carries no dimensions', () => {
    const counts = metaEntryToCounts(meta['card--hover'], PIXELS_TOTAL);
    expect(counts).toEqual({
      pixelDifference: 120,
      pixelsTotal: PIXELS_TOTAL,
      engineReportedWithinThreshold: false,
    });
    // The engine's percentage is not the ratio and is never used as one.
    expect(counts.pixelDifference / counts.pixelsTotal).not.toBeCloseTo(0.15, 6);
  });

  it('parses the exact three-field shape lost-pixel writes', () => {
    const parsed = parseMetaIndex(JSON.stringify(meta));
    expect(Object.keys(parsed)).toEqual(['card--default', 'card--hover']);
    expect(parsed['card--hover']?.pixelDifference).toBe(120);
  });

  it('refuses malformed metadata rather than inventing zeroes', () => {
    expect(() => parseMetaIndex('not json')).toThrow(MetaIndexError);
    expect(() => parseMetaIndex('[]')).toThrow(/keyed by shot id/);
    expect(() => parseMetaIndex('{"a": 3}')).toThrow(/is not an object/);
    expect(() => parseMetaIndex('{"a": {"pixelDifference": "many"}}')).toThrow(/non-numeric/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-002 boundary — no pixel implementation, and no devDependency in production
// ─────────────────────────────────────────────────────────────────────────────

describe('D-002: the adapter implements no image comparison', () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));

  for (const file of ['provider.ts', 'png-header.ts']) {
    it(`${file} imports no image library`, () => {
      const source = readFileSync(path.join(sourceDir, file), 'utf8');
      // pngjs and pixelmatch are operator-core devDependencies for the P-002
      // corpus. Production code importing one would both break a real install
      // and mean Papercusp had started decoding pixels itself.
      expect(source).not.toMatch(/from ['"]pngjs['"]/);
      expect(source).not.toMatch(/require\(['"]pngjs['"]\)/);
      expect(source).not.toMatch(/from ['"]pixelmatch['"]/);
      expect(source).not.toMatch(/require\(['"]pixelmatch['"]\)/);
      // The corpus is test-land; production code must not reach into it.
      expect(source).not.toMatch(/from ['"]\.\/corpus\//);
    });
  }

  it('the corpus images the golden tests rely on are the pinned ones', () => {
    // If the corpus drifts, the golden bands above are measuring something else.
    const digests = JSON.parse(
      readFileSync(path.join(sourceDir, 'corpus', 'digests.json'), 'utf8'),
    ) as Record<string, string>;
    for (const image of CORPUS_IMAGES) {
      expect(digests[image.key]).toBeTruthy();
    }
  });
});
