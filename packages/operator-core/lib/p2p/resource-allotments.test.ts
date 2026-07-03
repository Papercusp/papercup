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
