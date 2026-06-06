/**
 * SU-S08 — compact (headerless CSV) read-correctness (token-efficient-agent-io
 * P-013).
 *
 * Question: given a tool whose result arrives as HEADERLESS CSV — a `[N]` count
 * line then rows of VALUES in a prompt-declared column order — does the model
 * map row positions to columns correctly when answering a question about a
 * specific cell?
 *
 * `audit:list` returns (via override) three rows in column order
 * id,ts,actor,action,subject. The user asks who the ACTOR was on the entry whose
 * ACTION was `locks:acquire`. The correct answer requires reading column 4
 * (action) to find the row, then column 3 (actor) of that row → `bob`. A
 * column-shifted misread would answer `alice`/`carol`, failing the gate.
 *
 * Load-bearing assert (ERROR): the reply names `bob`. Secondary (ERROR): it does
 * NOT name the decoy actors, catching a column-shift misread.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextRequires, assertTextForbids } from './_asserts';
import { AUDIT_CSV_RESULT } from './_overrides';

export const SU_S08_COMPACT_READ: Scenario = {
  id: 'su-S08-compact-read',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to check recent audit events and tell them who performed the lock acquisition — i.e. the actor on the entry whose action is `locks:acquire`. The audit:list result comes back as headerless CSV (a [N] count line then rows of values in column order id,ts,actor,action,subject).',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  // audit:list returns a fixed 3-row headerless CSV.
  toolOverride: AUDIT_CSV_RESULT,
  asserts: [
    assertTextRequires(/\bbob\b/i, {
      name: 'reads-correct-actor-from-csv',
      claim:
        'Expected the reply to name `bob` — the actor (col 3) of the row whose action (col 4) is `locks:acquire`, ' +
        'read positionally from the headerless CSV.',
      suggestion:
        'Map each value to the prompt-declared columns id,ts,actor,action,subject; find the row where action=locks:acquire, then report its actor.',
    }),
    assertTextForbids(/\b(alice|carol)\b/i, {
      name: 'no-column-shift-misread',
      claim:
        'The reply named a decoy actor (alice/carol) — a column-shift misread of the headerless CSV ' +
        '(those are the actors of the OTHER two rows).',
      suggestion: 'Re-map the columns: actor is the 3rd value, action the 4th; only the locks:acquire row matters.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S08_COMPACT_READ;
