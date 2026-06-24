/**
 * SU-S27 — woke to a DIRECTED dispatch → CLAIM + WORK it, never read-and-repark.
 * (fleet-dispatch-wake-clarity-2026-06-22 P-003.)
 *
 * The BEHAVIORAL leg of P-003. The presence test (prompt-build / playbook-shape) asserts the
 * "Woke to a DIRECTED assignment? CLAIM + WORK it" directive is IN the su playbook; THIS asserts
 * the agent BEHAVES on it. Motivating real failure (the plan's own dogfood): two agents were woken
 * with a directed dispatch in their inbox — su-3be8 woke→claimed→worked, but su-6ef6
 * woke→read→reparked. A reparked dispatch silently black-holes: the coordinator saw `woken:1` and
 * assumed pickup, but nothing happened.
 *
 * Setup (tool world): the su agent has just been woken. Its coord:orient shows a DIRECTED dispatch
 * from a coordinator (su-815e2) assigning it fleet-dispatch P-001..P-004, and those items sit in
 * its plan_items:my_items / claimable lane. SUCCESS = it CLAIMS the lane this turn (plan_items:convert
 * / work_items:claim / coord:declare-intent { items } / plans:set-status wip) and starts working it.
 * FAILURE = it reads the assignment, acknowledges, and re-parks (coord:await-inbox / ends the turn)
 * without claiming — the su-6ef6 read-and-repark.
 *
 * Load-bearing assert (ERROR): a claim verb fired. The text-forbids is a NARROW guard on the
 * explicit "I'll just wait / await further instructions / re-parking" repark language; the
 * SU_RUBRIC + description carry the behavioral judgment.
 */
import { PASS_THROUGH } from '@papercusp/testing-shell/llm';
import type { Scenario, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertToolCalled, assertTextForbids } from './_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

/** Deterministic world: a wake whose orient/inbox carries a directed dispatch + the dispatched
 *  items as a claimable lane. The claim verbs all succeed; coord:await-inbox is offered (so
 *  re-parking is a real, tempting alternative the agent must NOT take instead of claiming). */
const DISPATCH_WORLD: ToolDispatchOverride = {
  override(name) {
    const canon = canonical(name);
    if (canon === 'coord:orient') {
      return {
        content: [
          {
            text: JSON.stringify({
              ok: true,
              me: { summary: { claims: 0, work_item_load: 0 }, agents: [{ agentId: 'su-self', claims: [], queued: [] }] },
              claimable: [
                { id: 'WI-501', kind: 'feature', title: 'fleet-dispatch P-001 presence wakeable', state: 'todo', payload: { plan_item: { item_id: 'P-001', plan_slug: 'fleet-dispatch-wake-clarity-2026-06-22', harness_slug: 'papercusp' } } },
                { id: 'WI-502', kind: 'feature', title: 'fleet-dispatch P-002 coord:dispatch', state: 'todo', payload: { plan_item: { item_id: 'P-002', plan_slug: 'fleet-dispatch-wake-clarity-2026-06-22', harness_slug: 'papercusp' } } },
              ],
              inbox: {
                summary: { total: 1, returned: 1 },
                recent: [
                  { from: 'su-815e2', kind: 'message', summary: 'DISPATCH → you: take fleet-dispatch-wake-clarity P-001..P-004 and work them now (lane assigned to you).' },
                ],
              },
              intentDeclared: true,
            }),
          },
        ],
      };
    }
    if (canon === 'plan_items:my_items') {
      return {
        content: [
          {
            text: JSON.stringify({
              items: [
                { plan: 'fleet-dispatch-wake-clarity-2026-06-22', item: 'P-001', assignee: 'su-self', assignedBy: 'su-815e2', status: 'todo' },
                { plan: 'fleet-dispatch-wake-clarity-2026-06-22', item: 'P-002', assignee: 'su-self', assignedBy: 'su-815e2', status: 'todo' },
              ],
            }),
          },
        ],
      };
    }
    // The claim/pickup verbs all succeed (the agent SHOULD reach one of these this turn).
    if (
      canon === 'plan_items:convert' ||
      canon === 'work_items:claim' ||
      canon === 'plan_items:claim' ||
      canon === 'coord:declare-intent' ||
      canon === 'plans:set-status'
    ) {
      return { content: [{ text: JSON.stringify({ ok: true, claimed: ['P-001', 'P-002'] }) }] };
    }
    if (canon === 'work_items:set_state' || canon === 'work_items:checkpoint') {
      return { content: [{ text: JSON.stringify({ ok: true }) }] };
    }
    if (canon === 'work_items:get' || canon === 'work_items:list' || canon === 'plans:get' || canon === 'plans:get-item') {
      return { content: [{ text: JSON.stringify({ ok: true, items: [] }) }] };
    }
    // The tempting repark alternative — available, but taking it INSTEAD of claiming is the failure.
    if (canon === 'coord:await-inbox') return { content: [{ text: JSON.stringify({ ok: true, watching: true }) }] };
    return PASS_THROUGH;
  },
};

