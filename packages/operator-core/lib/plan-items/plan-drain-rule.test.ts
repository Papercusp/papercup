/**
 * plan-drain-rule.test.ts — P-004 of
 * deterministic-plan-state-derivation-2026-08-31.
 *
 * Pins both rules to the REAL dispatch path: `plans:set-status` and
 * `plans:add-item` return BULK envelopes, the engine FANS them into one event
 * per item, and the carrier is never matched. A rule reading `data.results[]`
 * therefore has a `when` that is always false and silently never fires.
 *
 * FALSIFIABILITY. Every "fires" assertion is paired with a control event
 * differing in one status field where it must NOT fire, so a matcher stuck at
 * `true` fails a control and one stuck at `false` fails a positive.
 */
import { describe, it, expect } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import './plan-drain-rule'; // registers plan-drain:terminality-changed
import { planWhoseDrainStateMayHaveChanged } from './plan-drain-rule';
import { matchReactions, reactionRulesFor } from '../events/registry';
import { fanOutBulkEvent } from '../events/engine';
import { PLAN_DRAIN_TRANSITION_ACTION } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';

const RULE_ID = 'plan-drain:terminality-changed';
const ADD_RULE_ID = 'plan-drain:item-added';
const CONTENT_RULE_IDS = {
  'plans:set-content': 'plan-drain:content-rewritten',
  'plans:edit': 'plan-drain:content-edited',
  'plans:set-content-chunk': 'plan-drain:content-chunk-committed',
} as const;
const ctx = {
  uiClientId: 'agent-1',
  spawnId: 'spawn-1',
  harnessSlug: 'papercusp',
  runId: 'run-1',
} as unknown as UnifiedToolContext;

/** One fanned PER-ITEM plans:set-status result — what the engine dispatches. */
function perItemEvent(item: Record<string, unknown>): ToolInvocationEvent {
  return {
    tool: 'plans:set-status',
    args: { slug: item.slug, item: item.itemId, status: item.newStatus },
    result: { ok: item.ok !== false, data: item },
    ctx,
  };
}

/** The RAW bulk envelope plans:set-status actually returns. */
function bulkEvent(items: Record<string, unknown>[]): ToolInvocationEvent {
  const ok = items.filter((i) => i.ok !== false).length;
  return {
    tool: 'plans:set-status',
    args: { items: items.map((i) => ({ slug: i.slug, item: i.itemId, status: i.newStatus })) },
    result: {
      ok: true,
      data: { ok: true, results: items, counts: { ok, failed: items.length - ok } },
    },
    ctx,
  };
}

/** The RAW bulk envelope plans:add-item actually returns. */
function addItemBulkEvent(items: Record<string, unknown>[]): ToolInvocationEvent {
  const ok = items.filter((i) => i.ok !== false).length;
  return {
    tool: 'plans:add-item',
    args: { items: items.map((i) => ({ slug: i.slug, text: i.text })) },
    result: {
      ok: true,
      data: { ok: true, results: items, counts: { ok, failed: items.length - ok } },
    },
    ctx,
  };
}

function contentWriteEvent(
  tool: keyof typeof CONTENT_RULE_IDS,
  planDrainTransitionChanged = true,
  ok = true,
): ToolInvocationEvent {
  return {
    tool,
    args: { slug: 'p-content' },
    result: {
      ok,
      data: { ok, slug: 'p-content', planDrainTransitionChanged },
    },
    ctx,
  };
}

const flip = (
  slug: string,
  itemId: string,
  oldStatus: string | null,
  newStatus: string,
  ok = true,
) => ({ ok, slug, itemId, oldStatus, newStatus });

describe('planWhoseDrainStateMayHaveChanged — relevant lifecycle writes', () => {
  it('matches an item going todo -> done (a plan can newly drain)', () => {
    expect(planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'todo', 'done'))))
      .toEqual({ planSlug: 'p1', harnessSlug: 'papercusp' });
  });

  it('matches an item going done -> todo (a drained plan can un-drain)', () => {
    // The reverse edge is what keeps the stored status invertible; a
    // forward-only matcher would strand plans at awaiting-acceptance.
    expect(planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'done', 'todo'))))
      .toEqual({ planSlug: 'p1', harnessSlug: 'papercusp' });
  });

  it('CONTROL: ignores todo -> wip, which cannot change whether the plan is drained', () => {
    expect(
      planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'todo', 'wip'))),
    ).toBeNull();
  });

  it('CONTROL: ignores done -> dropped, where BOTH sides are terminal', () => {
    // Both terminal, so the drained bit is unchanged. Reacting would cost a
    // locked plan read to discover nothing.
    expect(
      planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'done', 'dropped'))),
    ).toBeNull();
  });

  it('CONTROL: ignores a FAILED flip', () => {
    expect(
      planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', 'todo', 'done', false))),
    ).toBeNull();
  });

  it('treats a first-ever status (oldStatus null) going terminal as a crossing', () => {
    expect(
      planWhoseDrainStateMayHaveChanged(perItemEvent(flip('p1', 'P-001', null, 'done'))),
    ).not.toBeNull();
  });

  it('matches a successful add-item result because the new item may reopen the plan', () => {
    const event: ToolInvocationEvent = {
      tool: 'plans:add-item',
      args: { slug: 'p-added', phase: 'Phase 1', text: 'new item' },
      result: { ok: true, data: { ok: true, slug: 'p-added', itemId: 'P-003' } },
      ctx,
    };
    expect(planWhoseDrainStateMayHaveChanged(event)).toEqual({
      planSlug: 'p-added',
      harnessSlug: 'papercusp',
    });
  });

  it('ignores a failed add-item result', () => {
    const event: ToolInvocationEvent = {
      tool: 'plans:add-item',
      args: { slug: 'p-failed', phase: 'Phase 1', text: 'bad item' },
      result: { ok: false, data: { ok: false, slug: 'p-failed', error: 'busy' } },
      ctx,
    };
    expect(planWhoseDrainStateMayHaveChanged(event)).toBeNull();
  });

  it('matches content writers only when the shared evaluator sees a changed transition target', () => {
    for (const tool of Object.keys(CONTENT_RULE_IDS) as Array<keyof typeof CONTENT_RULE_IDS>) {
      expect(planWhoseDrainStateMayHaveChanged(contentWriteEvent(tool))).toEqual({
        planSlug: 'p-content',
        harnessSlug: 'papercusp',
      });
      expect(planWhoseDrainStateMayHaveChanged(contentWriteEvent(tool, false))).toBeNull();
      expect(planWhoseDrainStateMayHaveChanged(contentWriteEvent(tool, true, false))).toBeNull();
    }
  });

  it('carries no harness when the ctx has none, rather than guessing one', () => {
    // EI-8970: re-reading under the operator-home harness would resolve a
    // DIFFERENT plan row for a plan that lives elsewhere. Absent is honest.
    const e = perItemEvent(flip('p1', 'P-001', 'todo', 'done'));
    const bare = { ...e, ctx: {} as unknown as UnifiedToolContext };
    expect(planWhoseDrainStateMayHaveChanged(bare)?.harnessSlug).toBeNull();
  });
});

