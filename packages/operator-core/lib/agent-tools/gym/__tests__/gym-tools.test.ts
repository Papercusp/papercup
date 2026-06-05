import { describe, it, expect } from 'vitest';
import { runGymJudge } from '../judge';
import signalsTool from '../signals';
import type { JudgeLlmCall } from '../../../gym/primitives';

/**
 * P-012 — the gym agent tools (re-exposed lib/gym primitives). gym:signals is pure;
 * gym:judge's build→call→parse→composite is exercised via its testable inner
 * `runGymJudge` with a FAKE llmCall (no network).
 */

function parse(res: { content: Array<{ text: string }> }): any {
  return JSON.parse(res.content[0].text);
}

describe('gym:signals tool', () => {
  it('evaluates declared signals and reports unknowns', async () => {
    const res = await (signalsTool as any).handler({
      signals: ['regressionsFromTests', 'plantedBugCaught', 'mystery'],
      preTests: [{ name: 't1', passed: true }],
      postTests: [{ name: 't1', passed: false }],
      plantedBug: { location: 'src/auth/session.ts' },
      harnessOutputText: 'the validator flagged an issue in src/auth/session.ts',
    });
    const out = parse(res);
    expect(out.ok).toBe(false); // an unknown signal name was passed
    expect(out.unknown).toEqual(['mystery']);
    const byName = Object.fromEntries(out.results.map((r: any) => [r.name, r]));
    expect(byName.regressionsFromTests).toEqual({ name: 'regressionsFromTests', value: true, applicable: true });
    expect(byName.plantedBugCaught).toEqual({ name: 'plantedBugCaught', value: true, applicable: true });
    expect(out.known.sort()).toEqual(['plantedBugCaught', 'regressionsFromTests']);
  });

  it('marks a signal inapplicable (work-item-output target: no tests) rather than false', async () => {
    const res = await (signalsTool as any).handler({ signals: ['regressionsFromTests'], harnessOutputText: 'done' });
    const out = parse(res);
    expect(out.ok).toBe(true);
    expect(out.results[0]).toEqual({ name: 'regressionsFromTests', value: false, applicable: false });
  });
});

describe('gym:judge runGymJudge (inner, fake llmCall)', () => {
  const fakeLlm: JudgeLlmCall = async () => ({
    text: '',
    json: { d1: 8, d2: 6, d3: 7, rationale: 'solid intent fidelity; minor quality gap' },
    costUsd: 0.12,
    inputTokens: 1000,
    outputTokens: 200,
  });

  it('builds → calls → parses → composites with the default (V1) rubric', async () => {
    const score = await runGymJudge(
      { intent: 'add pagination', projectContext: 'a TS API', distilledTrace: '## Diff\n+code' },
      { llmCall: fakeLlm },
    );
    expect(score.d1).toBe(8);
    expect(score.d2).toBe(6);
    expect(score.d3).toBe(7);
    // V1 weights 0.5/0.25/0.25 → (8*.5 + 6*.25 + 7*.25) = 7.25
    expect(score.composite).toBeCloseTo(7.25, 5);
    expect(score.judgeModel).toBe('claude-opus-4-8');
    expect(score.costUsd).toBe(0.12);
  });

  it('honors a target rubric override (weights change the composite)', async () => {
    const score = await runGymJudge(
      {
        intent: 'x',
        projectContext: 'y',
        distilledTrace: 'z',
        rubric: { version: 'v1', weights: { d1: 1, d2: 0, d3: 0 } },
      },
      { llmCall: fakeLlm },
    );
    // all weight on d1=8 → composite 8
    expect(score.composite).toBeCloseTo(8, 5);
  });

  it('passes the rubric model + thinking budget through to the llmCall', async () => {
    let seenModel = '';
    let seenMax = 0;
    const spy: JudgeLlmCall = async (opts) => {
      seenModel = opts.model;
      seenMax = opts.maxTokens ?? 0;
      return { text: '', json: { d1: 5, d2: 5, d3: 5, rationale: 'ok' }, costUsd: 0, inputTokens: 1, outputTokens: 1 };
    };
    await runGymJudge(
      { intent: 'x', projectContext: 'y', distilledTrace: 'z', rubric: { model: 'claude-sonnet-4-6', thinkingBudgetTokens: 8000 } },
      { llmCall: spy },
    );
    expect(seenModel).toBe('claude-sonnet-4-6');
    expect(seenMax).toBe(8000 + 4096); // judge leaves room above the thinking budget
  });
});
