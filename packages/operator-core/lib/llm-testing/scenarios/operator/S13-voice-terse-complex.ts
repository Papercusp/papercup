/**
 * S13 — voice terseness under a complex ask
 *
 * Even when the honest answer spans several facts, a voice-mode turn must stay
 * speakable: each <say> ≤220 chars, no markdown, ≤1 question per turn. Extends
 * M8 (casual/text) with a VOICE_USER + a deliberately broad, multi-part prompt
 * that tempts the brain into a long, list-y, markdown answer.
 *
 * P-019 of plan voice-production-test-coverage-2026-06-01.
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import { formatLength220, noMarkdownInSay, oneQuestionMarkPerTurn, noJargonInSay, groundedCountBeforeTool, noStrayBuiltinCalls } from '../../asserts/operator-format';
import type { Scenario } from '@papercusp/testing-shell/llm';

export const S13_VOICE_TERSE_COMPLEX: Scenario = {
  id: 'op-S13-voice-terse-complex',
  version: 1,
  target: 'operator',
  description:
    'A voice-mode user asks a broad, multi-part question ("what\'s going on across all my projects, and what should I tackle first?"). The honest answer spans several facts, but spoken output must stay speakable: each <say> ≤220 chars, no markdown (no lists/bold/headings/code), at most one question per turn.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 0.8 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    { kind: 'custom', name: 'formatLength220', eval: formatLength220 },
    { kind: 'custom', name: 'noMarkdownInSay', eval: noMarkdownInSay },
    { kind: 'custom', name: 'oneQuestionMarkPerTurn', eval: oneQuestionMarkPerTurn },
    { kind: 'custom', name: 'noJargonInSay', eval: noJargonInSay },
    { kind: 'custom', name: 'groundedCountBeforeTool', eval: groundedCountBeforeTool },
    { kind: 'custom', name: 'noStrayBuiltinCalls', eval: noStrayBuiltinCalls },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default S13_VOICE_TERSE_COMPLEX;
