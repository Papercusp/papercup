/**
 * SU-S13 — code:run batch adoption (code-execution-tool-orchestration B-CX-3).
 *
 * Question: when a task is the canonical "do X for each of N" shape — list a
 * collection, then make a per-item tool call over all of it — does the engineer
 * REACH for `code:run` (collapsing the N round-trips into one orchestration
 * script) instead of hand-looping the per-item tool one call at a time?
 *
 * The user asks for the BLOCKED open work items + why. `work_items:list` returns
 * 12 items WITHOUT per-item state (override), so answering requires a
 * `work_items:get` over all 12 — exactly the loop the playbook's CODE_RUN_NUDGE
 * says to script. The smart path is: (optionally) list, then ONE `code:run` whose
 * script loops the gets and returns the blocked ids; the lazy path hand-loops
 * `work_items:get` (and hits the turn cap).
 *
 * Load-bearing assert (ERROR): `code:run` is called. Secondary (ERROR): the
 * engineer does NOT hand-loop `work_items:get` more than a couple times directly
 * (it batched the loop into the script instead).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolCallCountAtMost } from './_asserts';
import { CODE_RUN_BATCH_CONTEXT } from './_overrides';

export const SU_S13_CODE_RUN_BATCH: Scenario = {
  id: 'su-S13-code-run-batch',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer: for the papercusp harness, go through all the open work items and tell me which ones are blocked and why. work_items:list returns 12 open items without per-item state, so the blocked check requires a work_items:get over all 12 — a "do X for each of N" loop. The engineer should collapse that into ONE code:run orchestration script (optionally fetching the signatures via code:tools first) rather than hand-looping work_items:get one call at a time.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: CODE_RUN_BATCH_CONTEXT,
  asserts: [
    assertToolCalled(['code:run'], {
      name: 'reaches-for-code-run-on-batch',
      claim:
        'Expected the engineer to collapse the per-item loop over 12 work items into ONE code:run ' +
        'orchestration script (the CODE_RUN_NUDGE "do X for each of N" case) — code:run was never called.',
      suggestion:
        'When a task loops a per-item tool over a collection, write one code:run script (tools.work_items.get in a for-loop returning the blocked ids) instead of issuing a tool call per item.',
    }),
    assertToolCallCountAtMost(['work_items:get'], 2, {
      name: 'does-not-hand-loop-per-item-get',
      claim:
        'The engineer hand-looped work_items:get one call at a time instead of batching the loop ' +
        'into a code:run script — exactly the round-trip-per-item cost code:run exists to remove.',
      suggestion:
        'Do the per-item get inside a code:run loop; a couple of direct probe gets are fine, but the bulk should run in the script.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S13_CODE_RUN_BATCH;
