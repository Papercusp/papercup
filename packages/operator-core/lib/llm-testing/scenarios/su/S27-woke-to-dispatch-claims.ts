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
import type { Scenario, ToolCallEvent, ToolDispatchOverride } from '@papercusp/testing-shell/llm';

import { SU_RUBRIC } from '../../rubrics/su';
import { assertTextForbids, assertToolCalledWithin, assertToolMatch } from './_asserts';

function canonical(name: string): string {
  return name.replace(/^mcp__agentmcp__/, '').replace(/^mcp__[a-z0-9-]+__/i, '');
}

const DISPATCH_PLAN_SLUG = 'fleet-dispatch-wake-clarity-2026-06-22';
const DISPATCH_ITEMS = [
  {
    planItemId: 'P-001',
    workItemId: 'WI-501',
    title: 'Presence wake is independently verifiable',
    acceptance: 'Document which coord:presence field and follow-up read prove that a recipient actually took a turn.',
  },
  {
    planItemId: 'P-002',
    workItemId: 'WI-502',
    title: 'coord:dispatch assigns, delivers, and wakes atomically',
    acceptance: 'Document the assignment/delivery/wake receipt and the targeted retry when only the real-time wake misses.',
  },
  {
    planItemId: 'P-003',
    workItemId: 'WI-503',
    title: 'Directed wake requires immediate claim and work',
    acceptance: 'Document claim-now behavior plus the narrow claim-conflict and genuine-block exceptions.',
  },
  {
    planItemId: 'P-004',
    workItemId: 'WI-504',
    title: 'Pickup confirmation distinguishes delivery from execution',
    acceptance: 'Document separate evidence for delivered, woken, claimed, started, and completed.',
  },
] as const;

const DISPATCH_PLAN_ITEM_IDS = DISPATCH_ITEMS.map((item) => item.planItemId);
const DISPATCH_WORK_ITEM_IDS = DISPATCH_ITEMS.map((item) => item.workItemId);

const EXISTING_DISPATCH_DOCS = [
  {
    slug: 'playbook/fleet-dispatch',
    title: 'Fleet dispatch',
    body:
      'coord:dispatch assigns a lane and sends a message. The current page calls any woken:1 response ' +
      '"pickup confirmed" and does not distinguish durable delivery from execution.',
  },
  {
    slug: 'playbook/wake-semantics',
    title: 'Wake semantics',
    body:
      'A sender may request wake:"required". This page does not say which coord:presence transition ' +
      'independently proves a turn ran, or what to do for recipient_alive_not_wakeable versus recipient_dead.',
  },
] as const;

function jsonResult(value: unknown) {
  return { content: [{ text: JSON.stringify(value) }] };
}

function validPlanItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && DISPATCH_PLAN_ITEM_IDS.includes(item as typeof DISPATCH_PLAN_ITEM_IDS[number]),
  );
}

/** A claim-shaped call only counts when it names a real item from this dispatch.
 *  This prevents an empty coord:declare-intent (or a status read) from satisfying
 *  the behavioral gate merely because it used a claim-capable tool name. */
function startsClaimingDispatch(tc: ToolCallEvent): boolean {
  const name = canonical(tc.name);
  const input = (tc.input ?? {}) as Record<string, unknown>;
  if (name === 'coord:orient') {
    return input.planSlug === DISPATCH_PLAN_SLUG && validPlanItems(input.planItems).length > 0;
  }
  if (name === 'coord:declare-intent') {
    return input.current_plan_slug === DISPATCH_PLAN_SLUG && validPlanItems(input.items).length > 0;
  }
  if (name === 'work_items:claim') {
    const id = typeof input.row === 'string' ? input.row.split(',')[0]?.trim() : '';
    return DISPATCH_WORK_ITEM_IDS.includes(id as typeof DISPATCH_WORK_ITEM_IDS[number]);
  }
  if (name === 'plan_items:claim') {
    return input.plan === DISPATCH_PLAN_SLUG && DISPATCH_PLAN_ITEM_IDS.includes(input.item as typeof DISPATCH_PLAN_ITEM_IDS[number]);
  }
  if (name === 'plans:set-status') {
    return input.slug === DISPATCH_PLAN_SLUG && input.status === 'wip' &&
      DISPATCH_PLAN_ITEM_IDS.includes(input.itemId as typeof DISPATCH_PLAN_ITEM_IDS[number]);
  }
  if (name === 'plan_items:convert') {
    return validPlanItems(input.items).length > 0 ||
      DISPATCH_PLAN_ITEM_IDS.includes(input.item as typeof DISPATCH_PLAN_ITEM_IDS[number]);
  }
  return false;
}

