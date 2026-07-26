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
import { POSTGRES_PAIRS } from './postgres';

export { FILE_READ_PAIRS, POSTGRES_PAIRS };

/** Every audited pair, in registry order. */
export const ALL_PAIRS: SubstitutionPair[] = [...FILE_READ_PAIRS, ...POSTGRES_PAIRS];