export const SU_S27_WOKE_TO_DISPATCH_CLAIMS: Scenario = {
  id: 'su-S27-woke-to-dispatch-claims',
  version: 1,
  target: 'su',
  transport: 'in-process',
  description:
    'The su engineer has just been WOKEN from idle. When it orients, it finds a DIRECTED dispatch: a ' +
    'coordinator (su-815e2) assigned it the fleet-dispatch-wake-clarity lane P-001..P-004, and those ' +
    'items are in its claimable assignments / plan_items:my_items. SUCCESS: the engineer CLAIMS the ' +
    'dispatched lane THIS turn — plan_items:convert / work_items:claim / coord:declare-intent { items } ' +
    '/ plans:set-status wip — and starts working it (it does not just acknowledge and go back to sleep). ' +
    'FAILURE: it reads the dispatch, says it will get to it / awaits further instruction / re-parks via ' +
    'coord:await-inbox or ends the turn WITHOUT claiming — the read-and-repark that silently black-holes ' +
    'the dispatch (the coordinator saw woken:1 and assumes pickup). Reward claiming + working the ' +
    'directed lane decisively; penalize reading-then-reparking without taking the claim.',
  persona: {
    id: 'coordinator-dispatch',
    description:
      'A fleet coordinator who just dispatched a lane to this agent and woke it. Terse, factual; it ' +
      'confirms the lane was assigned and to pick it up, but never tells the agent WHICH tool to claim with.',
    traits: {
      verbosity: 'terse',
      politeness: 'neutral',
      clarification: 'never_clarifies',
      goalClarity: 'precise',
      interrupts: false,
      modality: 'text',
      domain: 'admin',
    },
  },
  goal: { kind: 'user_satisfied', declaredBy: 'sim_user' },
  caps: { maxTurns: 4, maxWallSecs: 240, maxCostUsd: 2.0 },
  runMatrix: { repeat: 2, variancePolicy: 'flag-if-disagreement' },
  toolOverride: DISPATCH_WORLD,
  asserts: [
    assertToolCalled(['plan_items:convert', 'work_items:claim', 'plan_items:claim', 'coord:declare-intent', 'plans:set-status'], {
      name: 'claims-the-dispatched-lane',
      claim:
        'The agent woke to a DIRECTED dispatch (fleet-dispatch P-001..P-004 assigned to it) but never claimed it ' +
        '— no plan_items:convert / work_items:claim / coord:declare-intent / plans:set-status wip fired. That is ' +
        'the read-and-repark that black-holes a dispatch the coordinator already counted as woken:1.',
      suggestion:
        "su-power/su-engineer playbook 'Woke to a DIRECTED assignment? CLAIM + WORK it': orient → see the lane → " +
        'claim it (plan_items:convert / work_items:claim / coord:declare-intent { items }) and work it THIS turn.',
    }),
    assertTextForbids(
      /\b(i'?ll\s+(get to|pick (it|this) up|start)\b[^.?!]{0,40}\b(later|next turn|soon|after)|await(ing)?\s+(further|more)\s+(instruction|direction|detail)|going back to (sleep|idle|park)|re-?park(ing)?|let me know\b[^.?!]{0,40}\bwhen\b)/i,
      {
        name: 'no-read-and-repark',
        claim:
          'The agent acknowledged the dispatch but deferred / re-parked / awaited more instruction instead of ' +
          'claiming + working it now — the exact su-6ef6 read-and-repark P-003 guards against.',
        suggestion:
          'A directed dispatch is a turn to ACT: claim the lane and work it this turn; only repark if the lane is ' +
          'genuinely blocked (record it blocked first) or a live peer already holds the claim.',
      },
    ),
    { kind: 'cost_under', usd: 2.0 },
  ],
  rubric: SU_RUBRIC,
};

export default SU_S27_WOKE_TO_DISPATCH_CLAIMS;
