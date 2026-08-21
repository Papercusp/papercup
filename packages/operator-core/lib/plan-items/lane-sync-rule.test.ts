/**
 * lane-sync-rule.test.ts — EI-18732669095544832 regression.
 *
 * The bug: clearing (or adding) a plan item's `blocked-by:` edge via
 * `plans:set-item-blocked-by` never re-ran the plan-item <-> work-item lane
 * sync, so the linked work-item stayed parked/unparked until the next 15-min
 * `plan-item-orphan-reconcile` tick — a silent, minutes-long no-op from the
 * caller's point of view.
 *
 * These tests pin the fix to the REAL dispatch path, mirroring
 * reconcile-rule.test.ts's EI-6960 pattern: `blockedByChangedItem` reads the
 * fanned PER-ITEM shape (never the bulk `results[]` carrier, which the reaction
 * engine never matches), and the rule fires `plan-item.resyncLane` off it.
 */
import { describe, it, expect } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import './lane-sync-rule'; // registers plan-item-lane-sync:blocked-by-changed
import {
  blockedByChangedItem,
  dependencyTerminalityChangedItem,
  statusChangedItem,
} from './lane-sync-rule';
import { matchReactions, reactionRulesFor } from '../events/registry';
import { fanOutBulkEvent } from '../events/engine';
import { PLAN_ITEM_LANE_RESYNC_ACTION } from '../events/builtin-actions';
import type { ToolInvocationEvent } from '../events/types';

const RULE_ID = 'plan-item-lane-sync:blocked-by-changed';
const STATUS_RULE_ID = 'plan-item-lane-sync:status-changed';
const DEPENDENCY_STATUS_RULE_ID = 'plan-item-lane-sync:dependency-terminality-changed';
const ctx = {
  uiClientId: 'agent-1',
  spawnId: 'spawn-1',
  harnessSlug: 'papercusp',
  runId: 'run-1',
} as unknown as UnifiedToolContext;

/** A single fanned PER-ITEM plans:set-item-blocked-by event — the exact shape
 *  the engine dispatches (`fanOutBulkEvent` sets `result.data` = the flat item
 *  record `setBlockedByOne` returns). */
function perItemEvent(item: Record<string, unknown>): ToolInvocationEvent {
  return {
    tool: 'plans:set-item-blocked-by',
    args: { slug: item.slug, item: item.itemId, blockedBy: item.to },
    result: { ok: item.ok !== false, data: item },
    ctx,
  };
}

/** The RAW bulk-envelope event plans:set-item-blocked-by actually returns
 *  (bulkContent → `{ ok, results, counts }`). The engine fans this out; the
 *  carrier is never matched. */
function bulkEvent(items: Record<string, unknown>[]): ToolInvocationEvent {
  const ok = items.filter((i) => i.ok !== false).length;
  return {
    tool: 'plans:set-item-blocked-by',
    args: { items: items.map((i) => ({ slug: i.slug, item: i.itemId, blockedBy: i.to })) },
    result: { ok: true, data: { ok: true, results: items, counts: { ok, failed: items.length - ok } } },
    ctx,
  };
}

function statusBulkEvent(items: Record<string, unknown>[]): ToolInvocationEvent {
  const ok = items.filter((i) => i.ok !== false).length;
  return {
    tool: 'plans:set-status',
    args: { items: items.map((i) => ({ slug: i.slug, item: i.itemId, status: i.newStatus })) },
    result: { ok: true, data: { ok: true, results: items, counts: { ok, failed: items.length - ok } } },
    ctx,
  };
}

const cleared = (slug: string, itemId: string) => ({
  ok: true,
  slug,
  itemId,
  from: ['P-010'],
  to: [],
});

const added = (slug: string, itemId: string) => ({
  ok: true,
  slug,
  itemId,
  from: [],
  to: ['P-010'],
});