/** Deterministic world: a wake whose orient/inbox carries a directed dispatch + the dispatched
 *  items as a claimable lane. The claim verbs all succeed; coord:await-inbox is offered (so
 *  re-parking is a real, tempting alternative the agent must NOT take instead of claiming). */
export const S27_DISPATCH_WORLD: ToolDispatchOverride = {
  override(name, args) {
    const canon = canonical(name);
    const input = (args ?? {}) as Record<string, unknown>;
    if (canon === 'coord:orient') {
      const claimed = input.planSlug === DISPATCH_PLAN_SLUG ? validPlanItems(input.planItems) : [];
      return jsonResult({
        ok: true,
        me: {
          summary: { claims: claimed.length, work_item_load: claimed.length },
          agents: [{ agentId: 'su-self', claims: claimed, queued: DISPATCH_WORK_ITEM_IDS }],
        },
        claimable: DISPATCH_ITEMS.map((item) => ({
          id: item.workItemId,
          kind: 'feature',
          title: item.title,
          state: 'todo',
          payload: {
            plan_item: {
              item_id: item.planItemId,
              plan_slug: DISPATCH_PLAN_SLUG,
              harness_slug: 'papercusp',
            },
          },
        })),
        inbox: {
          summary: { total: 1, returned: 1 },
          recent: [{
            from: 'su-815e2',
            kind: 'dispatch',
            summary: `DISPATCH → you: take ${DISPATCH_PLAN_SLUG} P-001..P-004 and work them now (lane assigned to you).`,
            planSlug: DISPATCH_PLAN_SLUG,
            planItems: DISPATCH_PLAN_ITEM_IDS,
          }],
        },
        intentDeclared: typeof input.intent === 'string' && input.intent.length > 0,
        claims: { claimed, alreadyHeld: [], conflicts: [], released: [] },
      });
    }
    if (canon === 'plan_items:my_items') {
      return jsonResult({
        items: DISPATCH_ITEMS.map((item) => ({
          plan: DISPATCH_PLAN_SLUG,
          item: item.planItemId,
          workItemId: item.workItemId,
          assignee: 'su-self',
          assignedBy: 'su-815e2',
          status: 'todo',
        })),
      });
    }
    if (canon === 'plans:get') {
      return jsonResult({
        slug: DISPATCH_PLAN_SLUG,
        frontmatter: { title: 'Fleet dispatch wake clarity', status: 'active' },
        now: {
          state: 'P-001 through P-004 are assigned to su-self and ready to start.',
          next: 'Claim the four-item lane and begin P-001 now.',
        },
        items: DISPATCH_ITEMS.map((item) => ({
          id: item.planItemId,
          text: item.title,
          acceptanceCriteria: item.acceptance,
          status: 'todo',
          workItemId: item.workItemId,
          assignee: 'su-self',
        })),
        decisions: [],
      });
    }
    if (canon === 'plans:list' || canon === 'plans:search') {
      return jsonResult({
        plans: [{
          slug: DISPATCH_PLAN_SLUG,
          title: 'Fleet dispatch wake clarity',
          status: 'active',
          itemCount: DISPATCH_ITEMS.length,
        }],
      });
    }
    if (canon === 'work_items:get' || canon === 'work_items:list') {
      const selectedIds = typeof input.id === 'string'
        ? [input.id]
        : Array.isArray(input.ids)
          ? input.ids.filter((id): id is string => typeof id === 'string')
          : DISPATCH_WORK_ITEM_IDS;
      const workItems = DISPATCH_ITEMS
        .filter((item) => selectedIds.includes(item.workItemId))
        .map((item) => ({
          id: item.workItemId,
          kind: 'feature',
          title: item.title,
          state: 'open',
          assignee: null,
          payload: {
            plan_item: {
              item_id: item.planItemId,
              plan_slug: DISPATCH_PLAN_SLUG,
              harness_slug: 'papercusp',
            },
            acceptance: item.acceptance,
          },
        }));
      if (canon === 'work_items:list') return jsonResult({ ok: true, items: workItems });
      return jsonResult({
        ok: true,
        results: workItems.map((workItem) => ({ ok: true, id: workItem.id, workItem })),
      });
    }
    if (canon === 'docs:search') {
      return jsonResult({
        ok: true,
        results: EXISTING_DISPATCH_DOCS.map((doc) => ({
          slug: doc.slug,
          title: doc.title,
          excerpt: doc.body,
        })),
      });
    }
    if (canon === 'docs:outline') {
      return jsonResult({
        ok: true,
        documents: EXISTING_DISPATCH_DOCS.map((doc) => ({ slug: doc.slug, title: doc.title })),
      });
    }
    if (canon === 'docs:get') {
      const requested = Array.isArray(input.slugs)
        ? input.slugs.filter((slug): slug is string => typeof slug === 'string')
        : [];
      const documents = EXISTING_DISPATCH_DOCS.filter((doc) =>
        requested.some((slug) => slug === doc.slug || slug.endsWith(doc.slug.split('/').at(-1)!)),
      );
      return jsonResult({ ok: true, documents, count: documents.length });
    }
    if (canon === 'docs:author') {
      return jsonResult({
        ok: true,
        slug: input.slug ?? 'playbook/fleet-dispatch-wake-clarity',
        status: input.status ?? 'active',
        version: 1,
        verified: input.verify === true,
      });
    }
    // The claim/pickup verbs all succeed (the agent SHOULD reach one of these this turn).
    if (canon === 'work_items:claim') {
      const workItemId = typeof input.row === 'string' ? input.row.split(',')[0]?.trim() : '';
      return jsonResult({
        ok: true,
        id: workItemId,
        workItem: { id: workItemId, state: 'wip', assignee: 'su-self' },
      });
    }
    if (canon === 'plan_items:claim') {
      return jsonResult({
        ok: true,
        claim_id: `cl-${String(input.item ?? '').toLowerCase()}`,
        item: input.item ?? '',
        lease_expires_in_sec: 1800,
      });
    }
    if (canon === 'coord:declare-intent') {
      const claimed = input.current_plan_slug === DISPATCH_PLAN_SLUG ? validPlanItems(input.items) : [];
      return jsonResult({
        ok: true,
        presence: { ownerId: 'su-self', intent: input.intent ?? '' },
        claims: { claimed, alreadyHeld: [], conflicts: [], released: [] },
      });
    }
    if (canon === 'plans:set-status') {
      return jsonResult({
        ok: true,
        itemId: input.itemId ?? '',
        oldStatus: 'todo',
        newStatus: input.status ?? '',
        ...(input.status === 'wip' ? { claim: { holder: 'su-self', lease_sec: 1800 } } : {}),
      });
    }
    if (canon === 'plan_items:convert') {
      return jsonResult({ ok: true, claimed: validPlanItems(input.items) });
    }
    if (canon === 'work_items:set_state' || canon === 'work_items:checkpoint') {
      return jsonResult({ ok: true });
    }
    // The tempting repark alternative — available, but taking it INSTEAD of claiming is the failure.
    if (canon === 'coord:await-inbox') return jsonResult({ ok: true, watching: true });
    return PASS_THROUGH;
  },
};

