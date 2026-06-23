/**
 * SN02 — Sentinel does NOT hand off a quick, answerable question
 *
 * The guard against an over-eager Herald: a `<handoff_to_queen>` files a
 * high-priority work_item and nudges the Queen, so handing off a trivial
 * status/recall question would spam her queue. When the user asks something the
 * Sentinel can answer directly (live status, a quick recall), it answers in
 * voice and does NOT emit `<handoff_to_queen>`.
 *
 * Pairs with SN01 (the positive). Same `sentinel` target / raw-tag-in-stream
 * basis for the assertion (see SN01's header).
 *
 * sentinel-as-claude-tui-2026-06-22 — voice round-trip coverage.
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario, RunSummary, Violation } from '@papercusp/testing-shell/llm';

const HANDOFF_RE = /<handoff_to_queen/i;

/** Deterministic: NO assistant turn may emit `<handoff_to_queen>`. */
function noHandoff(run: RunSummary): Violation[] {
  const idx = run.turns.findIndex((t) => HANDOFF_RE.test(t.assistantText));
  if (idx < 0) return [];
  return [
    {
      assertKind: 'custom:noHandoff',
      severity: 'error',
      evidenceTurnIdx: idx,
      claim: 'Sentinel handed a quick, directly-answerable question off to the Queen.',
      suggestion:
        'Reserve <handoff_to_queen> for substantial multi-step work. Answer status / quick-recall questions directly in voice — a handoff files a high-priority work_item and nudges the Queen, so it must not fire on trivia.',
    },
  ];
}

export const SN02_NO_HANDOFF_TRIVIAL: Scenario = {
  id: 'sn-S02-no-handoff-trivial',
  version: 1,
  target: 'sentinel',
  description:
    'A voice user asks the Sentinel a quick, directly-answerable question (e.g. "what is the fleet up to right now?" / "how many agents are running?"). Success: the Sentinel answers in voice (consulting live status as needed) and does NOT emit <handoff_to_queen> — a handoff files a high-priority work-item and nudges the Queen, so it must be reserved for substantial multi-step work, not trivia. The judge should reward a crisp spoken answer and penalize escalating a simple question to the Queen.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 120, maxCostUsd: 0.8 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'noHandoff', eval: noHandoff },
    { kind: 'cost_under', usd: 0.8 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN02_NO_HANDOFF_TRIVIAL;
