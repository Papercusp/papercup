import { describe, expect, it } from 'vitest';
import { bindingSchema } from './bind-spec-evidence';

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
    ['falsifiable', true],
    ['testLayer', 'integration'],
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
