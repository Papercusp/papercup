/**
 * The live student-transfer test (P-022 / FB-08) — lib/replay's battery bound
 * to the {@link TransferReplayPort} the tick consumes.
 *
 * One lesson's test = ONE governed replay battery over the lesson's source
 * historical case:
 *
 *   variants — a fresh baseline student vs 'with-lesson' (the lesson as a systemOverlay —
 *     exactly the policy-delta shape lib/replay's types name for transfer
 *     lessons). The fresh student "given the lesson" is the overlay run.
 *   cut — the first acting turn (first non-system/user turn): the student
 *     re-attempts the task from the original ask under the same model, context
 *     and rubric, with and without the lesson in its system prompt.
 *   verdict — perVariant mean judge composites; gate.ts decides.
 *
 * Routed through runGovernedReplay (FB-06's unattended consumer entrypoint):
 * the replay flag + `frontier:replay-harness` budget gate the battery, and
 * THAT path ledgers the battery spend — the transfer loop ledgers only its
 * own distillation spend, so no battery dollar is ever double-counted.
 */
import type { JudgeLlmCall } from '@papercusp/eval-battery';
import { createHash } from 'node:crypto';
import { computeOwnSourceHash } from '../scout/src-hash';
import {
  DEFAULT_REPLAY_RUBRIC,
  REPLAY_BATTERY_SOURCE_HASH,
  REPLAY_BASELINE_VARIANT,
  runGovernedReplay,
  type GovernedReplayResult,
  type ReplayBatteryConfig,
  type ReplayCase,
  type ReplayRunner,
  type ReplayTranscript,
  type ReplayVariant,
} from '../replay';
import type { TransferLesson, TransferReplayEvidence, TransferReplayPort } from './types';

export const WITH_LESSON_VARIANT_ID = 'with-lesson';
const TRANSFER_ADAPTER_SOURCE_HASH = computeOwnSourceHash(import.meta.url);
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The cut point for a transfer case: the first ACTING turn (the student
 *  takes over where the original agent started acting). Clamped to the valid
 *  cut range; callers should pre-filter degenerate transcripts (distill.ts
 *  already skips < 4 turns). */
export function pickTransferCutIndex(transcript: ReplayTranscript): number {
  const idx = transcript.turns.findIndex((t) => t.role !== 'system' && t.role !== 'user');
  const fallback = Math.floor(transcript.turns.length / 2);
  const cut = idx >= 1 ? idx : fallback;
  return Math.min(Math.max(cut, 1), Math.max(transcript.turns.length - 1, 1));
}

/** The with-lesson policy delta (the "fresh student given the lesson"). */
export function withLessonVariant(lesson: Pick<TransferLesson, 'lessonText' | 'title'>): ReplayVariant {
  return {
    variantId: WITH_LESSON_VARIANT_ID,
    label: lesson.title ?? 'with lesson',
    policy: {
      systemOverlay:
        'A lesson distilled from previous work on tasks like this — apply it where relevant:\n' +
        lesson.lessonText,
      note: 'transfer-harness student-transfer test (P-022)',
    },
  };
}

export interface TransferReplayAdapterDeps {
  workspaceId: string;
  runner: ReplayRunner;
  llmCall: JudgeLlmCall;
  /** Injectable for tests (default: the real runGovernedReplay). */
  runGoverned?: (
    q: { workspaceId: string; config: ReplayBatteryConfig; potSlug?: string | null },
    deps: { runner: ReplayRunner; llmCall: JudgeLlmCall; now(): number },
  ) => Promise<GovernedReplayResult>;
  /** Per-test battery spend cap (the governor's remaining budget clamps it further). */
  maxSpendUsd?: number;
  now?: () => number;
}

