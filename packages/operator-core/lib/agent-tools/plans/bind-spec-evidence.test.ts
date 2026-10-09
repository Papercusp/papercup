import { describe, expect, it } from 'vitest';
import { asCommittedRunOf, bindingSchema, measureBindingForStore } from './bind-spec-evidence';

const measuredBinding = {
  workItemId: 'WI-1',
  specId: 'SPEC-001-01',
  evidenceKind: 'test' as const,
  evidenceRef: 'test/reconnect.test.ts',
  measurement: {
    schemaVersion: 1 as const,
    kind: 'repo-files' as const,
    sourcePaths: ['src/reconnect.ts'],
    testPaths: ['test/reconnect.test.ts'],
  },
};

describe('plans:bind-spec-evidence repo-files measurement contract', () => {
  it('accepts a workspace-registered sibling harness slug without accepting an arbitrary root path', () => {
    expect(
      bindingSchema.safeParse({
        ...measuredBinding,
        measurement: { ...measuredBinding.measurement, rootHarnessSlug: 'portal' },
      }).success,
    ).toBe(true);
    expect(
      bindingSchema.safeParse({
        ...measuredBinding,
        measurement: { ...measuredBinding.measurement, rootPath: '/tmp/unregistered' },
      }).success,
    ).toBe(false);
  });

  it('accepts omitted or explicit-null opaque fingerprint dimensions', () => {
    expect(bindingSchema.safeParse(measuredBinding).success).toBe(true);
    expect(
      bindingSchema.safeParse({
        ...measuredBinding,
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
      }).success,
    ).toBe(true);
  });

  it('accepts fixture measurement paths and requires them for repository-measured fixture calibration', () => {
    const fixtureBinding = {
      ...measuredBinding,
      evidenceKind: 'fixture' as const,
      details: { adequacy: { fixtureCalibrated: true } },
    };
    expect(bindingSchema.safeParse({
      ...fixtureBinding,
      measurement: { ...measuredBinding.measurement, fixturePaths: ['src/server-envelope.ts'] },
    }).success).toBe(true);
    expect(bindingSchema.safeParse({
      ...fixtureBinding,
      measurement: { ...measuredBinding.measurement, fixtureGlobs: ['libs/db/sql/*.sql'], fixtureRootHarnessSlug: 'fixtures' },
    }).success).toBe(true);

    const missingFixturePaths = bindingSchema.safeParse(fixtureBinding);
    expect(missingFixturePaths.success).toBe(false);
    if (missingFixturePaths.success) return;
    expect(missingFixturePaths.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['measurement', 'fixturePaths'],
          message: expect.stringContaining('requires repo-files measurement.fixturePaths'),
        }),
      ]),
    );
  });

  it.each(['fixtureFingerprint', 'rubricFingerprint', 'environmentFingerprint'] as const)(
    'rejects an unmeasurable non-null %s instead of persisting an unreachable freshness tuple',
    (field) => {
      const parsed = bindingSchema.safeParse({ ...measuredBinding, [field]: `${field}:opaque` });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [field],
            message: expect.stringContaining(`cannot independently refresh ${field}`),
          }),
        ]),
      );
    },
  );
});

