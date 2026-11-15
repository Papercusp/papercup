/**
 * test-rubric-unification-2026-10-12 P-010: a rubric may declare more probe checks than the
 * shared continuity batch runner executes per call (CONTINUITY_PROBE_MAX_PER_WAKE). The rubric
 * evaluator runs them in chunks of that size, so every declared probe executes exactly once and
 * nothing is silently truncated; above RUBRIC_PROBE_MAX_PER_EMIT the rubric is refused at
 * authoring and at grading before any probe is dispatched.
 */
import { describe, expect, it, vi } from 'vitest';
import { CONTINUITY_PROBE_MAX_PER_WAKE, RUBRIC_PROBE_MAX_PER_EMIT } from './agent-tools/limits';
import { SQL_PROBE_TOOL, continuityProbeRevision } from './continuity-probes';
import { evaluateCriterionProbeChecks, validateCriterionCheckPaths } from './rubrics-criterion-checks';
import './agent-tools/dev/pg_query';

function sqlProbe(marker: number) {
  return {
    kind: 'sql',
    sql: `SELECT ${marker} AS n`,
    schemaRevision: continuityProbeRevision(SQL_PROBE_TOOL)!,
    expect: { path: '$.rowCount', op: 'eq', value: 1 },
  };
}

function probeCriteria(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    key: `c-${i}`,
    check: { kind: 'probe', probe: sqlProbe(i) },
  }));
}

function blankRatings(count: number) {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`c-${i}`, { rating: '' }]));
}

function countingDispatcher() {
  const calls: string[] = [];
  const dispatchTool = async (name: string, args: unknown): Promise<unknown> => {
    if (name !== SQL_PROBE_TOOL) throw new Error(`unexpected tool ${name}`);
    calls.push(String((args as { sql?: string })?.sql ?? ''));
    return { data: { mode: 'query', rowCount: 1, truncated: false, fields: ['n'], rows: [{ n: 1 }] } };
  };
  return { calls, dispatchTool };
}

describe('rubric probe checks above the per-wake batch size run in chunks, never truncated', () => {
  it('the rubric cap is larger than the per-wake batch, so chunking is reachable', () => {
    expect(RUBRIC_PROBE_MAX_PER_EMIT).toBeGreaterThan(CONTINUITY_PROBE_MAX_PER_WAKE);
  });

  it('executes every one of 13 declared probes exactly once and judges each criterion', async () => {
    const count = 13;
    expect(count).toBeGreaterThan(CONTINUITY_PROBE_MAX_PER_WAKE);
    const { calls, dispatchTool } = countingDispatcher();
    const evaluation = await evaluateCriterionProbeChecks({
      criteria: probeCriteria(count) as never,
      ratings: blankRatings(count) as never,
      dispatchTool,
    });
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(Object.keys(evaluation.checkRuns).sort()).toEqual(probeCriteria(count).map((c) => c.key).sort());
    expect(calls).toHaveLength(count);
    expect(new Set(calls).size).toBe(count);
  });

  it('executes six nine-probe conjunctions in nine operations with 54 separate child results', async () => {
    const criteria = Array.from({ length: 6 }, (_, i) => ({ key: `c-${i}`,
      check: { kind: 'probe', all: Array.from({ length: 9 }, (_, n) => sqlProbe(n)) } }));
    const { calls, dispatchTool } = countingDispatcher();
    const evaluation = await evaluateCriterionProbeChecks({ criteria: criteria as never,
      ratings: blankRatings(6) as never, dispatchTool });
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(calls).toHaveLength(9);
    expect(new Set(calls).size).toBe(9);
    const children: unknown[] = [];
    for (const criterion of criteria) {
      const run = evaluation.checkRuns[criterion.key]!;
      expect(run).toMatchObject({ kind: 'probe', verdict: 'pass', executed: true,
        all: Array.from({ length: 9 }, () => expect.objectContaining({ verdict: 'pass', executed: true })) });
      children.push(...(run as { all: unknown[] }).all);
    }
    expect(children).toHaveLength(54);
    expect(new Set(children).size).toBe(54);
  });

  it.each(['stale', 'error'] as const)('does not lose a %s ninth child beyond the first execution chunk', async (failure) => {
    const { calls, dispatchTool } = countingDispatcher();
    const warning = failure === 'error' ? vi.spyOn(console, 'warn').mockImplementation(() => {}) : null;
    try {
      const evaluation = await evaluateCriterionProbeChecks({
        criteria: [{ key: 'c-0', check: { kind: 'probe', all: Array.from({ length: 9 }, (_, n) => sqlProbe(n)) } }] as never,
        ratings: { 'c-0': { rating: '' } },
        dispatchTool: async (name, args) => {
          if (String(args.sql).includes('SELECT 8 AS n')) {
            if (failure === 'error') throw new Error('ninth source unavailable');
            return { data: { mode: 'query', rowCount: 0, truncated: false, fields: ['n'], rows: [] } };
          }
          return dispatchTool(name, args);
        },
      });
      expect(calls).toHaveLength(8);
      if (failure === 'error') {
        expect(evaluation).toMatchObject({ ok: false, error: 'probe_run_failed', criterionKey: 'c-0' });
        expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('ninth source unavailable'));
      } else {
        expect(evaluation.ok).toBe(true);
        if (evaluation.ok) expect(evaluation.checkRuns['c-0']).toMatchObject({ verdict: 'fail', all: [
          ...Array.from({ length: 8 }, () => expect.objectContaining({ verdict: 'pass' })),
          expect.objectContaining({ verdict: 'fail' }),
        ] });
      }
    } finally { warning?.mockRestore(); }
  });

  it('refuses a single 25-probe conjunction without dispatch', async () => {
    const { calls, dispatchTool } = countingDispatcher();
    const evaluation = await evaluateCriterionProbeChecks({
      criteria: [{ key: 'c-0', check: { kind: 'probe', all: Array.from({ length: 25 }, (_, n) => sqlProbe(n)) } }] as never,
      ratings: blankRatings(1) as never, dispatchTool,
    });
    expect(evaluation).toMatchObject({ ok: false, error: 'probe_invalid' });
    expect(calls).toHaveLength(0);
  });

  it('accepts a 13-probe rubric at authoring and refuses one above the rubric cap', () => {
    const batchFault = (n: number) =>
      validateCriterionCheckPaths(probeCriteria(n) as never).scopeFailures
        .filter((f) => f.criterionKey === '(probe batch)');
    expect(batchFault(13)).toEqual([]);
    expect(batchFault(RUBRIC_PROBE_MAX_PER_EMIT + 1)).toHaveLength(1);
  });

  it('refuses above the rubric cap at grading without dispatching a single probe', async () => {
    const count = RUBRIC_PROBE_MAX_PER_EMIT + 1;
    const { calls, dispatchTool } = countingDispatcher();
    const evaluation = await evaluateCriterionProbeChecks({
      criteria: probeCriteria(count) as never,
      ratings: blankRatings(count) as never,
      dispatchTool,
    });
    expect(evaluation).toMatchObject({
      ok: false,
      error: 'probe_invalid',
      criterionKey: '(probe batch)',
      detail: expect.stringContaining(`${count} distinct probes exceed the execution cap of ${RUBRIC_PROBE_MAX_PER_EMIT}`),
    });
    expect(calls).toHaveLength(0);
  });
});
