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
  BACKFILL_FILE,
  GUARD_FILE,
  HANDOFF_CONTROL,
  ROW_SCHEMA_FILE,
  makeAsymmetryArm,
  makeAsymmetryWorld,
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

function text(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result)) throw new Error('unexpected result');
  return (result as { content: Array<{ text?: string }> }).content.map((part) => part.text ?? '').join('\n');
}

describe('SU-S31 v3 — executable hermetic world and non-gating experiment metrics', () => {
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
    expect(scenario.version).toBe(3);
    expect(scenario.asserts).toContainEqual({ kind: 'cost_under', usd: 2.0 });
  });

  it('exposes the row schema and runnable backfill through both direct read and repomix', async () => {
    const world = makeAsymmetryWorld(HANDOFF_CONTROL);
    const schema = text(await world.override('capability:read', { file_path: ROW_SCHEMA_FILE }));
    const backfill = text(await world.override('capability:read', { file_path: BACKFILL_FILE }));
    const packed = text(await world.override('repomix:pack', { path: 'packages/operator-core/lib/reconciler' }));

    expect(schema).toMatch(/harness_shared\.reconciler_rows/);
    expect(backfill).toMatch(/PARTITION BY harness, external_id/);
    expect(packed).toContain(GUARD_FILE);
    expect(packed).toContain(ROW_SCHEMA_FILE);
    expect(packed).toContain(BACKFILL_FILE);
  });

  it('makes the historical uncertainty explicit on both SQL and log paths', async () => {
    const world = makeAsymmetryWorld(HANDOFF_CONTROL);
    const sql = JSON.parse(text(await world.override('dev:pg_query', {
      sql: "SELECT * FROM audit WHERE ts < '2026-07-01' AND actor='reconciler'",
    })));
    const logs = JSON.parse(text(await world.override('logs:read', {
      unit: 'papercup-reconciler',
      since: '2026-06-01',
      until: '2026-07-01',
    })));

    expect(sql).toMatchObject({ rowCount: 0, absence: { status: 'verified' } });
    expect(sql.note).toMatch(/archived log bundles/);
    expect(logs.archiveRef).toMatch(/^backup:\/\/logs\//);
    expect(logs.note).toMatch(/pre-2026-07-01/);
  });
});
