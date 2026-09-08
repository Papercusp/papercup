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
  it('accepts stable scenario and causal-pair ids on executable proof', () => {
    const parsed = bindingSchema.safeParse({
      ...measuredBinding,
      details: {
        adequacy: {
          scenarioIds: ['stale-vs-decision', 'wrong-subject-exclusion'],
          causalPairIds: ['missing-goal-history'],
          executed: true,
        },
      },
    });
    expect(parsed.success).toBe(true);
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
