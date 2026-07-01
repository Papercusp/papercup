/**
 * SN-D02 — buildable WORK still goes to the Queen, never through delegate-deep
 * (voice-unified-sentinel-pipeline-2026-07-01, P-007, D-003 — the other half of
 * the lane split SN-D01 tests).
 *
 * Question: when the user asks for something BUILDABLE ("add the export button,
 * fix the flaky test"), does the Sentinel keep routing it to the Queen
 * (<handoff_to_queen>) rather than mis-classifying it as a deep-thinking
 * delegation (<delegate_deep> would burn an ephemeral analysis agent on work
 * that needs PLACEMENT, and nothing would ever ship)?
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario, RunSummary, Violation } from '@papercusp/testing-shell/llm';
import { emitsHandoff } from './_asserts';

const DELEGATE_RE = /<delegate_deep/i;

/** NO assistant turn may emit `<delegate_deep>` for a buildable-work ask. */
function noDelegate(run: RunSummary): Violation[] {
  const idx = run.turns.findIndex((t) => DELEGATE_RE.test(t.assistantText));
  if (idx < 0) return [];
  return [
    {
      assertKind: 'custom:noDelegate',
      severity: 'error',
      evidenceTurnIdx: idx,
      claim: 'Sentinel routed buildable WORK through <delegate_deep> (the thinking lane).',
      suggestion:
        'delegate_deep is for questions expecting an ANSWER back in conversation. Buildable work ("build/fix/ship X") must go to the Queen via <handoff_to_queen> so it gets planned + placed.',
    },
  ];
}

export const SN_D02_WORK_NOT_DELEGATED: Scenario = {
  id: 'sn-D02-work-not-delegated',
  version: 1,
  target: 'sentinel',
  description:
    'A voice user asks the Sentinel for concrete buildable work (e.g. "add a CSV export button to the runs table and make sure it ships"). Success: the Sentinel routes it to the Queen via <handoff_to_queen> (files the work-item + nudges her) and says so. The judge must NOT reward emitting <delegate_deep> (that lane returns an ANSWER, it never ships work), attempting the build itself, or spawning a worker.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'emitsHandoff', eval: emitsHandoff },
    { kind: 'custom', name: 'noDelegate', eval: noDelegate },
    { kind: 'tool_not_called', name: 'fleet:spawn' },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};
