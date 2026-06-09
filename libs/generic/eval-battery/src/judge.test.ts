/**
 * The frozen LLM judge runner. The LLM call is injected so build → call → parse →
 * composite is unit-tested without the network. Ported from the gym (source moved into
 * the shared eval-battery engine, reconciliation D-001).
 */
import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, judgeBatteryRun, type JudgeLlmCall, type JudgeInput } from './judge';
import { rubricHash, composite, type BatteryRubric } from './scoring';

const RUBRIC: BatteryRubric = {
  version: 'v1',
  model: 'claude-opus-4-8',
  temperature: 0,
  thinkingBudgetTokens: 32_000,
  weights: { d1: 0.5, d2: 0.25, d3: 0.25 },
  dimensions: {
    d1: 'Intent & spec fidelity (PRIMARY).',
    d2: 'Code quality (subjective).',
    d3: 'Process correctness.',
  },
};

const input: JudgeInput = {
  intent: 'Operators need a liveness probe',
  projectContext: 'A small Hono service.',
  distilledTrace: 'scoper chunked... worker added GET /health returning 200... validator passed.',
  rubric: RUBRIC,
};

describe('buildJudgePrompt', () => {
  it('instructs JSON-only output over a 0..10 scale with all three dimensions', () => {
    const { system } = buildJudgePrompt(input);
    expect(system).toMatch(/json/i);
    expect(system).toContain('0');
    expect(system).toContain('10');
    expect(system).toContain(RUBRIC.dimensions.d1);
    expect(system).toContain(RUBRIC.dimensions.d2);
    expect(system).toContain(RUBRIC.dimensions.d3);
  });

  it('puts the intent, project context, and distilled trace in the user message', () => {
    const { user } = buildJudgePrompt(input);
    expect(user).toContain(input.intent);
    expect(user).toContain(input.projectContext);
    expect(user).toContain(input.distilledTrace);
  });
});

function fakeLlm(result: { json?: unknown; text?: string }): { call: JudgeLlmCall; calls: Parameters<JudgeLlmCall>[0][] } {
  const calls: Parameters<JudgeLlmCall>[0][] = [];
  const call: JudgeLlmCall = async (opts) => {
    calls.push(opts);
    return { text: result.text ?? '', json: result.json, costUsd: 0.42, inputTokens: 1000, outputTokens: 200 };
  };
  return { call, calls };
}

describe('judgeBatteryRun', () => {
  it('parses the judge JSON, computes composite, and stamps the frozen run-params', async () => {
    const { call } = fakeLlm({ json: { d1: 8, d2: 6, d3: 4, rationale: 'solid intent, minor debt' } });
    const score = await judgeBatteryRun(input, { llmCall: call });

    expect(score).toMatchObject({
      d1: 8,
      d2: 6,
      d3: 4,
      rationale: 'solid intent, minor debt',
      judgeModel: 'claude-opus-4-8',
      judgeTemp: RUBRIC.temperature,
      rubricHash: rubricHash(RUBRIC),
      costUsd: 0.42,
    });
    expect(score.composite).toBeCloseTo(composite({ d1: 8, d2: 6, d3: 4 }, RUBRIC.weights), 6);
    expect(score.weights).toEqual(RUBRIC.weights);
  });

  it('calls the LLM with the frozen model, thinking budget, and JSON format', async () => {
    const { call, calls } = fakeLlm({ json: { d1: 5, d2: 5, d3: 5, rationale: 'r' } });
    await judgeBatteryRun(input, { llmCall: call });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('claude-opus-4-8');
    expect(calls[0].thinkingBudgetTokens).toBe(RUBRIC.thinkingBudgetTokens);
    expect(calls[0].responseFormat).toBe('json');
  });

  it('falls back to extracting JSON from the text when structured json is absent', async () => {
    const { call } = fakeLlm({ json: undefined, text: 'Here is my verdict:\n{"d1":9,"d2":8,"d3":7,"rationale":"ok"}' });
    const score = await judgeBatteryRun(input, { llmCall: call });
    expect(score.d1).toBe(9);
  });

  it('throws when the judge produced no parseable scores', async () => {
    const { call } = fakeLlm({ json: undefined, text: 'I was unable to evaluate this run.' });
    await expect(judgeBatteryRun(input, { llmCall: call })).rejects.toThrow();
  });
});
