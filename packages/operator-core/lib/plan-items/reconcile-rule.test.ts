/**
 * reconcile-rule.test.ts — EI-6960 regression.
 *
 * The bug: `plan-item-reconcile:done` read the BULK-envelope shape
 * (`data.results[]`), but the reaction engine fans a bulk `plans:set-status`
 * result into one synthetic event PER ITEM and never matches the bulk carrier
 * (engine.ts `fanOutBulkEvent` / D-007). So the rule's `when` was always false
 * and linked work_items were never reconciled → the scheduler re-handed
 * already-done work.
 *
 * These tests pin the fix to the REAL dispatch path: `newlyDonePlanItem` reads
 * the per-item shape, and the rule matches the events `fanOutBulkEvent` actually
 * produces (NOT the bulk carrier). If someone reverts to reading `results[]`,
 * the dispatch test below goes red.
 */
import { describe, it, expect } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import './reconcile-rule'; // registers plan-item-reconcile:done into the global engine
import { newlyDonePlanItem } from './reconcile-rule';
import { matchReactions, reactionRulesFor } from '../events/registry';
import { fanOutBulkEvent } from '../events/engine';
import { PLAN_ITEM_RECONCILE_ACTION } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';

const RULE_ID = 'plan-item-reconcile:done';
const ctx = {
  uiClientId: 'agent-1',
  spawnId: 'spawn-1',
  harnessSlug: 'papercusp',
  runId: 'run-1',
} as unknown as UnifiedToolContext;

/** A single fanned PER-ITEM plans:set-status event — the exact shape the engine
 *  dispatches (`fanOutBulkEvent` sets `result.data` = the flat item record). */
function perItemEvent(item: Record<string, unknown>): ToolInvocationEvent {
  return {
    tool: 'plans:set-status',
    args: { slug: item.slug, itemId: item.itemId, status: item.newStatus },
    result: { ok: item.ok !== false, data: item },
    ctx,
  };
}

/** The RAW bulk-envelope event plans:set-status actually returns (bulkContent →
 *  `{ ok, results, counts }`). The engine fans this out; the carrier is never matched. */
function bulkEvent(items: Record<string, unknown>[]): ToolInvocationEvent {
  const ok = items.filter((i) => i.ok !== false).length;
  return {
    tool: 'plans:set-status',
    args: { items: items.map((i) => ({ slug: i.slug, itemId: i.itemId, status: i.newStatus })) },
    result: { ok: true, data: { ok: true, results: items, counts: { ok, failed: items.length - ok } } },
    ctx,
  };
}

const done = (slug: string, itemId: string, oldStatus: string | null = 'wip') => ({
  ok: true,
  slug,
  itemId,
  oldStatus,
  newStatus: 'done',
});

describe('newlyDonePlanItem — reads the fanned PER-ITEM shape (EI-6960)', () => {
  it('extracts a plan item that NEWLY transitioned wip→done', () => {
    expect(newlyDonePlanItem(perItemEvent(done('p1', 'P-001')))).toEqual({
      planSlug: 'p1',
      itemId: 'P-001',
      harnessSlug: 'papercusp',
    });
  });

  it('is null when the item did not go to done (still wip)', () => {
    expect(
      newlyDonePlanItem(perItemEvent({ ok: true, slug: 'p1', itemId: 'P-002', oldStatus: 'todo', newStatus: 'wip' })),
    ).toBeNull();
  });

  it('is null for a re-set of an ALREADY-done item (transition-gated, no re-fire)', () => {
    expect(newlyDonePlanItem(perItemEvent(done('p1', 'P-003', 'done')))).toBeNull();
  });

  it('is null for a FAILED item (a per-item claim_conflict etc. never reconciles)', () => {
    expect(
      newlyDonePlanItem(perItemEvent({ ok: false, slug: 'p1', itemId: 'P-004', error: 'claim_conflict' })),
    ).toBeNull();
  });

  it('is null for `dropped` (the reconcile action is scoped to done, per EI-5925)', () => {
    expect(
      newlyDonePlanItem(perItemEvent({ ok: true, slug: 'p1', itemId: 'P-005', oldStatus: 'wip', newStatus: 'dropped' })),
    ).toBeNull();
  });

  it('is null when slug/itemId are missing', () => {
    expect(newlyDonePlanItem(perItemEvent({ ok: true, oldStatus: 'wip', newStatus: 'done' }))).toBeNull();
  });

  it('is null on the RAW bulk-envelope carrier (it has no top-level newStatus/slug)', () => {
    // The old rule read this shape; the engine never matches the carrier, and the
    // per-item reader correctly declines it — so no accidental bulk-level fire.
    expect(newlyDonePlanItem(bulkEvent([done('p1', 'P-001')]))).toBeNull();
  });
});

describe('plan-item-reconcile:done — fires on the REAL fan-out path (EI-6960)', () => {
  it('is registered on plans:set-status', () => {
    expect(reactionRulesFor('plans:set-status').map((r) => r.id)).toContain(RULE_ID);
  });

  it('does NOT match the bulk carrier, but DOES match each fanned done item', () => {
    const bulk = bulkEvent([
      done('p1', 'P-001'), // wip → done  → should reconcile
      { ok: true, slug: 'p1', itemId: 'P-002', oldStatus: 'todo', newStatus: 'wip' }, // still wip → not
    ]);

    // 1. the carrier itself must not fire the rule (the engine fans out first;
    //    matching the carrier would double-fire / read the wrong shape).
    expect(matchReactions(bulk).find((a) => a.ruleId === RULE_ID)).toBeUndefined();

    // 2. the engine fan-out yields one event per result item.
    const fanned = fanOutBulkEvent(bulk);
    expect(fanned).not.toBeNull();
    expect(fanned!).toHaveLength(2);

    // 3. mirror matchAndRun: match each fanned per-item event.
    const p001 = matchReactions(fanned![0]!).find((a) => a.ruleId === RULE_ID);
    expect(p001).toBeDefined();
    expect(p001!.fire).toBe(PLAN_ITEM_RECONCILE_ACTION);
    expect(p001!.args.completedItems).toEqual([{ planSlug: 'p1', itemId: 'P-001', harnessSlug: 'papercusp' }]);

    // the still-wip item does not reconcile.
    expect(matchReactions(fanned![1]!).find((a) => a.ruleId === RULE_ID)).toBeUndefined();
  });

  it('a SINGLE-item plans:set-status done (also enveloped) fans out and fires', () => {
    const bulk = bulkEvent([done('p2', 'P-042')]);
    const fanned = fanOutBulkEvent(bulk);
    expect(fanned!).toHaveLength(1);
    const action = matchReactions(fanned![0]!).find((a) => a.ruleId === RULE_ID);
    expect(action).toBeDefined();
    expect(action!.args.completedItems).toEqual([{ planSlug: 'p2', itemId: 'P-042', harnessSlug: 'papercusp' }]);
  });
});
