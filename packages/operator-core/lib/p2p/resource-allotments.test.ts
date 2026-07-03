/**
 * P-201 (p2p-work-distribution-2026-07-02) unit tests for the two-axis
 * allotment store — mirrors grant-store.test.ts: the C3/WI-1564 workspace
 * resolver (the un-federating 'default' / '*' / null partitions are
 * unresolvable) and the store's refusal / early-return paths, all of which MUST
 * return before any SQL touch (asserted with a throwing sql stub). A positive
 * case proves a fully-valid write proceeds PAST validation to the SQL write, so
 * the refusals are not over-broad.
 *
 * The actual DB round-trip (jsonb axis, PK upsert, list/remove) is NOT covered
 * here — p2p stores have no testcontainer harness yet, same as grant-store. The
 * jsonb bind (JSON.stringify(axis)::jsonb, NOT sql.json() which throws under
 * getOrgPg) is guarded meanwhile by the compiler: reverting to sql.json()
 * re-triggers the TS2345 the fix removed.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_SLOT_MAX_QUANTITY,
  agentSlotRef,
  resolveAllotmentWorkspace,
  setResourceAllotment,
  removeResourceAllotment,
  listResourceAllotments,
} from './resource-allotments';
import type { OrgSql } from '../work-items';

/** A sql stub that FAILS the test if any query executes. */
const throwingSql = (() => {
  const fn = () => {
    throw new Error('refusal / early-return paths must not touch SQL');
  };
  (fn as unknown as { begin: unknown; json: unknown }).begin = fn;
  (fn as unknown as { json: unknown }).json = fn;
  return fn as unknown as OrgSql;
})();

describe('resolveAllotmentWorkspace (C3 / WI-1564: writer + reader share one resolver)', () => {
  it('passes a concrete workspace through, trimmed', () => {
    expect(resolveAllotmentWorkspace('papercusp-workspace')).toBe('papercusp-workspace');
    expect(resolveAllotmentWorkspace('  ws-1  ')).toBe('ws-1');
  });
  it("null / undefined / '*' / blank / the legacy 'default' partition are unresolvable", () => {
    expect(resolveAllotmentWorkspace(null)).toBeUndefined();
    expect(resolveAllotmentWorkspace(undefined)).toBeUndefined();
    expect(resolveAllotmentWorkspace('*')).toBeUndefined();
    expect(resolveAllotmentWorkspace('   ')).toBeUndefined();
    expect(resolveAllotmentWorkspace('default')).toBeUndefined();
  });
});

describe('setResourceAllotment refusal paths (loud, structured, SQL-free)', () => {
  const base = {
    workspaceId: 'ws-1',
    fleetSlug: 'p2p-dist',
    resourceKind: 'account' as const,
    resourceRef: 'pool-main',
    sharePct: 50,
  };

  it("refuses an unresolvable workspace (null / '*' / 'default') — a stranded allotment is a hole, not a warning", async () => {
    for (const ws of [null, '*', 'default']) {
      const r = await setResourceAllotment({ ...base, workspaceId: ws }, throwingSql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('workspace_unresolved');
    }
  });

  it('refuses bad kind / missing ref / missing fleet / out-of-range share, all before SQL', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ resourceKind: 'cpu' }, 'invalid_resource_kind'],
      [{ resourceRef: '  ' }, 'resource_required'],
      [{ fleetSlug: '' }, 'fleet_required'],
      [{ sharePct: 101 }, 'invalid_share_pct'],
      [{ sharePct: -1 }, 'invalid_share_pct'],
      [{ sharePct: Number.NaN }, 'invalid_share_pct'],
    ];
    for (const [override, code] of cases) {
      const r = await setResourceAllotment(
        { ...base, ...override } as Parameters<typeof setResourceAllotment>[0],
        throwingSql,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe(code);
    }
  });

  it('a fully-valid set proceeds PAST validation to the SQL write (refusals are not over-broad)', async () => {
    await expect(setResourceAllotment({ ...base }, throwingSql)).rejects.toThrow(/must not touch SQL/);
  });
});

