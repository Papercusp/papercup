import { describe, expect, it } from 'vitest';

import {
  COMPARE_RESULT_SCHEMA_VERSION,
  type CaptureEnvironment,
  type CompareResult,
  type EvidenceExpectation,
  type ThresholdPolicy,
  computeVerdict,
  environmentsMatch,
  evaluateGate,
  isEvidenceCurrent,
} from './contract';

const env = (over: Partial<CaptureEnvironment> = {}): CaptureEnvironment => ({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  browser: 'chromium',
  theme: 'light',
  fontSet: 'inter-v4',
  ...over,
});

const gateablePolicy = (over: Partial<ThresholdPolicy> = {}): ThresholdPolicy => ({
  policyVersion: 'fidelity-v1',
  referenceClass: 'artifact-capture',
  eligibility: 'gateable',
  maxDiffRatio: 0.01,
  derivedFrom: 'calibration-run-1',
  ...over,
});

const result = (over: Partial<CompareResult> = {}): CompareResult => ({
  schemaVersion: COMPARE_RESULT_SCHEMA_VERSION,
  verdict: 'pass',
  reference: {
    referenceId: 'ref-a',
    revision: 3,
    referenceClass: 'artifact-capture',
    contentSha256: 'a'.repeat(64),
  },
  target: {
    targetId: 'story--primary',
    targetKind: 'storybook-story',
    implementationRevision: 'impl-77',
  },
  environment: env(),
  engine: { engine: 'lost-pixel/odiff', engineVersion: '3.22.0' },
  policy: gateablePolicy(),
  counts: { pixelDifference: 0, pixelsTotal: 1_000_000 },
  diffRatio: 0,
  capturedAt: '2026-08-25T00:00:00.000Z',
  ...over,
});

const expectation = (over: Partial<EvidenceExpectation> = {}): EvidenceExpectation => ({
  referenceId: 'ref-a',
  referenceRevision: 3,
  implementationRevision: 'impl-77',
  engineVersion: '3.22.0',
  policyVersion: 'fidelity-v1',
  environment: env(),
  ...over,
});

describe('computeVerdict', () => {
  it('passes when the diff ratio is within the policy', () => {
    const out = computeVerdict({
      counts: { pixelDifference: 5_000, pixelsTotal: 1_000_000 },
      policy: gateablePolicy({ maxDiffRatio: 0.01 }),
    });
    expect(out.verdict).toBe('pass');
    expect(out.diffRatio).toBeCloseTo(0.005, 10);
  });

  it('treats the threshold as inclusive at exactly the boundary', () => {
    const out = computeVerdict({
      counts: { pixelDifference: 10_000, pixelsTotal: 1_000_000 },
      policy: gateablePolicy({ maxDiffRatio: 0.01 }),
    });
    expect(out.verdict).toBe('pass');
  });

  it('fails one pixel past the boundary, and says by how much', () => {
    const out = computeVerdict({
      counts: { pixelDifference: 10_001, pixelsTotal: 1_000_000 },
      policy: gateablePolicy({ maxDiffRatio: 0.01 }),
    });
    expect(out.verdict).toBe('fail');
    expect(out.detail).toContain('exceeds');
  });

  /**
   * D-008 regression control. The installed lost-pixel pixelmatch path returns
   * isWithinThreshold:true unconditionally when no difference-image path is
   * supplied — it fails OPEN. If this module ever starts consulting that field,
   * this case flips to 'pass' and the gate silently begins approving completely
   * different images.
   */
  it('ignores the engine-reported boolean even when it fails open', () => {
    const out = computeVerdict({
      counts: {
        pixelDifference: 900_000,
        pixelsTotal: 1_000_000,
        engineReportedWithinThreshold: true,
      },
      policy: gateablePolicy({ maxDiffRatio: 0.01 }),
    });
    expect(out.verdict).toBe('fail');
    expect(out.diffRatio).toBeCloseTo(0.9, 10);
  });

  /** Calibration: the control above must not pass merely because everything fails. */
  it('still honours the engine boolean being absent on a genuine pass', () => {
    const out = computeVerdict({
      counts: { pixelDifference: 0, pixelsTotal: 1_000_000 },
      policy: gateablePolicy(),
    });
    expect(out.verdict).toBe('pass');
  });

  it('refuses to gate an advisory-only reference class (D-007)', () => {
    const out = computeVerdict({
      counts: { pixelDifference: 400_000, pixelsTotal: 1_000_000 },
      policy: gateablePolicy({
        referenceClass: 'raster-mockup',
        eligibility: 'advisory-only',
      }),
    });
    expect(out.verdict).toBe('invalid');
    expect(out.invalidReason).toBe('ungateable-reference-class');
    expect(out.detail).toContain('derived');
  });

  it('does not let an advisory-only class pass by having a tiny diff either', () => {
    const out = computeVerdict({
      counts: { pixelDifference: 1, pixelsTotal: 1_000_000 },
      policy: gateablePolicy({
        referenceClass: 'raster-mockup',
        eligibility: 'advisory-only',
      }),
    });
    expect(out.verdict).toBe('invalid');
  });

  it.each([
    ['zero total', { pixelDifference: 0, pixelsTotal: 0 }],
    ['negative total', { pixelDifference: 0, pixelsTotal: -1 }],
    ['negative difference', { pixelDifference: -5, pixelsTotal: 100 }],
    ['NaN difference', { pixelDifference: Number.NaN, pixelsTotal: 100 }],
  ])('reports invalid rather than passing on %s', (_label, counts) => {
    const out = computeVerdict({ counts, policy: gateablePolicy() });
    expect(out.verdict).toBe('invalid');
    expect(out.invalidReason).toBe('engine-error');
  });

  it.each([-0.1, 1.5, Number.NaN])(
    'reports invalid for an out-of-range policy threshold (%s)',
    (maxDiffRatio) => {
      const out = computeVerdict({
        counts: { pixelDifference: 0, pixelsTotal: 100 },
        policy: gateablePolicy({ maxDiffRatio }),
      });
      expect(out.verdict).toBe('invalid');
      expect(out.invalidReason).toBe('unsupported-input');
    },
  );
});

