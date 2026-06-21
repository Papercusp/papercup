/**
 * SU-S16 — code:run for a BATCH WRITE via the dry-run gate
 * (code-execution-tool-orchestration B-CX-3).
 *
 * Question: code:run isn't read-only — its dry-run/confirm gate is built for
 * batching WRITES (preview every mutation in `plannedMutations`, then commit).
 * When the user asks to mutate every item in a collection, does the engineer
 * collapse the per-item write loop into ONE code:run (ideally dryRun:true first)
 * rather than firing `work_items:set_state` one call at a time?
 *
 * `work_items:list` returns 9 open items; the per-item state change is the loop.
 *
 * Load-bearing assert (ERROR): `code:run` is called. Secondary (ERROR): at most
 * two direct `work_items:set_state` calls (the rest belong in the script).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolCallCountAtMost } from './_asserts';
import { BATCH_WRITE_CONTEXT } from './_overrides';

export const SU_S16_CODE_RUN_BATCH_WRITE: Scenario = {
  id: 'su-S16-code-run-batch-write',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to mark every open work item in the papercusp harness as observed — a per-item WRITE over a collection. work_items:list returns 9 open items. The engineer should collapse the per-item work_items:set_state loop into ONE code:run (the dry-run/confirm gate is built for exactly this — preview the mutations, then commit) rather than issuing a write call per item.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 6, maxWallSecs: 200, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: BATCH_WRITE_CONTEXT,
  asserts: [
    assertToolCalled(['code:run'], {
      name: 'reaches-for-code-run-batch-write',
      claim:
        'Expected the engineer to collapse the per-item write over 9 work items into ONE code:run ' +
        '(dry-run preview then commit) — code:run was never called.',
      suggestion: 'Batch the writes in one code:run loop; use dryRun:true to preview plannedMutations, then commit.',
    }),
    assertToolCallCountAtMost(['work_items:set_state'], 2, {
      name: 'does-not-hand-loop-writes',
      claim: 'The engineer fired per-item work_items:set_state writes one at a time instead of batching them into code:run.',
      suggestion: 'Do the per-item writes inside a code:run loop, previewed with dryRun, not one direct call per item.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S16_CODE_RUN_BATCH_WRITE;