describe('blockedByChangedItem — reads the fanned PER-ITEM shape', () => {
  it('extracts a plan item whose blocked-by was CLEARED', () => {
    expect(blockedByChangedItem(perItemEvent(cleared('p1', 'P-011')))).toEqual({
      planSlug: 'p1',
      itemId: 'P-011',
      harnessSlug: 'papercusp',
    });
  });

  it('extracts a plan item whose blocked-by was ADDED (symmetric)', () => {
    expect(blockedByChangedItem(perItemEvent(added('p1', 'P-012')))).toEqual({
      planSlug: 'p1',
      itemId: 'P-012',
      harnessSlug: 'papercusp',
    });
  });

  it('is null for a FAILED item (e.g. self_block / not_found)', () => {
    expect(
      blockedByChangedItem(perItemEvent({ ok: false, slug: 'p1', itemId: 'P-013', error: 'self_block' })),
    ).toBeNull();
  });

  it('is null when slug/itemId are missing', () => {
    expect(blockedByChangedItem(perItemEvent({ ok: true, from: [], to: [] }))).toBeNull();
  });

  it('is null on the RAW bulk-envelope carrier (it has no top-level slug/itemId)', () => {
    expect(blockedByChangedItem(bulkEvent([cleared('p1', 'P-011')]))).toBeNull();
  });
});

describe('plan-item-lane-sync:blocked-by-changed — fires on the REAL fan-out path', () => {
  it('is registered on plans:set-item-blocked-by', () => {
    expect(reactionRulesFor('plans:set-item-blocked-by').map((r) => r.id)).toContain(RULE_ID);
  });

  it('does NOT match the bulk carrier, but DOES match each fanned successful item', () => {
    const bulk = bulkEvent([
      cleared('p1', 'P-011'), // cleared → should resync
      { ok: false, slug: 'p1', itemId: 'P-012', error: 'item_not_found' }, // failed → not
    ]);

    // 1. the carrier itself must not fire the rule.
    expect(matchReactions(bulk).find((a) => a.ruleId === RULE_ID)).toBeUndefined();

    // 2. the engine fan-out yields one event per result item.
    const fanned = fanOutBulkEvent(bulk);
    expect(fanned).not.toBeNull();
    expect(fanned!).toHaveLength(2);

    // 3. mirror matchAndRun: match each fanned per-item event.
    const p011 = matchReactions(fanned![0]!).find((a) => a.ruleId === RULE_ID);
    expect(p011).toBeDefined();
    expect(p011!.fire).toBe(PLAN_ITEM_LANE_RESYNC_ACTION);
    expect(p011!.args.items).toEqual([{ planSlug: 'p1', itemId: 'P-011', harnessSlug: 'papercusp' }]);

    // the failed item does not resync.
    expect(matchReactions(fanned![1]!).find((a) => a.ruleId === RULE_ID)).toBeUndefined();
  });

  it('a SINGLE-item plans:set-item-blocked-by call (also enveloped) fans out and fires', () => {
    const bulk = bulkEvent([added('p2', 'P-042')]);
    const fanned = fanOutBulkEvent(bulk);
    expect(fanned!).toHaveLength(1);
    const action = matchReactions(fanned![0]!).find((a) => a.ruleId === RULE_ID);
    expect(action).toBeDefined();
    expect(action!.args.items).toEqual([{ planSlug: 'p2', itemId: 'P-042', harnessSlug: 'papercusp' }]);
  });
});

