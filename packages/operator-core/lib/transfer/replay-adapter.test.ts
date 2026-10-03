/**
 * replay-adapter.test.ts — the lib/replay binding (P-022 / FB-08): cut-point
 * selection, the with-lesson overlay shape, composite extraction, and the
 * refusal/unscored error paths. Fake governed-replay, zero LLM/PG.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPLAY_RUBRIC, REPLAY_BASELINE_VARIANT, runReplayBattery, type ReplayBatteryConfig } from '../replay';
import type { ReplayTranscript, ReplayTurnRole } from '../replay/types';
import {
  WITH_LESSON_VARIANT_ID,
  pickTransferCutIndex,
  transferReplayPort,
  withLessonVariant,
} from './replay-adapter';
import type { TransferLesson } from './types';

function transcript(roles: ReplayTurnRole[]): ReplayTranscript {
  return {
    ref: '/tmp/case.jsonl',
    turns: roles.map((role, index) => ({ index, role, text: `t${index}` })),
  };
}

const lesson: TransferLesson = {
  workspaceId: 'ws',
  id: 'lesson-1',
  signature: 'sig',
  title: 'Run tests first',
  lessonText: 'Always run the affected tests before claiming done.',
  sourceKind: 'transcript',
  sourceRef: '/tmp/case.jsonl',
  tier: 'probationary',
  status: 'candidate',
  testCount: 0,
  passCount: 0,
  failCount: 0,
  lastTestedAt: null,
  lastBatteryId: null,
  lastDelta: null,
  memoryId: null,
  packCandidateId: null,
  signalOrigin: 'replay',
  potSlug: null,
  createdAt: '2026-06-12T00:00:00.000Z',
  updatedAt: '2026-06-12T00:00:00.000Z',
};

describe('pickTransferCutIndex', () => {
  it('cuts at the first acting (non-system/user) turn', () => {
    expect(pickTransferCutIndex(transcript(['system', 'user', 'assistant', 'tool_use']))).toBe(2);
    expect(pickTransferCutIndex(transcript(['user', 'tool_use', 'assistant', 'user']))).toBe(1);
  });

  it('falls back to mid-transcript when no acting turn exists, clamped to the valid cut range', () => {
    expect(pickTransferCutIndex(transcript(['user', 'user', 'user', 'user']))).toBe(2);
    // acting turn at 0 is not a valid cut (context would be empty) → fallback.
    expect(pickTransferCutIndex(transcript(['assistant', 'user', 'user', 'user']))).toBe(2);
    expect(pickTransferCutIndex(transcript(['user', 'user']))).toBe(1);
  });
});

describe('withLessonVariant', () => {
  it('carries the lesson as a systemOverlay (the named transfer-lesson policy shape)', () => {
    const v = withLessonVariant(lesson);
    expect(v.variantId).toBe(WITH_LESSON_VARIANT_ID);
    expect(v.policy.systemOverlay).toContain(lesson.lessonText);
    expect(v.policy.systemReplace).toBeUndefined();
  });
});

describe('transferReplayPort', () => {
  const aggregates = (baseline: number | null, withLesson: number | null) => [
    {
      variantId: REPLAY_BASELINE_VARIANT.variantId,
      label: 'baseline',
      cells: 1,
      scored: 1,
      meanComposite: baseline,
      meanTokenJaccard: null,
      costUsd: 0,
    },
    {
      variantId: WITH_LESSON_VARIANT_ID,
      label: 'with lesson',
      cells: 1,
      scored: 1,
      meanComposite: withLesson,
      meanTokenJaccard: null,
      costUsd: 0.02,
    },
  ];

  it('runs one baseline+lesson battery over the historical case and maps composites', async () => {
    let seenConfig: ReplayBatteryConfig | null = null;
    const port = transferReplayPort({
      workspaceId: 'ws',
      runner: async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true }),
      llmCall: async () => ({ text: '', costUsd: 0 }) as never,
      runGoverned: async ({ config }) => {
        seenConfig = config as never;
        return {
          verdict: { allow: true, remainingUsd: 10 },
          result: {
            batteryId: config.batteryId,
            outcomes: [],
            perVariant: aggregates(6.0, 7.5),
            comparison: null,
            totalCostUsd: 0.02,
            costMeasured: true,
            rubricHash: 'x',
            budgetExhausted: false,
          },
        };
      },
    });
    const outcome = await port({ lesson, transcript: transcript(['user', 'assistant', 'tool_use', 'assistant']) });
    expect(outcome).toMatchObject({
      withComposite: 7.5,
      baselineComposite: 6.0,
      batteryId: 'transfer:lesson-1:t1',
      costUsd: 0.02,
      evaluation: { costMeasured: true },
    });
    expect(seenConfig!.variants.map((v) => v.variantId)).toEqual([
      REPLAY_BASELINE_VARIANT.variantId,
      WITH_LESSON_VARIANT_ID,
    ]);
    expect(seenConfig!.cases).toHaveLength(1);
    expect(seenConfig!.baselineMode).toBe('matched');
    expect(outcome.evaluation).toMatchObject({ reservation: null, invocations: [],
      experiment: { modelHash: null, promptHash: null, codeHash: null } });
  });

  it('the actual transfer battery runs matched baseline and lesson students, retaining both charges', async () => {
    const calls: Array<{ systemPrompt: string; contextText: string }> = [];
    const port = transferReplayPort({
      workspaceId: 'ws',
      runner: async (input) => {
        calls.push(input);
        return { outputText: 'current student continuation', costUsd: 0.02, inputTokens: 1, outputTokens: 1, replayed: true };
      },
      llmCall: async ({ messages }) => {
        const score = messages[0].content.includes('variant: with lesson') ? 8 : 6;
        return { text: JSON.stringify({ d1: score, d2: score, d3: score, rationale: 'fixture' }), costUsd: 0.01 } as never;
      },
      runGoverned: async ({ config }, deps) => ({ verdict: { allow: true, remainingUsd: 1 },
        result: await runReplayBattery(config, deps) }),
    });
    const outcome = await port({ lesson: { ...lesson, title: null },
      transcript: transcript(['user', 'assistant', 'tool_use', 'assistant']) });
    expect(calls).toHaveLength(2);
    expect(calls[0].contextText).toBe(calls[1].contextText);
    expect(calls[0].systemPrompt).not.toContain(lesson.lessonText);
    expect(calls[1].systemPrompt).toContain(lesson.lessonText);
    expect(outcome.withComposite).toBeGreaterThan(outcome.baselineComposite);
    expect(outcome.costUsd).toBeCloseTo(0.06);
    expect(outcome.evaluation?.invocations).toHaveLength(2);
    expect(outcome.evaluation?.experiment.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.evaluation?.experiment.modelHash).toBeNull();
  });

  it('pins the inputs actually executed, changes pins with the task/lesson/model, and retains unknown code coverage', async () => {
    const evaluate = async (model: string, lessonText: string, userText: string) => {
      const port = transferReplayPort({
        workspaceId: 'ws', now: () => Date.parse('2026-10-03T00:00:00Z'),
        runner: async () => ({ outputText: 'continuation', costUsd: 0.02, inputTokens: 1, outputTokens: 1,
          replayed: true, execution: { model, codeHash: 'fixture-runner' } }),
        llmCall: async () => ({ text: JSON.stringify({ d1: 7, d2: 7, d3: 7, rationale: 'fixture' }), costUsd: 0.01 }) as never,
        runGoverned: async ({ config }, deps) => ({ verdict: { allow: true, remainingUsd: 1 }, result: await runReplayBattery(config, deps) }),
      });
      const source = transcript(['user', 'assistant', 'tool_use', 'assistant']);
      source.turns[0].text = userText;
      return (await port({ lesson: { ...lesson, lessonText }, transcript: source })).evaluation!;
    };
    const first = await evaluate('student-a', 'lesson-a', 'task-a');
    const same = await evaluate('student-a', 'lesson-a', 'task-a');
    const model = await evaluate('student-b', 'lesson-a', 'task-a');
    const prompt = await evaluate('student-a', 'lesson-b', 'task-a');
    const task = await evaluate('student-a', 'lesson-a', 'task-b');
    expect(first.experiment).toEqual(same.experiment);
    expect(first.experiment.modelHash).toMatch(/^[a-f0-9]{64}$/);
    expect(model.experiment.modelHash).not.toBe(first.experiment.modelHash);
    expect(prompt.experiment.promptHash).not.toBe(first.experiment.promptHash);
    expect(task.experiment.taskHash).not.toBe(first.experiment.taskHash);
    expect(task.experiment.promptHash).not.toBe(first.experiment.promptHash);
    expect(first.loadedCode.adapter).toMatch(/^[a-f0-9]{16}$/);
    expect(first.loadedCode.battery).toMatch(/^[a-f0-9]{16}$/);
    expect(first.experiment.codeHash).toBeNull();
    expect(first.reservation).toBeNull();
    expect(first.outcomes.every((cell) => cell.replayed && cell.status === 'scored')).toBe(true);
  });

  it('refuses a mismatched workspace or transcript before invoking the governed battery', async () => {
    let called = false;
    const port = transferReplayPort({ workspaceId: 'ws', runner: async () => ({} as never), llmCall: async () => ({} as never),
      runGoverned: async () => { called = true; return { verdict: { allow: false, remainingUsd: null }, result: null }; } });
    const source = transcript(['user', 'assistant', 'user', 'assistant']);
    await expect(port({ lesson: { ...lesson, workspaceId: 'other' }, transcript: source })).rejects.toThrow(/source does not match/);
    await expect(port({ lesson, transcript: { ...source, ref: 'other' } })).rejects.toThrow(/source does not match/);
    expect(called).toBe(false);
  });

  it('pins actual judge model, effort and prompts rather than the declared default rubric', async () => {
    const evaluate = async (model: string, thinkingBudgetTokens: number, dimension: string) => {
      const port = transferReplayPort({ workspaceId: 'ws',
        runner: async () => ({ outputText: 'continuation', costUsd: 0.02, inputTokens: 1, outputTokens: 1,
          replayed: true, execution: { model: 'student', codeHash: null } }),
        llmCall: async () => ({ text: JSON.stringify({ d1: 7, d2: 7, d3: 7, rationale: 'fixture' }),
          costUsd: 0.01, inputTokens: 1, outputTokens: 1 }),
        runGoverned: async ({ config }, deps) => ({ verdict: { allow: true, remainingUsd: 1 },
          result: await runReplayBattery({ ...config, rubric: { ...DEFAULT_REPLAY_RUBRIC, model, thinkingBudgetTokens,
            dimensions: { ...DEFAULT_REPLAY_RUBRIC.dimensions, d1: dimension } } }, deps) }),
      });
      return (await port({ lesson, transcript: transcript(['user', 'assistant', 'tool_use', 'assistant']) })).evaluation!.experiment;
    };
    const first = await evaluate('actual-judge', 100, 'actual dimension');
    const model = await evaluate('other-judge', 100, 'actual dimension');
    const effort = await evaluate('actual-judge', 200, 'actual dimension');
    const prompt = await evaluate('actual-judge', 100, 'different dimension');
    expect(model.modelHash).not.toBe(first.modelHash);
    expect(effort.modelHash).not.toBe(first.modelHash);
    expect(prompt.promptHash).not.toBe(first.promptHash);
    expect(first.codeHash).toBeNull();
  });

  it('throws on a governed refusal (recorded as status error upstream, never silent)', async () => {
    const port = transferReplayPort({
      workspaceId: 'ws',
      runner: async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true }),
      llmCall: (async () => ({})) as never,
      runGoverned: async () => ({
        verdict: { allow: false, reason: 'replay-dark', remainingUsd: null },
        result: null,
      }),
    });
    await expect(
      port({ lesson, transcript: transcript(['user', 'assistant', 'user', 'assistant']) }),
    ).rejects.toThrow(/replay-dark/);
  });

  it('throws when the battery produced no scored pair', async () => {
    const port = transferReplayPort({
      workspaceId: 'ws',
      runner: async () => ({ outputText: '', costUsd: 0, inputTokens: 0, outputTokens: 0, replayed: true }),
      llmCall: (async () => ({})) as never,
      runGoverned: async ({ config }) => ({
        verdict: { allow: true, remainingUsd: 10 },
        result: {
          batteryId: config.batteryId,
          outcomes: [],
          perVariant: aggregates(6.0, null),
          comparison: null,
          totalCostUsd: 0.01,
          costMeasured: true,
          rubricHash: 'x',
          budgetExhausted: true,
        },
      }),
    });
    await expect(
      port({ lesson, transcript: transcript(['user', 'assistant', 'user', 'assistant']) }),
    ).rejects.toThrow(/no scored pair/);
  });

  it('forwards unknown cost without constructing a settled lifecycle from a missing reservation', async () => {
    const port = transferReplayPort({ workspaceId: 'ws', runner: async () => ({} as never),
      llmCall: async () => ({} as never), runGoverned: async ({ config }) => ({
        verdict: { allow: true, remainingUsd: 1 }, result: { batteryId: config.batteryId,
          outcomes: [], perVariant: aggregates(6, 8), comparison: null, totalCostUsd: 0.02,
          costMeasured: false, rubricHash: 'actual-rubric', budgetExhausted: false },
      }) });
    const outcome = await port({ lesson: { ...lesson, potSlug: 'actual-pot' },
      transcript: transcript(['user', 'assistant', 'user', 'assistant']) });
    expect(outcome.evaluation?.costMeasured).toBe(false);
    expect(outcome.evaluation?.contract).toBeUndefined();
  });
});
