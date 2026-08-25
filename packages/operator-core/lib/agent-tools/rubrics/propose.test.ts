import { describe, expect, it } from 'vitest';
import { rubricsProposeArgs } from './propose';

const base = {
  rubricRef: 'release-readiness',
  characteristic: 'release-health',
  title: 'Release health',
  criteria: [{ key: 'tests', title: 'Required tests pass' }],
};

describe('rubrics:propose args — releaseGating kind contract', () => {
  it('rejects rubric refs that the canonical plan lock cannot store', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      rubricRef: 'acceptance:mcp-proxy-reconnect-herd-2026-08-25',
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['rubricRef'],
            message: expect.stringContaining('valid plan slug'),
          }),
        ]),
      );
    }
  });

  it('rejects releaseGating for acceptance-kind rubrics at dispatch validation', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      releaseGating: true,
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['releaseGating'],
            message: expect.stringContaining('standard-kind only'),
          }),
        ]),
      );
    }
  });

  it('accepts releaseGating for a standard-kind rubric', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'standard',
      releaseGating: true,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts an explicitly non-gating acceptance rubric', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      releaseGating: false,
    });

    expect(parsed.success).toBe(true);
  });
});
