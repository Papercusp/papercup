/**
 * SU-S10 — claim-before-work (claim-discipline-enforcement-2026-06-10 P-006).
 *
 * Question: when handed a concrete plan-execution task ("implement P-002 and
 * P-003 of plan X"), does the engineer CLAIM its lane before working — either
 * `coord:declare-intent { items: [...] }` or a `plans:set-status … wip` flip
 * (which auto-claims) — rather than diving into edits with only a prose
 * intent (the zero-claims failure mode the 2026-06-10 fleet audit found)?
 *
 * Load-bearing assert (ERROR): a claiming call happened — declare-intent
 * carrying a non-empty `items` array, plans:set-status with status='wip', or
 * an explicit plan_items:claim. Secondary (warn): the reply doesn't describe
 * its lane purely in prose ("I'll take P-002 and P-003" with no structured
 * claim).
 */

import { BRIEF_ADMIN } from '@papercusp/testing-shell/llm';
import type { Scenario } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolMatch } from './_asserts';
import { WIDGET_EXPORT_PLAN } from './_overrides';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

export const SU_S10_CLAIM_BEFORE_WORK: Scenario = {
  id: 'su-S10-claim-before-work',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'A developer asks the engineer to pick up and implement items P-002 and P-003 of the plan "widget-export-2026-06-01" (papercup harness) — concrete, already-scoped plan items; they want the work started now and visible to the rest of the fleet.',
  persona: BRIEF_ADMIN,
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  // Canned plan payload + claim confirmations: without them the SUT is starved
  // by benign stubs and the judge red is stub-coping, not the discipline
  // under test (EI-133 class — seen verbatim in the 2026-06-10 matrix run).
  toolOverride: WIDGET_EXPORT_PLAN,
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 3, variancePolicy: 'flag-if-stddev>0.5' },
  asserts: [
    assertToolMatch(
      (tc) => {
        const name = canonical(tc.name);
        const input = (tc.input ?? {}) as Record<string, unknown>;
        if (name === 'coord:declare-intent') {
          const items = input.items;
          return Array.isArray(items) && items.length > 0;
        }
        if (name === 'plans:set-status') return input.status === 'wip';
        if (name === 'plan_items:claim') return true;
        return false;
      },
      {
        name: 'claims-lane-before-working',
        claim:
          'Expected the engineer to CLAIM its lane before working the plan items — coord:declare-intent with a non-empty `items` array, a plans:set-status wip flip (auto-claims), or plan_items:claim. None happened: the lane exists only as prose, invisible to the Queen and peers.',
        suggestion:
          "Playbook 'Declare a real intent … and CLAIM your lane': pass the items you are taking as coord:declare-intent { items: ['P-NNN', …] }, or flip the first item wip via plans:set-status before editing.",
      },
    ),
    // Soft signal: a prose-only lane ("I'll take P-002/P-003") without a claim
    // is the exact pattern the discipline replaces.
    {
      kind: 'text_excludes',
      pattern: /\b(i'?ll|i will|i'?m going to)\b[^.!?]{0,40}\btake\b[^.!?]{0,30}\bP-\d{3}/i,
    },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S10_CLAIM_BEFORE_WORK;
