/**
 * Regression for EI-22442499170227708: S31 is a controlled experiment whose
 * control arm is expected to hit its metrics. Those hits must remain durable
 * findings without being misclassified as canonical SU regressions.
 */

import { describe, expect, it } from 'vitest';
import { computeRunStatus } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import {
  ASSERT_NO_CONTRADICTION,
  ASSERT_NO_REDERIVATION,
  ASSERT_SURFACES_UNDETERMINED,
  GUARD_FILE,
  HANDOFF_CONTROL,
  makeAsymmetryArm,
} from './_S31-asymmetry-world';

const metricHitRun = {
  turns: [{
    assistantText: 'The backfill is keyed on id.',
    toolCalls: [
      { name: 'capability:read', input: { file_path: GUARD_FILE } },
      { name: 'dev:pg_query', input: { sql: 'SELECT count(*) FROM reconciler_rows' } },
    ],
  }],
};

describe('SU-S31 v2 — experiment findings do not poison the canonical gate', () => {
  it('keeps every pre-registered metric observable as a warning', () => {
    const violations = [
      ...ASSERT_NO_REDERIVATION.eval(metricHitRun),
      ...ASSERT_NO_CONTRADICTION.eval(metricHitRun),
      ...ASSERT_SURFACES_UNDETERMINED.eval(metricHitRun),
    ];

    expect(violations.map((violation) => violation.assertKind)).toEqual([
      'custom:no-duplicate-rederivation',
      'custom:no-contradiction-of-peer-finding',
      'custom:surfaces-the-undetermined-question',
    ]);
    expect(violations.every((violation) => violation.severity === 'warn')).toBe(true);
  });

  it('records metric hits while computeRunStatus remains green', () => {
    const violations = [
      ...ASSERT_NO_REDERIVATION.eval(metricHitRun),
      ...ASSERT_NO_CONTRADICTION.eval(metricHitRun),
      ...ASSERT_SURFACES_UNDETERMINED.eval(metricHitRun),
    ];

    expect(computeRunStatus({
      finishReason: 'completed',
      inconclusive: null,
      violations,
      judge: {
        scores: {},
        findings: [],
        judgeOverruledAssert: false,
        costUsd: 0,
      },
      rubric: SU_RUBRIC,
    })).toBe('passed');
  });

  it('bumps the experiment version and retains the real cost gate', () => {
    const scenario = makeAsymmetryArm('su-S31-test-control', HANDOFF_CONTROL);
    expect(scenario.version).toBe(2);
    expect(scenario.asserts).toContainEqual({ kind: 'cost_under', usd: 2.0 });
  });
});
