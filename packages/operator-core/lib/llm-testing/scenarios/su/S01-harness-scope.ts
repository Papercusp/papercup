/**
 * SU-S01 — harness-scope.
 *
 * Question: at operator (no-harness) scope, when a user asks a vague
 * "show me the plan / the docs" question, does the engineer DECIDE the
 * scope and pass a `harness` arg (`'all'` for Papercusp's own plans/docs,
 * else a slug) rather than stalling on `harness_required`?
 *
 * This is the exact confusion the playbook's "Scope" section fixes: a
 * missing harness is "you haven't said which yet, so decide and pass it",
 * never "this session can't".
 *
 * Load-bearing assert (ERROR): a docs:* or plans:* call carried a non-empty
 * `harness` arg. Secondary (warn): the reply doesn't surface `harness_required`
 * as a dead-end.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolGroupWithStringArg } from './_asserts';

export const SU_S01_HARNESS_SCOPE: Scenario = {
  id: 'su-S01-harness-scope',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer, working at operator (no-harness) scope, asks the engineer to bring them up to speed on the spec-md deprecation cleanup work — they want to see the relevant plan and the related docs. They do not name a harness slug; they just want a quick orientation on where that work stands.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertToolGroupWithStringArg(['docs', 'plans'], 'harness', {
      name: 'docs-or-plans-with-harness-scope',
      claim:
        'Expected a docs:* or plans:* call carrying a non-empty `harness` scope arg ' +
        "(the engineer should decide the scope — `'all'` or a slug — not stall on harness_required).",
      suggestion:
        "Playbook 'Scope': a missing harness means decide + pass one (harness:'all' for Papercusp's own docs/plans).",
    }),
    // Soft signal: the engineer shouldn't treat harness_required as a dead-end.
    { kind: 'text_excludes', pattern: /harness_required/i },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S01_HARNESS_SCOPE;
