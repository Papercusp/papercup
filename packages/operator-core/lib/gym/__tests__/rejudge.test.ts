import { describe, it, expect } from 'vitest';
import { reJudgeFromCache, type ReJudgeDeps } from '../rejudge';
import { GYM_JUDGE_RUBRIC_V1, rubricHash } from '../judge-scoring';
import type { GymScore } from '../judge';

/**
 * Re-judge-from-cache (P-010): re-score a cached DISTILLED trace under a (possibly
 * new) rubric WITHOUT re-running the multi-hour pipeline. Keyed on rubric_hash so a
 * rubric change re-judges, and an unchanged rubric is a no-op. Effects injected.
 */
const targetHash = rubricHash(GYM_JUDGE_RUBRIC_V1);

function deps(over: Partial<ReJudgeDeps> = {}): { d: ReJudgeDeps; calls: string[]; saved: GymScore[] } {
  const calls: string[] = [];
  const saved: GymScore[] = [];
  const score: GymScore = {
    d1: 8, d2: 7, d3: 6, composite: 7.25, rationale: 'r',
    judgeModel: 'claude-opus-4-8', rubricHash: targetHash, judgeTemp: 0,
    weights: GYM_JUDGE_RUBRIC_V1.weights, costUsd: 0.5, inputTokens: 1, outputTokens: 1,
  };
  const d: ReJudgeDeps = {
    async existingScoreHashes() { calls.push('existing'); return []; },
    async loadDistilledTrace() { calls.push('load'); return { intent: 'i', projectContext: 'p', distilledTrace: 't' }; },
    async judge(input) { calls.push(`judge:${input.rubric.model}`); return score; },
    async saveScore(_runId, s) { calls.push('save'); saved.push(s); },
    ...over,
  };
  return { d, calls, saved };
}

describe('reJudgeFromCache', () => {
  it('judges and saves when no score exists for the rubric hash', async () => {
    const { d, calls, saved } = deps();
    const res = await reJudgeFromCache({ runId: 'run-1', rubric: GYM_JUDGE_RUBRIC_V1 }, d);
    expect(res.action).toBe('judged');
    expect(res.rubricHash).toBe(targetHash);
    expect(res.score?.composite).toBe(7.25);
    expect(calls).toContain('load');
    expect(calls).toContain('judge:claude-opus-4-8');
    expect(saved).toHaveLength(1);
  });

  it('is a no-op when a score already exists for the rubric hash (no judge call)', async () => {
    const { d, calls } = deps({ async existingScoreHashes() { return [targetHash]; } });
    const res = await reJudgeFromCache({ runId: 'run-1', rubric: GYM_JUDGE_RUBRIC_V1 }, d);
    expect(res.action).toBe('cached');
    expect(calls).not.toContain('load');
    expect(calls.some((c) => c.startsWith('judge'))).toBe(false);
    expect(calls).not.toContain('save');
  });

  it('passes the rubric + the loaded trace to the judge', async () => {
    let seen: { intent?: string; model?: string } = {};
    const { d } = deps({
      async judge(input) {
        seen = { intent: input.intent, model: input.rubric.model };
        return {
          d1: 5, d2: 5, d3: 5, composite: 5, rationale: 'r', judgeModel: input.rubric.model,
          rubricHash: targetHash, judgeTemp: 0, weights: input.rubric.weights, costUsd: 0, inputTokens: 0, outputTokens: 0,
        };
      },
    });
    await reJudgeFromCache({ runId: 'run-1', rubric: GYM_JUDGE_RUBRIC_V1 }, d);
    expect(seen.intent).toBe('i');
    expect(seen.model).toBe('claude-opus-4-8');
  });
});
