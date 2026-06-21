/**
 * SU-S15 — code:run adoption at a SMALL batch (code-execution-tool-orchestration B-CX-3).
 *
 * Question: the headline win is biggest at large N, but batching even a FEW
 * per-item calls into one `code:run` still beats N inference round-trips (the
 * round-trip count, not the work, is what scales the token cost). When the user
 * names just 3 items to check, does the engineer STILL reach for `code:run`
 * rather than firing 3 individual `work_items:get` calls? This is the low-N end
 * of "reach for it a lot" — the threshold where adoption tends to lapse.
 *
 * Load-bearing assert (ERROR): `code:run` is called. Secondary (ERROR): at most
 * one direct `work_items:get` (a probe) — the rest belong in the script.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertToolCallCountAtMost } from './_asserts';
import { SMALL_BATCH_CONTEXT } from './_overrides';

export const SU_S15_CODE_RUN_SMALL_BATCH: Scenario = {
  id: 'su-S15-code-run-small-batch',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to check three specific work items (WI-301, WI-302, WI-303) and report which are blocked — a small per-item fan-out. Even at N=3 the engineer should collapse the per-item work_items:get loop into ONE code:run rather than issuing three separate tool calls (each its own inference round-trip).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 5, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-disagreement' },
  toolOverride: SMALL_BATCH_CONTEXT,
  asserts: [
    assertToolCalled(['code:run'], {
      name: 'reaches-for-code-run-small-batch',
      claim:
        'Expected the engineer to batch the 3 per-item checks into ONE code:run — even a small fan-out ' +
        'is cheaper as one script than 3 inference round-trips. code:run was never called.',
      suggestion: 'A few per-item calls is still the code:run shape: one script looping the gets, returning the blocked ids.',
    }),
    assertToolCallCountAtMost(['work_items:get'], 1, {
      name: 'does-not-hand-loop-small-batch',
      claim: 'The engineer fired the per-item work_items:get calls one at a time instead of batching them into code:run.',
      suggestion: 'Put the per-item gets inside one code:run loop; at most a single probe get belongs outside it.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S15_CODE_RUN_SMALL_BATCH;