describe('the rule on the real dispatch path', () => {
  it('is registered on plans:set-status', () => {
    expect(reactionRulesFor('plans:set-status').map((r) => r.id)).toContain(RULE_ID);
  });

  it('is registered on plans:add-item', () => {
    expect(reactionRulesFor('plans:add-item').map((r) => r.id)).toContain(ADD_RULE_ID);
  });

  it('registers the transition-change reaction on every whole-content writer', () => {
    for (const [tool, ruleId] of Object.entries(CONTENT_RULE_IDS) as Array<
      [keyof typeof CONTENT_RULE_IDS, string]
    >) {
      expect(reactionRulesFor(tool).map((r) => r.id)).toContain(ruleId);
    }
  });

  it('matches the FANNED per-item events and NOT the bulk carrier', () => {
    const bulk = bulkEvent([
      flip('p1', 'P-001', 'todo', 'done'), // crosses
      flip('p1', 'P-002', 'todo', 'wip'), // does not
    ]);

    // 1. the carrier itself is never matched (the EI-6960 trap).
    expect(matchReactions(bulk).find((a) => a.ruleId === RULE_ID)).toBeUndefined();

    // 2. the engine fans it into one event per result item.
    const fanned = fanOutBulkEvent(bulk);
    expect(fanned).not.toBeNull();
    expect(fanned!).toHaveLength(2);

    // 3. only the boundary-crossing one fires, and it names the PLAN.
    const crossed = matchReactions(fanned![0]!).find((a) => a.ruleId === RULE_ID);
    expect(crossed).toBeDefined();
    expect(crossed!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
    expect(crossed!.args.plans).toEqual([{ planSlug: 'p1', harnessSlug: 'papercusp' }]);

    expect(matchReactions(fanned![1]!).find((a) => a.ruleId === RULE_ID)).toBeUndefined();
  });

  it('a SINGLE-item call is also enveloped, fans out, and fires', () => {
    // Every plans:set-status call runs through runBulk, so "I only flipped one
    // item" is still a bulk envelope — the assumption that broke reconcile-rule.
    const fanned = fanOutBulkEvent(bulkEvent([flip('p2', 'P-042', 'wip', 'done')]));
    expect(fanned!).toHaveLength(1);
    const action = matchReactions(fanned![0]!).find((a) => a.ruleId === RULE_ID);
    expect(action).toBeDefined();
    expect(action!.args.plans).toEqual([{ planSlug: 'p2', harnessSlug: 'papercusp' }]);
  });

  it('matches successful fanned add-item results and ignores failed siblings', () => {
    const bulk = addItemBulkEvent([
      { ok: true, slug: 'p-added', itemId: 'P-003', text: 'new item' },
      { ok: false, slug: 'p-failed', error: 'busy', text: 'bad item' },
    ]);

    expect(matchReactions(bulk).find((a) => a.ruleId === ADD_RULE_ID)).toBeUndefined();

    const fanned = fanOutBulkEvent(bulk);
    expect(fanned).not.toBeNull();
    expect(fanned!).toHaveLength(2);

    const added = matchReactions(fanned![0]!).find((a) => a.ruleId === ADD_RULE_ID);
    expect(added).toBeDefined();
    expect(added!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
    expect(added!.args.plans).toEqual([{ planSlug: 'p-added', harnessSlug: 'papercusp' }]);
    expect(matchReactions(fanned![1]!).find((a) => a.ruleId === ADD_RULE_ID)).toBeUndefined();
  });

  it('fires lifecycle reconciliation for direct content writes that change the drain target', () => {
    for (const [tool, ruleId] of Object.entries(CONTENT_RULE_IDS) as Array<
      [keyof typeof CONTENT_RULE_IDS, string]
    >) {
      const action = matchReactions(contentWriteEvent(tool)).find((a) => a.ruleId === ruleId);
      expect(action).toBeDefined();
      expect(action!.fire).toBe(PLAN_DRAIN_TRANSITION_ACTION);
      expect(action!.args.plans).toEqual([{ planSlug: 'p-content', harnessSlug: 'papercusp' }]);
      expect(matchReactions(contentWriteEvent(tool, false)).find((a) => a.ruleId === ruleId)).toBeUndefined();
    }
  });
});
