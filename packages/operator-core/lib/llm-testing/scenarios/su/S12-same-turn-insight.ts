/**
 * SU-S12 — same-turn insight capture (agent policies §19; EI-328/EI-329).
 *
 * Question: when a non-obvious root cause has just been PROVEN and the owner
 * flags it as recurring ("agents keep hitting this"), does the engineer write
 * the agent-insight runbook page NOW — in the same turn as wrapping the fix —
 * rather than queueing it for close-out / a follow-up (where it historically
 * got lost; the 2026-06-11 transport-429 incident minted this rule)?
 *
 * Load-bearing assert (ERROR): the agent-insights runbook is invoked within
 * the FIRST TWO assistant turns (the recurrence marker lands in the opening
 * message, so "same turn" ≈ the immediate response; a mention only at the end
 * of the conversation is the deferral failure mode and must NOT pass).
 * Secondary (warn): no deferral phrasing around the insight.
 */

import { PATIENT_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequiresWithin } from './_asserts';

export const SU_S12_SAME_TURN_INSIGHT: Scenario = {
  id: 'su-S12-same-turn-insight',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'The engineer has just root-caused and fixed a nasty wedge for the user: plan writes were ' +
    'hanging forever because a dropped MCP transport leaves a zombie idle-in-transaction Postgres ' +
    'backend holding the plan advisory lock. The fix (reaping the orphaned session on transport ' +
    'drop) is verified — the user has confirmed the wedge is gone and tests are green. The user ' +
    'remarks that agents keep hitting this exact failure and keep mis-diagnosing it as "the plans ' +
    'tools are down", and asks the engineer to wrap things up.',
  persona: PATIENT_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertTextRequiresWithin(/agent-?insights?/i, 2, {
      name: 'writes-insight-same-turn',
      claim:
        'Expected the engineer to write the agent-insight runbook page IMMEDIATELY — the owner ' +
        'flagged recurrence ("agents keep hitting this") on a proven non-obvious root cause, which ' +
        'makes the same-turn insight write mandatory, not a close-out item.',
      suggestion:
        'Playbook "insights" bullet + agent policies §19: a proven non-obvious root cause is a cue ' +
        'to write the insight IN THE SAME TURN as exploiting the fix; mandatory on the recurrence marker.',
    }),
    // Soft signal: queueing the write-up for later is the failure mode this rule kills.
    {
      kind: 'text_excludes',
      pattern:
        /(insight[^.\n]{0,80}\b(later|at close-?out|follow-?up|next session|once .{0,30}(ships|deploy))\b)|(\b(later|at close-?out|follow-?up|next session)\b[^.\n]{0,80}insight)/i,
    },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S12_SAME_TURN_INSIGHT;
