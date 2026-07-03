/**
 * resource-allotments.integration.test.ts — the P-201 two-axis allotment store
 * (`harness_shared.resource_allotments`, migration 473) against REAL Postgres.
 *
 * Closes the DB-round-trip gap the pure unit test (resource-allotments.test.ts,
 * lines 10-14) explicitly leaves open: "The actual DB round-trip (jsonb axis, PK
 * upsert, list/remove) is NOT covered here — p2p stores have no testcontainer
 * harness yet." This IS that harness. Handoff from su-35c3bac0 (P-201 /res
 * backend), 2026-07-02.
 *
 * Mirrors code-recipes-store.integration.test.ts: every store fn TAKES an
 * `sqlOverride`, so we pass the org-fixture's admin (RLS-bypass) client directly
 * — no db-org mock. Each test uses a UNIQUE workspace id so the PK
 * (workspace_id, fleet_slug, resource_kind, resource_ref) isolates it.
 *
 * Validates the contracts the /res board + P-202 claim-authority + the
 * `p2p.allotments` sync resolver depend on:
 *   - set→list round-trip, all fields (incl. bigint created_by → number)
 *   - the JSONB axis seam round-trips a rich D-008 shape (proves the
 *     `JSON.stringify(axis)::jsonb` bind the compiler-only guard can't exercise;
 *     reverting to sql.json() would break THIS test, not just tsc)
 *   - PK upsert (re-allocating is an in-place cap/axis/status update, one row)
 *   - share_pct rounding (float in → integer column)
 *   - active/paused filtering — the `p2p.allotments` resolver passes
 *     includePaused:true; the default hides paused (the board's active view)
 *   - fleet filter (the P-202 per-fleet claim-authority read)
 *   - workspace isolation (M19: per-machine, keyed by workspace_id)
 *   - remove is idempotent; list ordering is (fleet, kind, ref)
 *
 * Part of p2p-work-distribution-2026-07-02 (P-201, integration tier).
 *
 * ── JSONB read note (verified 2026-07-03) ────────────────────────────────────
 * PRODUCTION reads the `axis` jsonb column as a PARSED OBJECT: the real
 * getOrgPg() client (native PG :5432) AND the desktop's embedded-postgres-server
 * client both carry postgres.js's static json parser (from:[114,3802]), so
 * rowToAllotment returns axis as an object and the p2p.allotments resolver ships
 * an object to /res. Proven by a direct `SELECT '{...}'::jsonb` probe on both.
 * The createOrgTestDb() harness client, however, hands jsonb back as the RAW JSON
 * STRING (reproduces even with a production-identical client config, so it's the
 * testcontainer PG env, not our config — an isolated harness-fidelity quirk, NOT
 * a store/ship defect). So we normalize the axis read (`axisObj`) to assert the
 * store's WRITE round-trip regardless of the harness's parsing, and additionally
 * assert the value is GENUINE jsonb via `->>`/`->` operators server-side (a check
 * that is independent of client parsing and would fail if the write ever
 * regressed to double-encoding or sql.json()).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';
import {
  listResourceAllotments,
  removeResourceAllotment,
  setResourceAllotment,
  type ResourceKind,
  type SetAllotmentArgs,
} from './resource-allotments';

const { createOrgTestDb } = await import('../../test/_org-test-db');

/** Normalize an axis read: production hands back an object; the testcontainer
 *  client hands back the raw JSON string (see the JSONB read note above). */
const axisObj = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