describe('environmentsMatch', () => {
  it('matches an identical environment', () => {
    expect(environmentsMatch(env(), env())).toBe(true);
  });

  it('treats an absent optional field and an explicit undefined as the same', () => {
    expect(environmentsMatch(env(), env({ fixture: undefined }))).toBe(true);
  });

  it.each([
    ['viewport width', env({ viewport: { width: 1281, height: 800 } })],
    ['viewport height', env({ viewport: { width: 1280, height: 801 } })],
    ['device scale factor', env({ deviceScaleFactor: 1 })],
    ['browser', env({ browser: 'firefox' })],
    ['theme', env({ theme: 'dark' })],
    ['font set', env({ fontSet: 'inter-v5' })],
    ['fixture', env({ fixture: 'empty-state' })],
    ['state', env({ state: 'hover' })],
  ])('does not match on a differing %s', (_label, other) => {
    expect(environmentsMatch(env(), other)).toBe(false);
  });
});

describe('isEvidenceCurrent', () => {
  it('accepts evidence matching every dimension', () => {
    expect(isEvidenceCurrent(result(), expectation()).current).toBe(true);
  });

  it('rejects evidence bound to a superseded reference revision', () => {
    const out = isEvidenceCurrent(result(), expectation({ referenceRevision: 4 }));
    expect(out.current).toBe(false);
    expect(out.mismatches.join(' ')).toContain('reference revision');
  });

  it('rejects evidence captured from a different implementation revision', () => {
    const out = isEvidenceCurrent(result(), expectation({ implementationRevision: 'impl-78' }));
    expect(out.current).toBe(false);
    expect(out.mismatches.join(' ')).toContain('implementation revision');
  });

  it('rejects evidence produced by a different engine version', () => {
    const out = isEvidenceCurrent(result(), expectation({ engineVersion: '3.23.0' }));
    expect(out.current).toBe(false);
    expect(out.mismatches.join(' ')).toContain('engine version');
  });

  it('rejects evidence graded under a superseded policy version', () => {
    const out = isEvidenceCurrent(result(), expectation({ policyVersion: 'fidelity-v2' }));
    expect(out.current).toBe(false);
    expect(out.mismatches.join(' ')).toContain('policy version');
  });

  it('rejects evidence captured at a different environment', () => {
    const out = isEvidenceCurrent(result(), expectation({ environment: env({ theme: 'dark' }) }));
    expect(out.current).toBe(false);
    expect(out.mismatches.join(' ')).toContain('capture environment');
  });

  it('reports every failing dimension at once, not just the first', () => {
    const out = isEvidenceCurrent(
      result(),
      expectation({ referenceRevision: 9, engineVersion: 'x', policyVersion: 'y' }),
    );
    expect(out.mismatches.length).toBeGreaterThanOrEqual(3);
  });
});

