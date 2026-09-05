import { describe, expect, it } from 'vitest';
import proposeTool, { rubricsProposeArgs } from './propose';

const base = {
  rubricRef: 'release-readiness',
  characteristic: 'release-health',
  title: 'Release health',
  criteria: [
    {
      key: 'tests',
      title: 'Required tests pass',
      model: 'The required tests pass.',
      method: 'Run the focused test suite and inspect its result.',
      driftMarkers: 'Any required test fails or cannot be run.',
    },
  ],
};

const lightAcceptanceCriterion = {
  key: 'tests',
  title: 'Required tests pass for the shipped behavior',
  driftMarkers: 'A required test fails or the shipped behavior is absent.',
  check: { kind: 'instrument', instrumentKey: 'none' },
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
      criteria: [lightAcceptanceCriterion],
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
      criteria: [lightAcceptanceCriterion],
      releaseGating: false,
    });

    expect(parsed.success).toBe(true);
  });

  it('accepts a goal-linked acceptance rubric', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectGoal: 'goal-123',
      criteria: [lightAcceptanceCriterion],
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

  it('accepts unpinned standard-rubric composition refs and rejects revision-shaped refs', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      composes: [' goal-mode-e2e ', 'pot-coordination-health'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.composes).toEqual(['goal-mode-e2e', 'pot-coordination-health']);

    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        composes: [{ rubricRef: 'goal-mode-e2e', revision: 37 }],
      }).success,
    ).toBe(false);
    expect(rubricsProposeArgs.safeParse({ ...base, composes: [] }).success).toBe(false);
  });

  it('accepts the light acceptance profile only with a falsifier and structured check', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [lightAcceptanceCriterion],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.criteria[0]?.model).toBeUndefined();
      expect(parsed.data.criteria[0]?.method).toBeUndefined();
      expect(parsed.data.criteria[0]?.driftMarkers).toBeTruthy();
      expect(parsed.data.criteria[0]?.check).toEqual({ kind: 'instrument', instrumentKey: 'none' });
    }
  });

  it('accepts canonical BAR metadata and keeps model as the single semantic text', () => {
    const parsed = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [
        {
          ...lightAcceptanceCriterion,
          bar: 'The shipped behavior exists for every post-epoch plan.',
          barKey: 'R-1',
          role: 'outcome',
          mandatory: true,
          requiredScope: ['cohort:post-epoch'],
          evidencePlane: 'tree',
          passRatings: ['pass'],
          barProvenance: {
            lifecycle: 'pre-implementation',
            declaredAt: '2026-09-04T12:00:00.000Z',
            declaredBy: 'su-author',
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.criteria[0]).toMatchObject({
        bar: 'The shipped behavior exists for every post-epoch plan.',
        barKey: 'R-1',
        role: 'outcome',
        mandatory: true,
        evidencePlane: 'tree',
      });
    }

    expect(rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [{ ...lightAcceptanceCriterion, evidencePlane: 'production-ish' }],
    }).success).toBe(false);

    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        kind: 'acceptance',
        subjectPlan: 'release-plan',
        criteria: [
          {
            ...lightAcceptanceCriterion,
            model: 'Canonical outcome.',
            bar: 'A different outcome.',
            role: 'outcome',
            mandatory: true,
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      rubricsProposeArgs.safeParse({
        ...base,
        criteria: [{ ...base.criteria[0], barKey: 'R-1', role: 'outcome' }],
      }).success,
    ).toBe(false);
  });

  it('rejects acceptance criteria that omit the meta-rubric falsifier or structured-check floor', () => {
    const missingFalsifier = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [{ ...lightAcceptanceCriterion, driftMarkers: undefined }],
    });
    expect(missingFalsifier.success).toBe(false);
    if (!missingFalsifier.success) {
      expect(missingFalsifier.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'driftMarkers'],
            message: expect.stringContaining('requires non-empty driftMarkers'),
          }),
        ]),
      );
    }

    const missingCheck = rubricsProposeArgs.safeParse({
      ...base,
      kind: 'acceptance',
      subjectPlan: 'release-plan',
      criteria: [{ ...lightAcceptanceCriterion, check: undefined }],
    });
    expect(missingCheck.success).toBe(false);
    if (!missingCheck.success) {
      expect(missingCheck.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria'],
            message: expect.stringContaining('require at least one structured check'),
          }),
        ]),
      );
    }
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
    expect(proposeTool.description).toMatch(/acceptance criteria may omit model\/method/i);
    expect(proposeTool.description).toMatch(/non-empty driftMarkers falsifier/i);
    expect(proposeTool.description).toMatch(/at least one structured check/i);
    expect(proposeTool.guidance?.when).toMatch(/stored structured check/i);
    expect(proposeTool.guidance?.when).toMatch(/acceptance criteria are a light profile/i);
    expect(proposeTool.guidance?.when).toMatch(/traceability to the plan goal\/Decisions/i);
    expect(proposeTool.guidance?.chaining).toMatch(/structured check/i);
  });
});