describe('plans:bind-spec-evidence adequacy completeness metadata', () => {
  const flatAdequacyFields: ReadonlyArray<readonly [string, unknown]> = [
    ['fixtureCalibrated', true],
    ['fixtureFree', true],
    ['falsifiable', true],
    ['testLayer', 'integration'],
    ['testCases', ['suite > case']],
    ['pathReachable', true],
    ['oracleIndependent', true],
    ['collected', true],
    ['skipped', false],
    ['executed', true],
    ['outcome', 'passed'],
    ['targeted', true],
    ['coverageRungs', { l3: true }],
    ['scenarioIds', ['stale-vs-decision']],
    ['causalPairIds', ['missing-goal-history']],
    ['provisionalProofBase', true],
  ];

  it.each(flatAdequacyFields)(
    'rejects flat adequacy field %s with the correct details.adequacy path',
    (field, value) => {
      const parsed = bindingSchema.safeParse({
        ...measuredBinding,
        details: { [field]: value },
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['details', field],
            message: expect.stringContaining(`details.adequacy.${field}`),
          }),
        ]),
      );
    },
  );

  it.each(flatAdequacyFields)(
    'rejects flat adequacy field %s even when details.adequacy is present',
    (field, value) => {
      const parsed = bindingSchema.safeParse({
        ...measuredBinding,
        details: { adequacy: { executed: true }, [field]: value },
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['details', field],
            message: expect.stringContaining(`details.adequacy.${field}`),
          }),
        ]),
      );
    },
  );

  it('continues to accept unrelated free-form details without an adequacy container', () => {
    expect(
      bindingSchema.safeParse({
        ...measuredBinding,
        details: { observations: { source: 'independent-run' } },
      }).success,
    ).toBe(true);
  });

  it('accepts stable scenario and causal-pair ids on executable proof', () => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: {
        adequacy: {
          coverageRungs: { l3: true, l4: false },
          scenarioIds: ['stale-vs-decision', 'wrong-subject-exclusion'],
          causalPairIds: ['missing-goal-history'],
          executed: true,
        },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('requires adequacy.testCases to be a list of nonblank case titles', () => {
    expect(bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { testCases: ['suite > selected case'] } },
    }).success).toBe(true);

    for (const value of ['selected case', [42], ['   ']]) {
      expect(bindingSchema.safeParse({
        ...measuredBinding,
        details: { adequacy: { testCases: value } },
      }).success).toBe(false);
    }
  });

  it('accepts an uppercase platform-generated clause ID as targeted adequacy metadata', () => {
    const specId = 'AUTO-BAR-R-5-P-004';
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      specId,
      evidenceKind: 'mutation',
      details: { adequacy: { targeted: specId } },
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    'fixtureCalibrated',
    'fixtureFree',
    'falsifiable',
    'pathReachable',
    'oracleIndependent',
    'collected',
    'skipped',
    'executed',
    'provisionalProofBase',
  ])('rejects numeric nested adequacy metadata for %s', (field) => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { [field]: 13 } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['details', 'adequacy', field],
          message: expect.stringMatching(/boolean/i),
        }),
      ]),
    );
  });

  it.each([
    { value: ['l3'], message: 'expected object' },
    { value: { l3: 'true' }, message: 'expected boolean' },
    { value: { l5: true }, message: 'unrecognized key' },
  ])('rejects malformed coverageRungs metadata ($message)', ({ value, message }) => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { coverageRungs: value } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^details\.adequacy\.coverageRungs(?:\.|$)/)]),
    );
    expect(parsed.error.issues.map((issue) => issue.message).join(' ')).toMatch(new RegExp(message, 'i'));
  });

  it.each([
    { field: 'scenarioIds', value: ['valid-id', 'valid-id'], message: 'unique' },
    { field: 'scenarioIds', value: ['Not Stable'], message: 'Invalid' },
    { field: 'scenarioIds', value: ['su-S01-harness-scope'], message: 'Invalid' },
    { field: 'causalPairIds', value: [], message: 'too small' },
  ])('rejects malformed or duplicate $field metadata', ({ field, value, message }) => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: { adequacy: { [field]: value } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^details\\.adequacy\\.${field}(?:\\.|$)`))]),
    );
    expect(parsed.error.issues.map((issue) => issue.message).join(' ')).toMatch(new RegExp(message, 'i'));
  });

  it('rejects causal-pair ids on non-executable fixture evidence', () => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      evidenceKind: 'fixture',
      details: { adequacy: { causalPairIds: ['missing-goal-history'] } },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: ['details', 'adequacy', 'causalPairIds'],
          message: expect.stringContaining('require executable'),
        }),
      ]),
    );
  });
});

describe('plans:bind-spec-evidence authenticated actor provenance', () => {
  const publicBinding = (evidenceRef: string) => ({
    workItemId: 'WI-1',
    specId: 'SPEC-001-01',
    evidenceKind: 'test' as const,
    evidenceRef,
    sourceFingerprint: 'git:abc123',
  });

  it('accepts a valid two-row public payload without a caller-supplied actorId', async () => {
    const { default: tool } = await import('./bind-spec-evidence');
    const parsed = tool.args.safeParse({
      slug: 'reconnect-plan',
      items: [publicBinding('test/reconnect-a.test.ts'), publicBinding('test/reconnect-b.test.ts')],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects actorId at the public boundary because the handler derives it from identity', async () => {
    const { default: tool } = await import('./bind-spec-evidence');
    const parsed = tool.args.safeParse({
      slug: 'reconnect-plan',
      items: [publicBinding('test/reconnect-a.test.ts'), publicBinding('test/reconnect-b.test.ts')],
      actorId: 'caller-controlled-actor',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keys: ['actorId'],
          message: expect.stringContaining('Unrecognized key'),
        }),
      ]),
    );
  });

  it('rejects actorId nested in a binding, keeping the internal store field private', async () => {
    const { default: tool } = await import('./bind-spec-evidence');
    const parsed = tool.args.safeParse({
      slug: 'reconnect-plan',
      binding: { ...publicBinding('test/reconnect.test.ts'), actorId: 'caller-controlled-actor' },
    });
    expect(parsed.success).toBe(false);
  });
});

// proof-freshness-pinned-candidate-2026-10-06 P-003 / D-001 (b): a binding derived from a clean
// run in a disposable clone is measured at the commit that ran, never at the live checkout.
describe('as-committed bindings are measured at the run commit', () => {
  const repoFiles = { schemaVersion: 1 as const, kind: 'repo-files' as const, sourcePaths: ['src/a.ts'] };
  const fakes = () => {
    const calls: string[] = [];
    const result = { sourceFingerprint: 's', testFingerprint: null, pin: null };
    return {
      calls,
      deps: {
        atCommit: (async (_w: string, _h: string, _m: unknown, at: { commitSha: string }) => {
          calls.push(`atCommit:${at.commitSha}`);
          return result;
        }) as never,
        live: (async () => {
          calls.push('live');
          return result;
        }) as never,
      },
    };
  };

  it('reads the commit stamped by bind-from-test-run, and nothing from an ordinary binding', () => {
    // The exact shape expandTestRunBinding writes (bind-from-test-run.test.ts pins that side).
    expect(asCommittedRunOf({ testRun: { asCommitted: { commitSha: 'abc123', repoPrefix: 'libs/sub', measuredAtCommit: true } } }))
      .toEqual({ commitSha: 'abc123', repoPrefix: 'libs/sub' });
    expect(asCommittedRunOf({ testRun: { asCommitted: { commitSha: 'abc123', repoPrefix: '' } } }))
      .toEqual({ commitSha: 'abc123', repoPrefix: '' });
    expect(asCommittedRunOf({ testRun: { commitSha: 'abc123', worktreeDirty: false } })).toBeUndefined();
    expect(asCommittedRunOf({ testRun: { asCommitted: { commitSha: 42 } } })).toBeUndefined();
    expect(asCommittedRunOf(undefined)).toBeUndefined();
  });

  it('routes a repo-files binding with a run commit to the at-commit measurer, and every other binding to the live one', async () => {
    const f = fakes();
    await measureBindingForStore('w', 'h', repoFiles, { commitSha: 'abc123', repoPrefix: null }, f.deps);
    await measureBindingForStore('w', 'h', repoFiles, undefined, f.deps);
    await measureBindingForStore(
      'w',
      'h',
      { schemaVersion: 1, kind: 'work-items', workItemIds: ['WI-1'] } as never,
      { commitSha: 'abc123', repoPrefix: null },
      f.deps,
    );
    expect(f.calls).toEqual(['atCommit:abc123', 'live', 'live']);
  });
});
