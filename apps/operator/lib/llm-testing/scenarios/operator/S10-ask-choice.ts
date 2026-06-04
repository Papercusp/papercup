/**
 * S10 — ask-choice
 *
 * Persona: vague admin asking an ambiguous question.
 *          ("I want to do something about the issues — what should I work on first?")
 *
 * Goal: push the operator to emit a `chat:ask_choice` card (or a
 *       bespoke `ctx.askUser` card) rather than guessing a single
 *       answer or asking a follow-up in free text.
 *
 * Covers: B11 (chat:ask_choice card emission) — judge's cardUsage axis
 *         scores this qualitatively too.
 */

import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S10_ASK_CHOICE: Scenario = {
  id: 'op-S10-ask-choice',
  version: 1,
  target: 'operator',
  description:
    'A user asks an ambiguous question with multiple reasonable answers. The operator should emit a choice card (chat:ask_choice or a bespoke askUser card) rather than guessing or asking via free-text question.',
  persona: {
    id: 'vague-prompter',
    description: 'User asks intentionally ambiguous prompts to push for card-based clarification.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'vague',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  goal: { kind: 'card_emitted', cardKind: 'choice' },
  caps: { maxTurns: 4, maxWallSecs: 60, maxCostUsd: 0.6 },
  runMatrix: { repeat: 5, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    // Either a 'choice'-kind card or any voice-answerable card — both
    // satisfy the "use a card, don't free-text-ask" expectation.
    { kind: 'card_emitted', cardKind: 'choice' },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S10_ASK_CHOICE;