describe('evaluateGate', () => {
  it('refuses when no cases are declared', () => {
    const out = evaluateGate([result()], []);
    expect(out.satisfied).toBe(false);
    expect(out.refusals[0]).toContain('nothing to verify');
  });

  it('is satisfied when the single required case passes with current evidence', () => {
    expect(evaluateGate([result()], [expectation()]).satisfied).toBe(true);
  });

  it('refuses with an actionable reason when evidence is missing', () => {
    const out = evaluateGate([], [expectation()]);
    expect(out.satisfied).toBe(false);
    expect(out.refusals[0]).toContain('no comparison evidence');
  });

  it('refuses when the only evidence is stale, and names why', () => {
    const out = evaluateGate([result()], [expectation({ implementationRevision: 'impl-99' })]);
    expect(out.satisfied).toBe(false);
    expect(out.refusals[0]).toContain('stale');
    expect(out.refusals[0]).toContain('implementation revision');
  });

  it('refuses when current evidence fails', () => {
    const out = evaluateGate(
      [result({ verdict: 'fail', detail: 'diff ratio 0.4 exceeds 0.01' })],
      [expectation()],
    );
    expect(out.satisfied).toBe(false);
    expect(out.refusals[0]).toContain('exceeds');
  });

  it('refuses when current evidence is invalid rather than treating it as absent', () => {
    const out = evaluateGate(
      [result({ verdict: 'invalid', invalidReason: 'dimension-mismatch', detail: '1280x800 vs 1200x800' })],
      [expectation()],
    );
    expect(out.satisfied).toBe(false);
    expect(out.refusals[0]).toContain('dimension-mismatch');
  });

  /**
   * Requirement 9: a passing case never covers a different required case. This
   * is the mask-shaped bypass — satisfy one viewport, claim the set.
   */
  it('does not let one passing viewport satisfy another required viewport', () => {
    const wide = env({ viewport: { width: 1600, height: 900 } });
    const out = evaluateGate(
      [result()],
      [expectation(), expectation({ environment: wide })],
    );
    expect(out.satisfied).toBe(false);
    expect(out.refusals).toHaveLength(1);
    expect(out.refusals[0]).toContain('1600x900');
  });

  it('is satisfied only once every required case has its own passing evidence', () => {
    const wide = env({ viewport: { width: 1600, height: 900 } });
    const out = evaluateGate(
      [result(), result({ environment: wide })],
      [expectation(), expectation({ environment: wide })],
    );
    expect(out.satisfied).toBe(true);
  });

  it('accepts a case when at least one current passing result exists alongside a failing one', () => {
    const out = evaluateGate(
      [result({ verdict: 'fail' }), result()],
      [expectation()],
    );
    expect(out.satisfied).toBe(true);
  });
});

/**
 * Falsifiability control for the D-008 hazard, kept permanently in the test file
 * rather than proved once by mutating the tree (repo rule: for a module you
 * import, the control lives here). `trustingVerdict` is the implementation this
 * module must NEVER become — the one that believes the engine's fail-open
 * boolean. The first case proves the control is wired to something that can
 * actually fail; the second proves the real implementation does not do it.
 */
function trustingVerdict(counts: {
  pixelDifference: number;
  pixelsTotal: number;
  engineReportedWithinThreshold?: boolean;
}): 'pass' | 'fail' {
  return counts.engineReportedWithinThreshold ? 'pass' : 'fail';
}

describe('engine-boolean trust (falsifiability control)', () => {
  const failOpenCounts = {
    pixelDifference: 900_000,
    pixelsTotal: 1_000_000,
    engineReportedWithinThreshold: true,
  };

  it('the wrong implementation would pass a completely different image', () => {
    expect(trustingVerdict(failOpenCounts)).toBe('pass');
  });

  it('the real implementation fails it', () => {
    expect(computeVerdict({ counts: failOpenCounts, policy: gateablePolicy() }).verdict).toBe(
      'fail',
    );
  });
});

describe('schema version', () => {
  it('is pinned so stored evidence can be migrated deliberately', () => {
    expect(COMPARE_RESULT_SCHEMA_VERSION).toBe(1);
    expect(result().schemaVersion).toBe(COMPARE_RESULT_SCHEMA_VERSION);
  });
});
