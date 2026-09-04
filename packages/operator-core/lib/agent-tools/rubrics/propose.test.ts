import { describe, expect, it } from 'vitest';
import proposeTool, { rubricsProposeArgs } from './propose';

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

  it('accepts a goal-linked acceptance rubric', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectGoal: 'goal-123',
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts methodRef:null emitted by rubrics:get for an unset runbook', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      methodRef: null,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.methodRef).toBeNull();
  });

  it('documents the acknowledgement needed when a revision removes a stored structured check', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      allowMethodShrink: true,
      shrinkReason: 'the deterministic check is intentionally retired with its test suite',
    });

    expect(parsed.success).toBe(true);
    expect(proposeTool.description).toMatch(/removing a stored structured check/i);
    expect(proposeTool.description).toMatch(/allowMethodShrink \+ shrinkReason/);
    expect(proposeTool.guidance?.when).toMatch(/stored structured check/i);
    expect(proposeTool.guidance?.chaining).toMatch(/structured check/i);
  });
});
