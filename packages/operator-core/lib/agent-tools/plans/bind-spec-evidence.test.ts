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
