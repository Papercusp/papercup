import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, judgeGymRun, type JudgeLlmCall, type GymJudgeInput } from '../judge';
import { GYM_JUDGE_RUBRIC_V1, rubricHash, composite } from '../judge-scoring';

/**
 * The frozen Opus judge runner (P-008). The LLM call is injected so the build →
 * call → parse → composite flow is unit-tested without the network. The judge
 * reasons generically over a DISTILLED trace (③b) and emits per-dim scores +
 * rationale; composite is the reward.
 */
const input: GymJudgeInput = {
  intent: 'Operators need a liveness probe',
  projectContext: 'A small Hono service.',
  distilledTrace: 'scoper chunked... worker added GET /health returning 200... validator passed.',
  rubric: GYM_JUDGE_RUBRIC_V1,
};

describe('buildJudgePrompt', () => {
  it('instructs JSON-only output over a 0..10 scale with all three dimensions', () => {
    const { system } = buildJudgePrompt(input);
    expect(system).toMatch(/json/i);
    expect(system).toContain('0');
    expect(system).toContain('10');
    expect(system).toContain(GYM_JUDGE_RUBRIC_V1.dimensions.d1);
    expect(system).toContain(GYM_JUDGE_RUBRIC_V1.dimensions.d2);
    expect(system).toContain(GYM_JUDGE_RUBRIC_V1.dimensions.d3);
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
    return {
      text: result.text ?? '',
      json: result.json,
      costUsd: 0.42,
      inputTokens: 1000,
      outputTokens: 200,
    };
  };
  return { call, calls };
}

describe('judgeGymRun', () => {
  it('parses the judge JSON, computes composite, and stamps the frozen run-params', async () => {
    const { call } = fakeLlm({ json: { d1: 8, d2: 6, d3: 4, rationale: 'solid intent, minor debt' } });
    const score = await judgeGymRun(input, { llmCall: call });

    expect(score).toMatchObject({
      d1: 8,
      d2: 6,
      d3: 4,
      rationale: 'solid intent, minor debt',
      judgeModel: 'claude-opus-4-8',
      judgeTemp: GYM_JUDGE_RUBRIC_V1.temperature,
      rubricHash: rubricHash(GYM_JUDGE_RUBRIC_V1),
      costUsd: 0.42,
    });
    expect(score.composite).toBeCloseTo(composite({ d1: 8, d2: 6, d3: 4 }, GYM_JUDGE_RUBRIC_V1.weights), 6);
    expect(score.weights).toEqual(GYM_JUDGE_RUBRIC_V1.weights);
  });

  it('calls the LLM with the frozen model, thinking budget, and JSON format', async () => {
    const { call, calls } = fakeLlm({ json: { d1: 5, d2: 5, d3: 5, rationale: 'r' } });
    await judgeGymRun(input, { llmCall: call });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('claude-opus-4-8');
    expect(calls[0].thinkingBudgetTokens).toBe(GYM_JUDGE_RUBRIC_V1.thinkingBudgetTokens);
    expect(calls[0].responseFormat).toBe('json');
  });

  it('falls back to extracting JSON from the text when structured json is absent', async () => {
    const { call } = fakeLlm({ json: undefined, text: 'Here is my verdict:\n{"d1":9,"d2":8,"d3":7,"rationale":"ok"}' });
    const score = await judgeGymRun(input, { llmCall: call });
    expect(score.d1).toBe(9);
  });

  it('throws when the judge produced no parseable scores', async () => {
    const { call } = fakeLlm({ json: undefined, text: 'I was unable to evaluate this run.' });
    await expect(judgeGymRun(input, { llmCall: call })).rejects.toThrow();
  });
});
