/**
 * Tests for the SUT-health gate.
 *
 * When the system under test produces no usable output — a turn errors,
 * or every turn comes back empty — the runner skips the real judge and
 * emits one clean `meta/sut_no_output` finding via buildInconclusiveJudge.
 * Running the real judge on such a run only yields confident axis
 * failures that describe the broken environment, not operator behavior.
 *
 * Surfaced by P5: M11/M12 (empty turns) and M8 (SUT fired non-operator
 * tools then aborted) — all environment failures mis-scored as operator
 * findings before this gate existed.
 */

import { describe, it, expect } from 'vitest';

import { buildInconclusiveJudge } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../rubrics/operator';
import { inconclusiveReason } from '@papercusp/testing-shell/llm';
import type { TurnResult } from '@papercusp/testing-shell/llm';

const turn = (over: Partial<TurnResult> = {}): TurnResult => ({
  assistantText: 'hello there',
  toolCalls: [],
  toolResults: [],
  cards: [],
  controlTags: [],
  costUsd: 0,
  latencyMs: 10,
  finishReason: 'done',
  rawSseTape: [],
  ...over,
});

describe('inconclusiveReason', () => {
  it('flags an errored finishReason with the turn error text', () => {
    const turns = [turn({ finishReason: 'error', error: 'HTTP 500: upstream down' })];
    expect(inconclusiveReason(turns, 'errored')).toMatch(/HTTP 500: upstream down/);
  });

  it('flags an errored finishReason even without an error string', () => {
    expect(inconclusiveReason([turn()], 'errored')).toMatch(/unknown error/);
  });

  it('flags zero turns', () => {
    expect(inconclusiveReason([], 'completed')).toBe('no turns were produced');
  });

  it('flags all-empty turns (empty + whitespace-only text, no tools)', () => {
    const turns = [turn({ assistantText: '' }), turn({ assistantText: '   ' })];
    expect(inconclusiveReason(turns, 'completed')).toMatch(/all 2 turn\(s\) produced empty output/);
  });

  it('does NOT flag when a turn has assistant text', () => {
    expect(inconclusiveReason([turn()], 'completed')).toBeNull();
  });

  it('does NOT flag when a turn has tool calls but no text', () => {
    // Tool calls count as output — the operator did something observable.
    const turns = [turn({ assistantText: '', toolCalls: [{ name: 'harness:list' } as never] })];
    expect(inconclusiveReason(turns, 'completed')).toBeNull();
  });

  it('does NOT flag a normal multi-turn run', () => {
    expect(inconclusiveReason([turn(), turn()], 'completed')).toBeNull();
  });

  it('does NOT flag when only one of several turns is empty', () => {
    const turns = [turn({ assistantText: '' }), turn()];
    expect(inconclusiveReason(turns, 'completed')).toBeNull();
  });
});

describe('buildInconclusiveJudge', () => {
  it('returns 0 for every rubric axis', () => {
    const j = buildInconclusiveJudge(OPERATOR_RUBRIC, 'test reason');
    for (const axis of OPERATOR_RUBRIC.axes) {
      expect(j.scores[axis.id]).toBe(0);
    }
  });

  it('emits exactly one error meta finding carrying the reason', () => {
    const j = buildInconclusiveJudge(OPERATOR_RUBRIC, 'all 3 turn(s) produced empty output');
    expect(j.findings).toHaveLength(1);
    expect(j.findings[0].axis).toBe('meta');
    expect(j.findings[0].severity).toBe('error');
    expect(j.findings[0].claim).toMatch(/inconclusive/i);
    expect(j.findings[0].claim).toMatch(/all 3 turn\(s\)/);
    expect(j.findings[0].isNovel).toBe(false);
  });

  it('costs nothing and does not overrule asserts', () => {
    const j = buildInconclusiveJudge(OPERATOR_RUBRIC, 'x');
    expect(j.costUsd).toBe(0);
    expect(j.judgeOverruledAssert).toBe(false);
  });

  it('uses a stable finding shape across different reasons (promotion grouping)', () => {
    const a = buildInconclusiveJudge(OPERATOR_RUBRIC, 'reason A');
    const b = buildInconclusiveJudge(OPERATOR_RUBRIC, 'totally different reason B');
    expect(a.findings[0].shape).toBe(b.findings[0].shape);
  });
});
