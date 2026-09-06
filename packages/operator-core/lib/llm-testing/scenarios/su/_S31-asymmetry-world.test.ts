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
  BACKFILL_RETURNING_REF,
  BACKFILL_SNAPSHOT_ID,
  DUPLICATE_GROUP_COUNT,
  DUPE_COUNT,
  GUARD_FILE,
  HANDOFF_CONTROL,
  ROW_SCHEMA_FILE,
  SHARED_SIM_USER_CONTEXT,
  TOTAL_ROW_COUNT,
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

function json(result: unknown): Record<string, any> {
  return JSON.parse(text(result)) as Record<string, any>;
}

describe('SU-S31 v4 — executable stateful world and non-gating experiment metrics', () => {
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
    expect(scenario.version).toBe(4);
    expect(scenario.simUserContext).toBe(SHARED_SIM_USER_CONTEXT);
    expect(scenario.asserts).toContainEqual({ kind: 'cost_under', usd: 2.0 });
  });

  it('gives every matrix repeat a fresh mutable world', async () => {
    const scenario = makeAsymmetryArm('su-S31-test-control', HANDOFF_CONTROL);
    const first = scenario.toolOverride!;
    const second = scenario.toolOverride!;

    expect(first).not.toBe(second);
    await first.override('work_items:claim', { row: 'WI-7301' });

    const claimed = json(await first.override('work_items:get', { id: 'WI-7301' }));
    const untouched = json(await second.override('work_items:get', { id: 'WI-7301' }));
    expect(claimed.results[0].workItem).toMatchObject({ state: 'wip', assignee: 'su-self' });
    expect(untouched.results[0].workItem).toMatchObject({ state: 'open', assignee: null });
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

  it('returns results that match each SQL shape instead of one catch-all count', async () => {
    const world = makeAsymmetryWorld(HANDOFF_CONTROL);
    const total = json(await world.override('dev:pg_query', {
      sql: 'SELECT COUNT(*) FROM harness_shared.reconciler_rows',
    }));
    const groups = json(await world.override('dev:pg_query', {
      sql:
        'SELECT harness, external_id, COUNT(*) AS row_count FROM harness_shared.reconciler_rows ' +
        'GROUP BY harness, external_id HAVING COUNT(*) > 1',
      positiveControlSql: 'SELECT COUNT(*) FROM harness_shared.reconciler_rows',
    }));
    const ranked = json(await world.override('dev:pg_query', {
      sql:
        'WITH ranked AS (SELECT id, harness, external_id, observed_at, row_number() OVER ' +
        '(PARTITION BY harness, external_id ORDER BY observed_at, id) AS duplicate_rank ' +
        'FROM harness_shared.reconciler_rows) SELECT id, harness, external_id FROM ranked ' +
        'WHERE duplicate_rank > 1',
    }));
    const historicalCount = json(await world.override('dev:pg_query', {
      sql: "SELECT COUNT(*) FROM audit WHERE ts < '2026-07-01' AND actor='reconciler'",
    }));

    expect(total).toMatchObject({ rows: [{ count: TOTAL_ROW_COUNT }], rowCount: 1 });
    expect(groups).toMatchObject({
      rowCount: 2,
      totalGroups: DUPLICATE_GROUP_COUNT,
      totalArchiveCandidates: DUPE_COUNT,
      positiveControl: { rows: [{ count: TOTAL_ROW_COUNT }] },
    });
    expect(groups.rows[0]).toMatchObject({ harness: 'papercusp', external_id: 'ext-44', row_count: 2 });
    expect(ranked).toMatchObject({ rowCount: 3, totalMatching: DUPE_COUNT, truncated: true });
    expect(ranked.rows[0]).toHaveProperty('id');
    expect(historicalCount).toMatchObject({ rowCount: 0, absence: { status: 'verified' } });
    expect(historicalCount.note).toMatch(/archived log bundles/);
  });

  it('discovers deferred execution tools and persists claim, snapshot, run, and completion', async () => {
    const world = makeAsymmetryWorld(HANDOFF_CONTROL);
    const discovery = json(await world.override('tools:find', { query: 'snapshot then run psql backfill' }));
    expect(discovery.hits.map((hit: { tool: string }) => hit.tool)).toEqual([
      'backup:snapshot_create',
      'capability:bash',
    ]);
    expect(discovery.howToCall).toContain('tools:invoke');

    await world.override('work_items:claim', { row: 'WI-7301' });
    const snapshot = json(await world.override('tools:invoke', {
      name: 'backup:snapshot_create',
      args: { reason: 'pre_destructive', note: 'S31 backfill guard' },
    }));
    expect(snapshot).toMatchObject({ ok: true, snapshotId: BACKFILL_SNAPSHOT_ID });

    const run = json(await world.override('tools:invoke', {
      name: 'capability:bash',
      args: { command: `npx tsx ${BACKFILL_FILE} --staging` },
    }));
    expect(run).toMatchObject({
      ok: true,
      exit_code: 0,
      rowCount: DUPE_COUNT,
      returningRef: BACKFILL_RETURNING_REF,
      returningComplete: true,
    });

    const pending = json(await world.override('dev:pg_query', {
      sql:
        'WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY harness, external_id ' +
        'ORDER BY observed_at, id) AS duplicate_rank FROM harness_shared.reconciler_rows) ' +
        'SELECT id FROM ranked WHERE duplicate_rank > 1',
    }));
    expect(pending).toMatchObject({ rows: [], rowCount: 0, totalMatching: 0, truncated: false });

    const completed = json(await world.override('work_items:complete', { id: 'WI-7301' }));
    const finalRead = json(await world.override('work_items:get', { id: 'WI-7301' }));
    expect(completed).toMatchObject({ ok: true, id: 'WI-7301', state: 'done' });
    expect(finalRead.results[0]).toMatchObject({
      workItem: { state: 'done', assignee: 'su-self' },
      execution: {
        archivedRows: DUPE_COUNT,
        returningRef: BACKFILL_RETURNING_REF,
        snapshotId: BACKFILL_SNAPSHOT_ID,
      },
    });
  });

  it('refuses the destructive backfill until a snapshot exists', async () => {
    const world = makeAsymmetryWorld(HANDOFF_CONTROL);
    const run = json(await world.override('tools:invoke', {
      name: 'capability:bash',
      args: { command: `npx tsx ${BACKFILL_FILE} --staging` },
    }));
    const state = json(await world.override('work_items:get', { id: 'WI-7301' }));

    expect(run).toMatchObject({ ok: false, exit_code: 2, error: 'precondition_failed' });
    expect(state.results[0]).toMatchObject({
      workItem: { state: 'open', assignee: null },
      execution: null,
    });
  });
});