describe('agent_slot writes (P-001 agent-allocation-framework, D-002/D-003 — count-capped, derived ref)', () => {
  const slotBase = {
    workspaceId: 'ws-1',
    fleetSlug: 'agent-allocation',
    resourceKind: 'agent_slot' as const,
    quantity: 5,
    axis: { model: 'opus', effort: 'xhigh', account: 'AUTO' },
  };

  it('agentSlotRef derives the slot template <model>:<effort>:<account>', () => {
    expect(agentSlotRef({ model: 'opus', effort: 'xhigh', account: 'AUTO' })).toBe('opus:xhigh:AUTO');
    expect(agentSlotRef({ model: 'sonnet[1m]', effort: 'medium', account: 'pool-main' })).toBe(
      'sonnet[1m]:medium:pool-main',
    );
  });

  it('refuses a missing / blank / colon-bearing model → invalid_model, pre-SQL', async () => {
    for (const model of [undefined, '', '   ', 'opus:xhigh', 42]) {
      const r = await setResourceAllotment(
        { ...slotBase, axis: { ...slotBase.axis, model } },
        throwingSql,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('invalid_model');
    }
  });

  it('refuses an effort outside low|medium|high|xhigh|max → invalid_effort, pre-SQL', async () => {
    for (const effort of [undefined, '', 'ultra', 'XHIGH', 3]) {
      const r = await setResourceAllotment(
        { ...slotBase, axis: { ...slotBase.axis, effort } },
        throwingSql,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('invalid_effort');
    }
  });

  it("refuses a missing / blank / colon-bearing account → invalid_account, pre-SQL ('AUTO' and pool ids are the valid shapes)", async () => {
    for (const account of [undefined, '', '  ', 'a:b', null]) {
      const r = await setResourceAllotment(
        { ...slotBase, axis: { ...slotBase.axis, account } },
        throwingSql,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('invalid_account');
    }
  });

  it('refuses a missing quantity → quantity_required (slots are COUNT-capped, D-002)', async () => {
    for (const quantity of [undefined, null]) {
      const r = await setResourceAllotment({ ...slotBase, quantity }, throwingSql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('quantity_required');
    }
  });

  it(`refuses a non-integer / out-of-bounds quantity → quantity_out_of_range (1..${AGENT_SLOT_MAX_QUANTITY})`, async () => {
    for (const quantity of [0, -1, 2.5, Number.NaN, AGENT_SLOT_MAX_QUANTITY + 1]) {
      const r = await setResourceAllotment({ ...slotBase, quantity }, throwingSql);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe('quantity_out_of_range');
    }
  });

  it('does NOT require resourceRef or sharePct for agent_slot (ref derived, share count-capped): a valid slot write proceeds PAST validation to SQL', async () => {
    await expect(setResourceAllotment({ ...slotBase }, throwingSql)).rejects.toThrow(
      /must not touch SQL/,
    );
    // A caller-passed ref is ignored (derivation wins) — still valid, still reaches SQL.
    await expect(
      setResourceAllotment({ ...slotBase, resourceRef: 'stale:mismatched:ref' }, throwingSql),
    ).rejects.toThrow(/must not touch SQL/);
  });

  it("'agent_slot' is a valid kind while unknown kinds still refuse (kind gate widened, not opened)", async () => {
    const r = await setResourceAllotment(
      { ...slotBase, resourceKind: 'seat' },
      throwingSql,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.code).toBe('invalid_resource_kind');
  });

  it('account/gpu kinds still REQUIRE resourceRef + sharePct (agent_slot leniency does not leak)', async () => {
    const noRef = await setResourceAllotment(
      { workspaceId: 'ws-1', fleetSlug: 'f', resourceKind: 'account', sharePct: 50 },
      throwingSql,
    );
    expect(noRef.ok).toBe(false);
    if (!noRef.ok) expect(noRef.refusal.code).toBe('resource_required');
    const noShare = await setResourceAllotment(
      { workspaceId: 'ws-1', fleetSlug: 'f', resourceKind: 'gpu', resourceRef: 'gpu-0' },
      throwingSql,
    );
    expect(noShare.ok).toBe(false);
    if (!noShare.ok) expect(noShare.refusal.code).toBe('invalid_share_pct');
  });
});

describe('read/remove early-return on an unresolvable workspace (SQL-free)', () => {
  it('removeResourceAllotment returns {ok:true, removed:0} without touching SQL', async () => {
    const r = await removeResourceAllotment(
      { workspaceId: 'default', fleetSlug: 'f', resourceKind: 'account', resourceRef: 'p' },
      throwingSql,
    );
    expect(r).toEqual({ ok: true, removed: 0 });
  });
  it('listResourceAllotments returns [] without touching SQL', async () => {
    const rows = await listResourceAllotments({ workspaceId: null }, throwingSql);
    expect(rows).toEqual([]);
  });
});
