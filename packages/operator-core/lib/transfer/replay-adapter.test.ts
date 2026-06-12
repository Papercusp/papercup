/**
 * replay-adapter.test.ts — the lib/replay binding (P-022 / FB-08): cut-point
 * selection, the with-lesson overlay shape, composite extraction, and the
 * refusal/unscored error paths. Fake governed-replay, zero LLM/PG.
 */
import { describe, expect, it } from 'vitest';
import { REPLAY_BASELINE_VARIANT } from '../replay';
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
    let seenConfig: { batteryId: string; variants: Array<{ variantId: string }>; cases: unknown[] } | null = null;
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
            rubricHash: 'x',
            budgetExhausted: false,
          },
        };
      },
    });
    const outcome = await port({ lesson, transcript: transcript(['user', 'assistant', 'tool_use', 'assistant']) });
    expect(outcome).toEqual({
      withComposite: 7.5,
      baselineComposite: 6.0,
      batteryId: 'transfer:lesson-1:t1',
      costUsd: 0.02,
    });
    expect(seenConfig!.variants.map((v) => v.variantId)).toEqual([
      REPLAY_BASELINE_VARIANT.variantId,
      WITH_LESSON_VARIANT_ID,
    ]);
    expect(seenConfig!.cases).toHaveLength(1);
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
          rubricHash: 'x',
          budgetExhausted: true,
        },
      }),
    });
    await expect(
      port({ lesson, transcript: transcript(['user', 'assistant', 'user', 'assistant']) }),
    ).rejects.toThrow(/no scored pair/);
  });
});
