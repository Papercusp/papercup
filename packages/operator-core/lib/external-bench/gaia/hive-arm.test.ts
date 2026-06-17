import { describe, expect, it, vi } from 'vitest';
import { parseSubQuestions, runHiveArm, type HiveArmDeps } from './hive-arm';
import type { GaiaAgentResult, LlmTurnResponse } from './agent';
import type { GaiaTask } from './dataset';

const L3: GaiaTask = { taskId: 'l3a', question: 'Who directed the highest-grossing film of the year the Eiffel Tower opened?', level: 3, finalAnswer: 'X', fileName: '' };

function subResult(id: string, answer: string, opts: Partial<GaiaAgentResult> = {}): GaiaAgentResult {
  return {
    taskId: id, rawOutput: `FINAL ANSWER: ${answer}`, finalAnswer: answer, turns: 2, toolCalls: 1,
    tokensIn: 100, tokensOut: 20, tokensCacheRead: 0, tokensCacheWrite: 0, stopReason: 'done', trajectory: [], ...opts,
  };
}

const llmText = (text: string, usage = { inputTokens: 10, outputTokens: 5 }): LlmTurnResponse => ({
  content: [{ type: 'text', text }], stopReason: 'end_turn', usage,
});

describe('gaia hive-arm — parseSubQuestions', () => {
  it('parses a JSON array', () => {
    expect(parseSubQuestions('Here: ["When did the Eiffel Tower open?", "What was the top film that year?"]', 4))
      .toEqual(['When did the Eiffel Tower open?', 'What was the top film that year?']);
  });
  it('parses numbered/bulleted lines as a fallback', () => {
    const t = '1. What year did the Eiffel Tower open?\n2. Which film grossed the most that year?';
    expect(parseSubQuestions(t, 4)).toHaveLength(2);
  });
  it('caps at max', () => {
    expect(parseSubQuestions('["a?","b?","c?","d?","e?"]', 2)).toHaveLength(2);
  });
  it('returns empty when nothing parseable', () => {
    expect(parseSubQuestions('no questions here', 4)).toEqual([]);
  });
});

describe('gaia hive-arm — runHiveArm', () => {
  it('decomposes, fans out to sub-agents, synthesizes a FINAL ANSWER, and sums cost', async () => {
    const runSubAgent = vi.fn(async (t: GaiaTask) => subResult(t.taskId, t.taskId.includes('sub1') ? '1889' : 'film'));
    const llm = vi
      .fn<HiveArmDeps['llm']>()
      .mockResolvedValueOnce(llmText('["When did the Eiffel Tower open?","Top film that year?"]', { inputTokens: 30, outputTokens: 10 })) // decompose
      .mockResolvedValueOnce(llmText('Synthesizing.\nFINAL ANSWER: Gustave Eiffel', { inputTokens: 50, outputTokens: 8 })); // synthesize
    const r = await runHiveArm(L3, { llm, runSubAgent });
    expect(llm).toHaveBeenCalledTimes(2);
    expect(runSubAgent).toHaveBeenCalledTimes(2);
    expect(r.finalAnswer).toBe('Gustave Eiffel');
    expect(r.stopReason).toBe('done');
    // tokens summed across decompose(30/10) + 2 subs(100/20 each) + synth(50/8) = in 280, out 58.
    expect(r.tokensIn).toBe(30 + 100 + 100 + 50);
    expect(r.tokensOut).toBe(10 + 20 + 20 + 8);
    expect(r.toolCalls).toBe(2); // one per sub-agent
    expect(r.trajectory.some((s) => s.tool === 'sub_agent')).toBe(true);
  });

  it('falls back to the original question when decomposition yields nothing', async () => {
    const runSubAgent = vi.fn(async () => subResult('l3a#sub1', 'answer'));
    const llm = vi
      .fn<HiveArmDeps['llm']>()
      .mockResolvedValueOnce(llmText('I cannot decompose this.')) // no parseable subs
      .mockResolvedValueOnce(llmText('FINAL ANSWER: answer'));
    const r = await runHiveArm(L3, { llm, runSubAgent });
    expect(runSubAgent).toHaveBeenCalledTimes(1); // atomic → single sub-agent on the original question
    expect(r.finalAnswer).toBe('answer');
  });

  it('errors when a sub-agent fails AND synthesis produces no answer', async () => {
    const runSubAgent = vi.fn(async () => subResult('x', '', { stopReason: 'error', finalAnswer: null, rawOutput: '' }));
    const llm = vi
      .fn<HiveArmDeps['llm']>()
      .mockResolvedValueOnce(llmText('["sub?"]'))
      .mockResolvedValueOnce(llmText('no final answer here'));
    const r = await runHiveArm(L3, { llm, runSubAgent });
    expect(r.stopReason).toBe('error');
    expect(r.finalAnswer).toBeNull();
  });

  it('degrades a thrown LLM error to stopReason=error', async () => {
    const r = await runHiveArm(L3, {
      llm: async () => { throw new Error('gateway down'); },
      runSubAgent: async () => subResult('x', 'a'),
    });
    expect(r.stopReason).toBe('error');
    expect(r.error).toContain('gateway down');
  });
});
