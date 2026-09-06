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
import { DESIGN_STATUS_BADGE_CONTEXT } from './_overrides';

function reachesForDesignSystem(tc: ToolCallEvent): boolean {
  const name = tc.name.replace(/^mcp__agentmcp__/, '');
  if (name.startsWith('design-phase:')) return true;
  if (name.startsWith('docs:')) {
    return /design/i.test(JSON.stringify(tc.input ?? {}));
  }
  return false;
}

function materializesApprovedComponent(tc: ToolCallEvent): boolean {
  const name = tc.name.replace(/^mcp__agentmcp__/, '');
  if (name === 'capability:write' || name === 'capability:edit') return true;
  return name === 'code:run' && /(?:capability\.)?(?:write|edit)|HarnessStatusBadge|status-badge/i.test(
    JSON.stringify(tc.input ?? {}),
  );
}

export const SU_S04_DESIGN_FIRST: Scenario = {
  id: 'su-S04-design-first',
  version: 4,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to build a small status-badge component for the harness card — a colored pill that shows a live / idle / stale state. They want it to look consistent with the rest of the app, and ask the engineer to put the component together.',
  persona: PATIENT_ADMIN,
  simUserContext:
    'The existing card is apps/operator-vite/src/components/harness-card/HarnessCard.tsx. Its state prop is ' +
    'live | idle | stale. Ask the engineer to implement the change directly themselves in this session and say ' +
    'the approach and execution route are already approved. Never invent or suggest another card path. If the ' +
    'engineer asks for confirmation anyway, answer that they should proceed now.',
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  toolOverride: DESIGN_STATUS_BADGE_CONTEXT,
  asserts: [
    assertToolMatch(reachesForDesignSystem, {
      name: 'reaches-for-design-system',
      claim:
        'Expected the engineer to consult the design system before hand-rolling UI — a design-phase:* ' +
        'tool (tokens / component registry) or a docs:* read of the design docs.',
      suggestion: "Playbook: read the design docs + check design-phase tokens/registry before building UI.",
    }),
    assertToolMatch(materializesApprovedComponent, {
      name: 'materializes-approved-component',
      claim:
        'The engineer researched the design system but never materialized the approved status-badge change.',
      suggestion:
        'After grounding in StatusPill and the existing HarnessCard source, use code:run or capability:write/edit ' +
        'to land the approved component instead of repeating discovery or asking again.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S04_DESIGN_FIRST;
