/**
 * SN01 — Sentinel hands a planning-scale ask off to the Mug
 *
 * Question: when a VOICE user asks the Sentinel for substantial, multi-step
 * work that needs planning + placement (NOT a quick status answer), does the
 * Sentinel ROUTE it to the Mug via `<handoff_to_mug>` rather than trying to
 * plan/place/do it itself? The Sentinel talks, suggests, files + nudges; the
 * Mug acts (sentinel.persona.md — "you suggest and hand off; you never place
 * work yourself").
 *
 * Why we can assert on the tag: the agent-mcp/operator-converse route streams
 * the assistant turn RAW (the client strips control tags for display; the
 * server re-parses the assembled turn to dispatch the handoff — file a
 * high-priority user-requested work_item + nudge the Mug, converse.ts ~L504).
 * So `<handoff_to_mug` appears in the harness's accumulated assistantText.
 * Honored ONLY for role==='sentinel', which is why this runs on the `sentinel`
 * target (the operator target can never trigger it).
 *
 * sentinel-as-claude-tui-2026-06-22 — voice round-trip coverage (the voice→
 * Sentinel→Mug handoff path; the full real-mic round-trip stays a manual
 * agent-e2e check, there being no mic/STT/EL in CI).
 */
import { VOICE_USER } from '@papercusp/testing-shell/llm';
import { OPERATOR_RUBRIC } from '../../rubrics/operator';
import type { Scenario, RunSummary, Violation } from '@papercusp/testing-shell/llm';

const HANDOFF_RE = /<handoff_to_mug/i;

/** Deterministic: SOME assistant turn must emit `<handoff_to_mug>`. */
function emitsHandoff(run: RunSummary): Violation[] {
  const fired = run.turns.some((t) => HANDOFF_RE.test(t.assistantText));
  if (fired) return [];
  return [
    {
      assertKind: 'custom:emitsHandoff',
      severity: 'error',
      evidenceTurnIdx: Math.max(0, run.turns.length - 1),
      claim: 'Sentinel never emitted <handoff_to_mug> for a planning-scale ask.',
      suggestion:
        'Substantial multi-step work must be routed to the Mug via <handoff_to_mug> (which files a high-priority work_item + nudges her), not planned/placed/executed by the Sentinel itself.',
    },
  ];
}

export const SN01_HANDOFF_PLANNING_ASK: Scenario = {
  id: 'sn-S01-handoff-planning-ask',
  version: 1,
  target: 'papercup',
  description:
    'A voice user asks the Sentinel for substantial, multi-step work that needs the Mug to plan and place it (e.g. "I want to redesign the whole onboarding flow end to end — can you get that going for me?"). Success: the Sentinel does NOT plan, spawn, or execute the work itself; it routes the work to the Mug by emitting <handoff_to_mug> (which the server files as a high-priority user-requested work-item and nudges the Mug), and its spoken reply tells the user it has been handed to the Mug. The judge must NOT reward the Sentinel attempting the work, proposing a detailed plan itself, or spawning a worker — only acknowledging + handing off. Quick offers ("want me to hand that to the Mug?") followed by the user agreeing and the Sentinel then handing off are ideal.',
  persona: VOICE_USER,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 150, maxCostUsd: 1.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  asserts: [
    { kind: 'custom', name: 'emitsHandoff', eval: emitsHandoff },
    // The Sentinel must NEVER place work itself — its envelope denies cup:spawn,
    // and a stray spawn would mean it tried to do the Mug's job.
    { kind: 'tool_not_called', name: 'cup:spawn' },
    { kind: 'cost_under', usd: 1.0 },
  ],
  rubric: OPERATOR_RUBRIC,
};

export default SN01_HANDOFF_PLANNING_ASK;