describe('plan-item-lane-sync:status-changed — blocked -> wip regression', () => {
  const resumed = {
    ok: true,
    slug: 'p-resume',
    itemId: 'P-004',
    oldStatus: 'blocked',
    newStatus: 'wip',
    claim: { claimId: 'claim-1', autoClaimed: true },
  };

  it('extracts a successful real transition but ignores a status re-set', () => {
    const [changed] = fanOutBulkEvent(statusBulkEvent([resumed]))!;
    expect(statusChangedItem(changed!)).toEqual({
      planSlug: 'p-resume',
      itemId: 'P-004',
      harnessSlug: 'papercusp',
    });

    const [reset] = fanOutBulkEvent(
      statusBulkEvent([{ ...resumed, oldStatus: 'wip', newStatus: 'wip' }]),
    )!;
    expect(statusChangedItem(reset!)).toBeNull();
  });

  it('fires the canonical inline lane resync for the fanned blocked -> wip result', () => {
    expect(reactionRulesFor('plans:set-status').map((r) => r.id)).toContain(STATUS_RULE_ID);
    const bulk = statusBulkEvent([resumed]);
    expect(matchReactions(bulk).find((a) => a.ruleId === STATUS_RULE_ID)).toBeUndefined();

    const [fanned] = fanOutBulkEvent(bulk)!;
    const action = matchReactions(fanned!).find((a) => a.ruleId === STATUS_RULE_ID);
    expect(action).toBeDefined();
    expect(action!.fire).toBe(PLAN_ITEM_LANE_RESYNC_ACTION);
    expect(action!.args.items).toEqual([
      { planSlug: 'p-resume', itemId: 'P-004', harnessSlug: 'papercusp' },
    ]);
  });

  it('does not fire for a failed per-item status flip', () => {
    const [failed] = fanOutBulkEvent(
      statusBulkEvent([{ ...resumed, ok: false, error: 'claim_conflict' }]),
    )!;
    expect(matchReactions(failed!).find((a) => a.ruleId === STATUS_RULE_ID)).toBeUndefined();
  });
});

describe('plan-item-lane-sync:dependency-terminality-changed — dependent lane regression', () => {
  const completed = {
    ok: true,
    slug: 'p-dependency',
    itemId: 'P-001',
    oldStatus: 'wip',
    newStatus: 'done',
  };

  it('extracts both completion and reopen edges, but ignores edges that preserve terminality', () => {
    const [done] = fanOutBulkEvent(statusBulkEvent([completed]))!;
    expect(dependencyTerminalityChangedItem(done!)).toEqual({
      planSlug: 'p-dependency',
      itemId: 'P-001',
      harnessSlug: 'papercusp',
    });

    const [reopened] = fanOutBulkEvent(
      statusBulkEvent([{ ...completed, oldStatus: 'dropped', newStatus: 'todo' }]),
    )!;
    expect(dependencyTerminalityChangedItem(reopened!)).toEqual({
      planSlug: 'p-dependency',
      itemId: 'P-001',
      harnessSlug: 'papercusp',
    });

    for (const unchanged of [
      { ...completed, oldStatus: 'todo', newStatus: 'wip' },
      { ...completed, oldStatus: 'done', newStatus: 'dropped' },
      { ...completed, oldStatus: 'done', newStatus: 'done' },
      { ...completed, ok: false, error: 'claim_conflict' },
    ]) {
      const [event] = fanOutBulkEvent(statusBulkEvent([unchanged]))!;
      expect(dependencyTerminalityChangedItem(event!)).toBeNull();
    }
  });

  it('fires the SAME canonical lane-resync action in dependency mode', () => {
    expect(reactionRulesFor('plans:set-status').map((r) => r.id)).toContain(
      DEPENDENCY_STATUS_RULE_ID,
    );
    const bulk = statusBulkEvent([completed]);
    expect(
      matchReactions(bulk).find((a) => a.ruleId === DEPENDENCY_STATUS_RULE_ID),
    ).toBeUndefined();

    const [fanned] = fanOutBulkEvent(bulk)!;
    const action = matchReactions(fanned!).find(
      (a) => a.ruleId === DEPENDENCY_STATUS_RULE_ID,
    );
    expect(action).toBeDefined();
    expect(action!.fire).toBe(PLAN_ITEM_LANE_RESYNC_ACTION);
    expect(action!.args.dependencies).toEqual([
      { planSlug: 'p-dependency', itemId: 'P-001', harnessSlug: 'papercusp' },
    ]);
  });
});
