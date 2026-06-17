import { describe, expect, it } from 'vitest';
import {
  formatGaiaReportLine,
  predictionsToJsonl,
  renderTrace,
  runGaiaSuite,
  type GaiaRunDeps,
} from './run';
import type { GaiaAgentResult } from './agent';
import type { GaiaTask } from './dataset';

const task = (id: string, level: 1 | 2 | 3, gold: string): GaiaTask => ({
  taskId: id,
  question: `q-${id}`,
  level,
  finalAnswer: gold,
  fileName: '',
});

/** A canned agent result. */
function result(taskId: string, opts: Partial<GaiaAgentResult> & { answer?: string | null }): GaiaAgentResult {
  const finalAnswer = opts.answer === undefined ? null : opts.answer;
  return {
    taskId,
    rawOutput: finalAnswer ? `FINAL ANSWER: ${finalAnswer}` : 'no answer',
    finalAnswer,
    turns: opts.turns ?? 2,
    toolCalls: opts.toolCalls ?? 1,
    tokensIn: opts.tokensIn ?? 100,
    tokensOut: opts.tokensOut ?? 20,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    stopReason: opts.stopReason ?? 'done',
    trajectory: opts.trajectory ?? [{ turn: 1, kind: 'assistant_text', summary: 'thinking…' }],
    ...(opts.error ? { error: opts.error } : {}),
  };
}

describe('gaia run — runGaiaSuite', () => {
  it('runs each task, grades, and aggregates per-level + overall', async () => {
    const tasks = [task('a', 1, 'Paris'), task('b', 1, 'London'), task('c', 2, '42'), task('d', 3, 'cat, dog')];
    const answers: Record<string, string | null> = { a: 'Paris', b: 'Berlin', c: '42', d: 'cat, dog' };
    const deps: GaiaRunDeps = { runAgent: async (t) => result(t.taskId, { answer: answers[t.taskId] }) };
    const out = await runGaiaSuite(tasks, deps, { concurrency: 2 });

    expect(out.report.scored).toBe(4);
    expect(out.report.resolved).toBe(3); // a, c, d
    expect(out.report.overallAccuracy).toBeCloseTo(3 / 4);
    expect(out.predictions).toHaveLength(4);
    expect(out.predictions[0]).toMatchObject({ task_id: 'a', model_answer: 'Paris', level: 1 });
    expect(out.totals.tokensIn).toBe(400);
    expect(out.totals.estCostUsd).toBeGreaterThan(0);
  });

  it('excludes infra-error tasks from the scored denominator and counts them', async () => {
    const tasks = [task('a', 1, 'Paris'), task('b', 2, '42')];
    const deps: GaiaRunDeps = {
      runAgent: async (t) =>
        t.taskId === 'b'
          ? result('b', { answer: null, stopReason: 'error', error: 'gateway 429' })
          : result('a', { answer: 'Paris' }),
    };
    const out = await runGaiaSuite(tasks, deps);
    expect(out.totals.infraErrors).toBe(1);
    expect(out.report.scored).toBe(1); // only 'a' scored
    expect(out.report.resolved).toBe(1);
    expect(out.report.excluded).toBe(1);
    // The excluded task still appears in predictions (surfaced).
    expect(out.predictions.find((p) => p.task_id === 'b')?.error).toContain('429');
  });

  it('records a missing FINAL ANSWER as model_answer="" and a formatting failure', async () => {
    const tasks = [task('a', 1, 'Paris')];
    const deps: GaiaRunDeps = { runAgent: async () => result('a', { answer: null }) };
    const out = await runGaiaSuite(tasks, deps);
    expect(out.predictions[0].model_answer).toBe('');
    expect(out.report.formatFails).toBe(1);
    expect(out.report.formatFailRate).toBe(1);
  });

  it('can keep infra errors in scoring when excludeInfraErrors=false', async () => {
    const tasks = [task('a', 1, 'Paris')];
    const deps: GaiaRunDeps = { runAgent: async () => result('a', { answer: null, stopReason: 'error', error: 'x' }) };
    const out = await runGaiaSuite(tasks, deps, { excludeInfraErrors: false });
    expect(out.report.scored).toBe(1);
    expect(out.report.resolved).toBe(0);
    expect(out.report.excluded).toBe(0);
  });
});

describe('gaia run — helpers', () => {
  it('renderTrace formats trajectory steps and truncates', () => {
    const r = result('a', {
      answer: 'x',
      trajectory: [
        { turn: 1, kind: 'tool_use', tool: 'web_search', summary: 'q' },
        { turn: 1, kind: 'tool_result', tool: 'web_search', summary: 'res' },
      ],
    });
    const t = renderTrace(r, 1000);
    expect(t).toContain('[1] tool_use:web_search: q');
    expect(renderTrace(r, 10)).toContain('truncated');
  });

  it('predictionsToJsonl emits one JSON object per line', () => {
    const jsonl = predictionsToJsonl([
      { task_id: 'a', model_answer: 'x', reasoning_trace: '', level: 1, stopReason: 'done', turns: 1, toolCalls: 0, tokensIn: 1, tokensOut: 1 },
    ]);
    expect(jsonl.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(jsonl.trim()).task_id).toBe('a');
  });

  it('formatGaiaReportLine summarizes accuracy per level', async () => {
    const out = await runGaiaSuite([task('a', 1, 'Paris')], { runAgent: async () => result('a', { answer: 'Paris' }) });
    const line = formatGaiaReportLine(out);
    expect(line).toContain('overall 100.0%');
    expect(line).toContain('L1 100.0%');
  });
});
