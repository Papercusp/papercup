/**
 * The audited substitution pairs (plan `bash-to-tool-substitution-2026-07-26`).
 *
 * This is the single list the equivalence test walks and, per D-002, the list
 * that seeds `harness_shared.bash_tool_substitutions` (P-018) — so a pair that
 * is not exported here is neither tested nor enforced, and a pair added here is
 * automatically both.
 */

import type { SubstitutionPair } from '../types';
import { FILE_READ_PAIRS } from './file-read';
import { GIT_READ_PAIRS } from './git-read';
import { POSTGRES_PAIRS } from './postgres';
import { PROCESS_PAIRS } from './process';
import { SERVICE_PAIRS } from './service';

export { FILE_READ_PAIRS, GIT_READ_PAIRS, POSTGRES_PAIRS, PROCESS_PAIRS, SERVICE_PAIRS };

/**
 * Every audited pair, in registry order.
 *
 * NOTE this list is not "the pairs we enforce" — it is "the pairs we have
 * EVIDENCE about", positive or negative. `PROCESS_PAIRS` carries a
 * `not-a-substitute` verdict and exists so the conclusion is durable and
 * re-derived on every test run; the routing generator filters it out of
 * CLAUDE.md, and the DB's `tier_requires_equivalence` keeps it at `observe`.
 */
export const ALL_PAIRS: SubstitutionPair[] = [
  ...FILE_READ_PAIRS,
  ...POSTGRES_PAIRS,
  ...PROCESS_PAIRS,
  ...SERVICE_PAIRS,
  ...GIT_READ_PAIRS,
];
