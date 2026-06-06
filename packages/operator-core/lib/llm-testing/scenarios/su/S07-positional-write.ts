/**
 * SU-S07 — positional write emit-correctness (token-efficient-agent-io P-013).
 *
 * Question: given a write tool advertised as a single `row` string whose column
 * order is declared in the prompt (here, the `row` arg description names
 * `id, state, harness?`), does the model EMIT a correctly-ordered positional row?
 *
 * The user asks to mark a work-item passed. The model must call
 * `work_items:set_state` with `row` = the VALUES in column order — `WI-42,passed`
 * (the trailing optional `harness` omitted). This is the load-bearing empirical
 * question behind the write side: the encoding is only safe if the model emits
 * correct rows. A mis-ordered / mislabeled row fails the gate.
 *
 * Load-bearing assert (ERROR): `work_items:set_state` was called with a `row`
 * whose first two comma-fields are exactly `WI-42` then `passed`.
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolCallEvent } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolMatch } from './_asserts';

/** Does this tool call set_state with a positional row reading WI-42, passed? */
function emitsCorrectRow(tc: ToolCallEvent): boolean {
  const canon = tc.name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
  if (canon !== 'work_items:set_state') return false;
  const row = (tc.input as Record<string, unknown> | null | undefined)?.row;
  if (typeof row !== 'string') return false;
  const fields = row.split(',').map((f) => f.trim());
  return fields[0] === 'WI-42' && fields[1] === 'passed';
}

export const SU_S07_POSITIONAL_WRITE: Scenario = {
  id: 'su-S07-positional-write',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to mark work item WI-42 as passed — it just cleared validation. The only tool for this (`work_items:set_state`) takes a single positional `row` argument whose column order (id, state, harness?) is declared in its arg description.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 3, maxWallSecs: 180, maxCostUsd: 1.5 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertToolMatch(emitsCorrectRow, {
      name: 'set-state-correct-positional-row',
      claim:
        'Expected `work_items:set_state` to be called with row="WI-42,passed" ' +
        '(VALUES in the prompt-declared column order id,state,harness? — trailing optional omitted).',
      suggestion:
        'The `row` arg is a positional CSV: emit only values, in the column order the description names; omit trailing optional columns.',
    }),
  ],
  rubric: SU_RUBRIC,
};

export default SU_S07_POSITIONAL_WRITE;