/** Bind lib/replay's battery as the tick's TransferReplayPort. */
export function transferReplayPort(deps: TransferReplayAdapterDeps): TransferReplayPort {
  const run = deps.runGoverned ?? runGovernedReplay;
  return async ({ lesson, transcript }) => {
    if (lesson.workspaceId !== deps.workspaceId || lesson.sourceRef !== transcript.ref) {
      throw new Error('transfer replay source does not match the lesson workspace/transcript');
    }
    const now = deps.now ?? Date.now;
    const startedAt = new Date(now()).toISOString();
    const replayCase: ReplayCase = {
      kind: 'historical',
      caseId: lesson.id,
      transcript,
      turnIndex: pickTransferCutIndex(transcript),
    };
    const config: ReplayBatteryConfig = {
      // Deterministic per test round: lesson id + how many tests it has had.
      batteryId: `transfer:${lesson.id}:t${lesson.testCount + 1}`,
      variants: [{ ...REPLAY_BASELINE_VARIANT, label: 'matched baseline' }, withLessonVariant(lesson)],
      cases: [replayCase],
      repeats: 1,
      baselineMode: 'matched',
      ...(deps.maxSpendUsd !== undefined ? { maxSpendUsd: deps.maxSpendUsd } : {}),
    };
    const invocations: TransferReplayEvidence['invocations'][number][] = [];
    const runner: ReplayRunner = async (input) => {
      const handle = await deps.runner(input);
      invocations.push({
        variantId: input.variant.variantId,
        systemPromptHash: hash(input.systemPrompt), contextHash: hash(input.contextText),
        model: handle.execution?.model ?? null, codeHash: handle.execution?.codeHash ?? null,
      });
      return handle;
    };
    const { verdict, result, reservation } = await run(
      { workspaceId: deps.workspaceId, config, potSlug: lesson.potSlug },
      { runner, llmCall: deps.llmCall, now },
    );
    if (!result) {
      throw new Error(
        `governed replay refused (${verdict.reason ?? 'unknown'}) — ` +
          'the replay substrate is not armed (its flag + frontier:replay-harness budget are P-001 acts)',
      );
    }
    const baseline = result.perVariant.find((v) => v.variantId === REPLAY_BASELINE_VARIANT.variantId);
    const withLesson = result.perVariant.find((v) => v.variantId === WITH_LESSON_VARIANT_ID);
    if (baseline?.meanComposite == null || withLesson?.meanComposite == null) {
      throw new Error(
        `battery ${result.batteryId} produced no scored pair ` +
          `(baseline=${baseline?.meanComposite ?? 'none'}, with-lesson=${withLesson?.meanComposite ?? 'none'})`,
      );
    }
    return {
      withComposite: withLesson.meanComposite,
      baselineComposite: baseline.meanComposite,
      batteryId: result.batteryId,
      costUsd: result.totalCostUsd,
      evaluation: {
        experiment: {
          batteryId: result.batteryId, testId: 'replay',
          baselineId: REPLAY_BASELINE_VARIANT.variantId, challengerId: WITH_LESSON_VARIANT_ID,
          taskHash: hash(replayCase),
          modelHash: invocations.length === 2 && invocations.every((v) => v.model !== null)
            ? hash({ students: invocations.map((v) => ({ variantId: v.variantId, model: v.model })), judge: DEFAULT_REPLAY_RUBRIC.model }) : null,
          promptHash: invocations.length === 2
            ? hash(invocations.map((v) => ({ variantId: v.variantId, systemPromptHash: v.systemPromptHash, contextHash: v.contextHash }))) : null,
          rubricHash: result.rubricHash,
          // The measured module hashes below do not yet cover the transport,
          // transcript renderer and judge engine. Do not label a subset complete.
          codeHash: null,
          repeats: config.repeats, startedAt, completedAt: new Date(now()).toISOString(),
        },
        reservation: reservation ?? null, outcomes: result.outcomes,
        budgetExhausted: result.budgetExhausted, invocations,
        loadedCode: { adapter: TRANSFER_ADAPTER_SOURCE_HASH, battery: REPLAY_BATTERY_SOURCE_HASH },
      },
    };
  };
}
