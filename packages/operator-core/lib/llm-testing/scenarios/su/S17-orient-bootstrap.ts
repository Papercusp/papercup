/**
 * SU-S17 — reach for coord:orient at wake (tool-call-batching-wrappers P-008 / D-004).
 *
 * Question: at session start, when the engineer must orient (assignments + claimable
 * + inbox + plan-events + a memory recall + declare intent — the MANDATED bootstrap),
 * does it REACH for the ONE coord:orient { intent } bundle, or fan out the six
 * primitives (fleet:assignments + work_items:list + coord:inbox + coord:plan-events +
 * memory:search + coord:declare-intent) one round-trip at a time?
 *
 * Load-bearing assert (ERROR): coord:orient is called. Secondary: the bootstrap
 * primitives are NOT hand-fanned (they belong inside the one orient call).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolCallCountAtMost } from './_asserts';
import { ORIENT_BOOTSTRAP_CONTEXT } from './_overrides';

export const SU_S17_ORIENT_BOOTSTRAP: Scenario = {
  id: 'su-S17-orient-bootstrap',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    "A developer tells the engineer: you're starting your shift — get oriented before picking anything up. What are you assigned, what's claimable, any unread messages, what plans changed, and recall anything relevant to the gateway-retry work you're about to do — and declare that you're on it. This is the mandated session-bootstrap. The engineer should do it in ONE coord:orient { intent } call (which folds assignments + claimable + inbox + plan-events + a memory recall + the declare) rather than fanning out fleet:assignments + work_items:list + coord:inbox + coord:plan-events + memory:search + coord:declare-intent separately.",
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: ORIENT_BOOTSTRAP_CONTEXT,
  asserts: [
    assertToolCalled(['coord:orient'], {
      name: 'reaches-for-orient-at-wake',
      claim:
        'Expected the engineer to bootstrap with ONE coord:orient { intent } call (the mandated session-' +
        'bootstrap bundle) — coord:orient was never called.',
      suggestion:
        'At wake, call coord:orient { intent } — it returns assignments + claimable + inbox + plan-events + a memory recall AND declares your intent, in one round-trip.',
    }),
    assertToolCallCountAtMost(['fleet:assignments', 'coord:plan-events', 'coord:declare-intent'], 1, {
      name: 'does-not-hand-fan-the-bootstrap-primitives',
      claim:
        'The engineer fanned out the bootstrap primitives (fleet:assignments / coord:plan-events / ' +
        'coord:declare-intent) separately instead of folding them into the single coord:orient call.',
      suggestion: 'coord:orient bundles those — prefer it at wake over calling each primitive.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S17_ORIENT_BOOTSTRAP;
