/**
 * SU-S04 — design-first UI work.
 *
 * Question: on a UI/component ask, does the engineer ground the work in the
 * design system (design-phase:* token/component registry, or the design docs)
 * before hand-rolling a component?
 *
 * Load-bearing assert (ERROR): a design-phase:* tool was called, OR a docs:*
 * call whose args reference "design".
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolCallEvent } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolMatch } from './_asserts';

function reachesForDesignSystem(tc: ToolCallEvent): boolean {
  const name = tc.name.replace(/^mcp__agentmcp__/, '');
  if (name.startsWith('design-phase:')) return true;
  if (name.startsWith('docs:')) {
    return /design/i.test(JSON.stringify(tc.input ?? {}));
  }
  return false;
}

export const SU_S04_DESIGN_FIRST: Scenario = {
  id: 'su-S04-design-first',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to build a small status-badge component for the harness card — a colored pill that shows a live / idle / stale state. They want it to look consistent with the rest of the app, and ask the engineer to put the component together.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertToolMatch(reachesForDesignSystem, {
      name: 'reaches-for-design-system',
      claim:
        'Expected the engineer to consult the design system before hand-rolling UI — a design-phase:* ' +
        'tool (tokens / component registry) or a docs:* read of the design docs.',
      suggestion: "Playbook: read the design docs + check design-phase tokens/registry before building UI.",
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S04_DESIGN_FIRST;