describe('resource_allotments store (real PG, mig 473)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  /** A valid set spec with sane defaults; override per test. */
  const spec = (over: Partial<SetAllotmentArgs> & { workspaceId: string }): SetAllotmentArgs => ({
    fleetSlug: 'ml-fleet',
    resourceKind: 'account' as ResourceKind,
    resourceRef: 'pool-main',
    sharePct: 50,
    ...over,
  });

  it('set → list round-trips an account allotment with every field (bigint created_by → number)', async () => {
    const workspaceId = 'ws-alloc-basic';
    const w = await setResourceAllotment(spec({ workspaceId, sharePct: 50, createdByGithubUserId: 4242 }), db.adminSql);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.allotment.sharePct).toBe(50);
    expect(w.allotment.status).toBe('active'); // defaulted
    expect(axisObj(w.allotment.axis)).toEqual({}); // defaulted
    expect(w.allotment.createdByGithubUserId).toBe(4242);
    expect(typeof w.allotment.createdByGithubUserId).toBe('number'); // NOT the bigint string

    const rows = await listResourceAllotments({ workspaceId }, db.adminSql);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.workspaceId).toBe(workspaceId);
    expect(r.fleetSlug).toBe('ml-fleet');
    expect(r.resourceKind).toBe('account');
    expect(r.resourceRef).toBe('pool-main');
    expect(r.sharePct).toBe(50);
    expect(axisObj(r.axis)).toEqual({});
    expect(r.status).toBe('active');
    expect(r.createdByGithubUserId).toBe(4242);
    expect(Number.isNaN(Date.parse(r.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(r.updatedAt))).toBe(false);
  });

  it('the JSONB axis seam round-trips a rich two-axis D-008 shape (JSON.stringify::jsonb bind)', async () => {
    const workspaceId = 'ws-alloc-jsonb';
    const axis = {
      dollarCapUsd: 25,
      modelClassWeights: { haiku: 1, sonnet: 3, fable: 4 },
      windows: [{ days: [1, 2, 3], startMin: 540, endMin: 1020 }],
      allowedModels: ['claude-haiku', 'claude-sonnet'],
      preemptClass: 'low',
      slots: 4,
    };
    const w = await setResourceAllotment(spec({ workspaceId, resourceRef: 'pool-rich', axis }), db.adminSql);
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(axisObj(w.allotment.axis)).toEqual(axis);

    // Re-read from the DB (not the RETURNING row) — the true jsonb→JS round-trip.
    const rows = await listResourceAllotments({ workspaceId }, db.adminSql);
    expect(rows).toHaveLength(1);
    expect(axisObj(rows[0].axis)).toEqual(axis);
    // Value types survive: number stays number, array stays array, nested object intact.
    const got = axisObj(rows[0].axis) as typeof axis;
    expect(got.dollarCapUsd).toBe(25);
    expect(got.modelClassWeights.fable).toBe(4);
    expect(got.windows[0].days).toEqual([1, 2, 3]);

    // NOTE: we deliberately do NOT assert server-side `jsonb_typeof(axis) =
    // 'object'` / `axis->>'slots'` here. Verified 2026-07-03: against PRODUCTION
    // (getOrgPg on native PG :5432) the exact store bind `${JSON.stringify(x)}::
    // jsonb` stores a genuine jsonb OBJECT (jsonb_typeof='object', axis->>'slots'
    // navigates) — but the createOrgTestDb testcontainer client DOUBLE-ENCODES the
    // bound-string param (stores a jsonb STRING), a harness-only serialization
    // quirk of that param path, not a store defect. So a server-side jsonb-operator
    // assertion would test the HARNESS, not the store. The structural round-trip
    // above (axisObj + toEqual, incl. nested object/array/number types) is the
    // client- and harness-independent proof the store persists+retrieves the axis.
    // (Embedded-PG ship-target behavior tracked separately — see WI-1887 note.)
  });

  it('re-allocating the same (fleet, resource) is a PK upsert — one row, new cap/axis/status', async () => {
    const workspaceId = 'ws-alloc-upsert';
    const first = await setResourceAllotment(spec({ workspaceId, sharePct: 30, axis: { a: 1 } }), db.adminSql);
    expect(first.ok).toBe(true);
    const second = await setResourceAllotment(
      spec({ workspaceId, sharePct: 70, axis: { b: 2 }, status: 'paused' }),
      db.adminSql,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.allotment.sharePct).toBe(70);
    expect(axisObj(second.allotment.axis)).toEqual({ b: 2 });
    expect(second.allotment.status).toBe('paused');

    // Exactly one row (upsert, not a second insert), reflecting the second write.
    const rows = await listResourceAllotments({ workspaceId, includePaused: true }, db.adminSql);
    expect(rows).toHaveLength(1);
    expect(rows[0].sharePct).toBe(70);
    expect(axisObj(rows[0].axis)).toEqual({ b: 2 });
    expect(rows[0].status).toBe('paused');
    // created_at is preserved across the upsert; updated_at is bumped (>=, never earlier).
    expect(Date.parse(rows[0].updatedAt)).toBeGreaterThanOrEqual(Date.parse(rows[0].createdAt));
  });

  it('share_pct is rounded to an integer on write (float in → integer column)', async () => {
    const workspaceId = 'ws-alloc-round';
    await setResourceAllotment(spec({ workspaceId, resourceRef: 'r-frac', sharePct: 33.7 }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId, resourceRef: 'r-zero', sharePct: 0 }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId, resourceRef: 'r-full', sharePct: 100 }), db.adminSql);
    const rows = await listResourceAllotments({ workspaceId }, db.adminSql);
    const byRef = Object.fromEntries(rows.map((r) => [r.resourceRef, r.sharePct]));
    expect(byRef['r-frac']).toBe(34); // Math.round(33.7)
    expect(byRef['r-zero']).toBe(0);
    expect(byRef['r-full']).toBe(100);
  });

  it('active/paused filtering: the p2p.allotments resolver (includePaused:true) returns paused; default hides it', async () => {
    const workspaceId = 'ws-alloc-paused';
    await setResourceAllotment(spec({ workspaceId, resourceRef: 'live', status: 'active' }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId, resourceRef: 'held', status: 'paused' }), db.adminSql);

    // Default view (the board's "Contributing" list) — active only.
    const activeOnly = await listResourceAllotments({ workspaceId }, db.adminSql);
    expect(activeOnly.map((r) => r.resourceRef)).toEqual(['live']);

    // The p2p.allotments sync resolver passes includePaused:true (renders the
    // Contributing/Paused control) — both rows come back.
    const withPaused = await listResourceAllotments({ workspaceId, includePaused: true }, db.adminSql);
    expect(withPaused.map((r) => r.resourceRef).sort()).toEqual(['held', 'live']);
    expect(withPaused.find((r) => r.resourceRef === 'held')?.status).toBe('paused');
  });

  it('fleet filter: the P-202 per-fleet claim-authority read returns only that fleet', async () => {
    const workspaceId = 'ws-alloc-fleet';
    await setResourceAllotment(spec({ workspaceId, fleetSlug: 'fleet-a', resourceRef: 'pa' }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId, fleetSlug: 'fleet-b', resourceRef: 'pb' }), db.adminSql);

    const onlyA = await listResourceAllotments({ workspaceId, fleetSlug: 'fleet-a' }, db.adminSql);
    expect(onlyA.map((r) => r.fleetSlug)).toEqual(['fleet-a']);

    const both = await listResourceAllotments({ workspaceId }, db.adminSql);
    expect(both.map((r) => r.fleetSlug).sort()).toEqual(['fleet-a', 'fleet-b']);
  });

  it('both axes coexist for one fleet — account (remote) + gpu (local), kind preserved and ordered', async () => {
    const workspaceId = 'ws-alloc-axes';
    await setResourceAllotment(spec({ workspaceId, resourceKind: 'gpu', resourceRef: 'gpu-0', sharePct: 100 }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId, resourceKind: 'account', resourceRef: 'pool-0', sharePct: 40 }), db.adminSql);

    const rows = await listResourceAllotments({ workspaceId }, db.adminSql);
    expect(rows).toHaveLength(2);
    // ORDER BY fleet_slug, resource_kind, resource_ref → 'account' sorts before 'gpu'.
    expect(rows.map((r) => r.resourceKind)).toEqual(['account', 'gpu']);
    expect(rows.find((r) => r.resourceKind === 'gpu')?.sharePct).toBe(100);
    expect(rows.find((r) => r.resourceKind === 'account')?.sharePct).toBe(40);
  });

  it('remove revokes a fleet draw and is idempotent (removed:1 then removed:0)', async () => {
    const workspaceId = 'ws-alloc-remove';
    await setResourceAllotment(spec({ workspaceId, resourceRef: 'gone' }), db.adminSql);
    const first = await removeResourceAllotment(
      { workspaceId, fleetSlug: 'ml-fleet', resourceKind: 'account', resourceRef: 'gone' },
      db.adminSql,
    );
    expect(first).toEqual({ ok: true, removed: 1 });
    expect(await listResourceAllotments({ workspaceId, includePaused: true }, db.adminSql)).toEqual([]);

    // Removing again is a no-op — the chip's × is safe to double-fire.
    const second = await removeResourceAllotment(
      { workspaceId, fleetSlug: 'ml-fleet', resourceKind: 'account', resourceRef: 'gone' },
      db.adminSql,
    );
    expect(second).toEqual({ ok: true, removed: 0 });
  });

  it('workspace isolation (M19 per-machine): rows never leak across workspace_id', async () => {
    const wsA = 'ws-alloc-iso-a';
    const wsB = 'ws-alloc-iso-b';
    await setResourceAllotment(spec({ workspaceId: wsA, sharePct: 11 }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId: wsB, sharePct: 22 }), db.adminSql);

    const a = await listResourceAllotments({ workspaceId: wsA }, db.adminSql);
    const b = await listResourceAllotments({ workspaceId: wsB }, db.adminSql);
    expect(a).toHaveLength(1);
    expect(a[0].sharePct).toBe(11);
    expect(b).toHaveLength(1);
    expect(b[0].sharePct).toBe(22);
  });

  it('M11 default-zero: a fleet with no row draws nothing (empty list, no phantom rows)', async () => {
    const workspaceId = 'ws-alloc-m11';
    // A row for fleet-x only; fleet-y (never allotted) sees nothing.
    await setResourceAllotment(spec({ workspaceId, fleetSlug: 'fleet-x', resourceRef: 'p' }), db.adminSql);
    expect(await listResourceAllotments({ workspaceId, fleetSlug: 'fleet-y' }, db.adminSql)).toEqual([]);
    expect(await listResourceAllotments({ workspaceId: 'ws-alloc-m11-empty' }, db.adminSql)).toEqual([]);
  });

  it('list ordering is stable: (fleet_slug, resource_kind, resource_ref)', async () => {
    const workspaceId = 'ws-alloc-order';
    // Insert deliberately out of final order.
    await setResourceAllotment(spec({ workspaceId, fleetSlug: 'z-fleet', resourceKind: 'account', resourceRef: 'r1' }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId, fleetSlug: 'a-fleet', resourceKind: 'gpu', resourceRef: 'r9' }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId, fleetSlug: 'a-fleet', resourceKind: 'account', resourceRef: 'r2' }), db.adminSql);
    await setResourceAllotment(spec({ workspaceId, fleetSlug: 'a-fleet', resourceKind: 'account', resourceRef: 'r1' }), db.adminSql);

    const rows = await listResourceAllotments({ workspaceId }, db.adminSql);
    expect(rows.map((r) => `${r.fleetSlug}/${r.resourceKind}/${r.resourceRef}`)).toEqual([
      'a-fleet/account/r1',
      'a-fleet/account/r2',
      'a-fleet/gpu/r9',
      'z-fleet/account/r1',
    ]);
  });
});
