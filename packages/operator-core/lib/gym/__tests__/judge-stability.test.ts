import { describe, it, expect } from 'vitest';
import { judgeGymRun, type GymJudgeInput, type JudgeLlmCall } from '../judge';
import { GYM_JUDGE_RUBRIC_V1, rubricHash } from '../judge-scoring';

/**
 * Judge ranking + absolute stability (P-011). The circuit-breaker compares ABSOLUTE
 * dev-anchor aggregates over time, so identical judge output under the same rubric
 * MUST yield an identical composite + rubric_hash, and composites must rank-order with
 * the dimension scores. (The REAL Opus judge's run-to-run stability is validated on a
 * real A/B at P-014; this locks the deterministic scoring half.)
 */
const input: GymJudgeInput = {
  intent: 'i',
  projectContext: 'p',
  distilledTrace: 't',
  rubric: GYM_JUDGE_RUBRIC_V1,
};

const stub = (json: unknown): JudgeLlmCall => async () => ({ text: '', json, costUsd: 0, inputTokens: 0, outputTokens: 0 });

describe('judge ranking', () => {
  it('ranks a strong run above a weak run', async () => {
    const strong = await judgeGymRun(input, { llmCall: stub({ d1: 9, d2: 9, d3: 9, rationale: 'great' }) });
    const weak = await judgeGymRun(input, { llmCall: stub({ d1: 3, d2: 3, d3: 3, rationale: 'poor' }) });
    expect(strong.composite).toBeGreaterThan(weak.composite);
  });

  it('weights D1 (intent & spec fidelity) as primary', async () => {
    const d1heavy = await judgeGymRun(input, { llmCall: stub({ d1: 10, d2: 0, d3: 0, rationale: 'intent nailed' }) });
    const d2heavy = await judgeGymRun(input, { llmCall: stub({ d1: 0, d2: 10, d3: 0, rationale: 'pretty code, missed intent' }) });
    expect(d1heavy.composite).toBeGreaterThan(d2heavy.composite); // 0.5*10=5 vs 0.25*10=2.5
  });
});

describe('judge absolute stability', () => {
  it('produces an identical composite + rubric_hash for identical judge output', async () => {
    const out = { d1: 7.5, d2: 6, d3: 8, rationale: 'r' };
    const a = await judgeGymRun(input, { llmCall: stub(out) });
    const b = await judgeGymRun(input, { llmCall: stub({ ...out }) });
    expect(a.composite).toBe(b.composite);
    expect(a.rubricHash).toBe(b.rubricHash);
    expect(a.rubricHash).toBe(rubricHash(GYM_JUDGE_RUBRIC_V1));
  });
});
