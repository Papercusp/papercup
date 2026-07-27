/**
 * The audited substitution pairs (plan `bash-to-tool-substitution-2026-07-26`).
 *
 * This is the single list the equivalence test walks and, per D-002, the list
 * that seeds `harness_shared.bash_tool_substitutions` (P-018) — so a pair that
 * is not exported here is neither tested nor enforced, and a pair added here is
 * automatically both.
 */

import type { SubstitutionPair } from '../types';
import { AMBIENT_CONTEXT_PAIRS } from './ambient-context';
import { FILE_READ_PAIRS } from './file-read';
import { GIT_READ_PAIRS } from './git-read';
import { LOGS_PAIRS } from './logs';
import { POSTGRES_PAIRS } from './postgres';
import { PROCESS_PAIRS } from './process';
import { SERVICE_PAIRS } from './service';
import { TESTS_PAIRS } from './tests';
import { TYPECHECK_PAIRS } from './typecheck';

export {
  AMBIENT_CONTEXT_PAIRS,
  FILE_READ_PAIRS,
  GIT_READ_PAIRS,
  LOGS_PAIRS,
  POSTGRES_PAIRS,
  PROCESS_PAIRS,
  SERVICE_PAIRS,
  TESTS_PAIRS,
  TYPECHECK_PAIRS,
};

/**
 * Every audited pair, in registry order.
 *
 * NOTE this list is not "the pairs we enforce" — it is "the pairs we have
 * EVIDENCE about", positive or negative. `PROCESS_PAIRS` carries a
 * `not-a-substitute` verdict and exists so the conclusion is durable and
 * re-derived on every test run; the routing generator filters it out of
 * CLAUDE.md, and the DB's `tier_requires_equivalence` keeps it at `observe`.
 * `TESTS_PAIRS` carries both kinds at once — two equivalent shapes plus
 * `tests.affected`, recorded negative for the same reason.
 */
export const ALL_PAIRS: SubstitutionPair[] = [
  ...FILE_READ_PAIRS,
  ...POSTGRES_PAIRS,
  ...PROCESS_PAIRS,
  ...SERVICE_PAIRS,
  ...GIT_READ_PAIRS,
  ...TESTS_PAIRS,
  ...LOGS_PAIRS,
  ...TYPECHECK_PAIRS,
  // P-026/P-027. The only pairs whose replacement is NOT a tool call: the answer
  // already rides on coord:orient's `host` block, so the advisory says "read what
  // you already have" rather than naming a verb to call.
  ...AMBIENT_CONTEXT_PAIRS,
];