export const SU_S27_WOKE_TO_DISPATCH_CLAIMS: Scenario = {
  id: 'su-S27-woke-to-dispatch-claims',
  version: 3,
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
  toolOverride: S27_DISPATCH_WORLD,
  asserts: [
    assertToolMatch(startsClaimingDispatch, {
      name: 'claims-the-dispatched-lane',
      claim:
        'The agent woke to a DIRECTED dispatch (fleet-dispatch P-001..P-004 assigned to it) but never claimed it ' +
        '— no claim-capable call named an actual dispatched item. That is ' +
        'the read-and-repark that black-holes a dispatch the coordinator already counted as woken:1.',
      suggestion:
        "su-power/su-engineer playbook 'Woke to a DIRECTED assignment? CLAIM + WORK it': orient → see the lane → " +
        'claim it (coord:orient { planSlug, planItems }, work_items:claim, plan_items:claim, ' +
        'coord:declare-intent { current_plan_slug, items }, or plans:set-status wip) and work it THIS turn.',
    }),
    assertToolCalledWithin(['docs:author'], 2, {
      name: 'starts-the-dispatched-doc-work-without-reparking',
      claim:
        'The agent claimed the clarity lane but did not begin its concrete deliverable within the first two ' +
        'turns. A claim followed by repeated reads and a menu question is still read-and-repark behavior.',
      suggestion:
        'Use the plan acceptance criteria and existing two playbook pages, then author the consolidated ' +
        'fleet-dispatch-wake-clarity page immediately.',
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
