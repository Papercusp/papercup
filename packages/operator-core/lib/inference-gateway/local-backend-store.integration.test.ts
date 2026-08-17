/**
 * local-backend-store — REAL-PG coverage for the SQL paths `local-backend-store.test.ts`
 * deliberately skips (that file tests `validateLocalBackendInput` only, which is pure).
 *
 * P-011, discharging the debt P-005 recorded: these four paths typecheck but had ZERO execution
 * coverage, and their failure mode is quiet. A column missing from a RETURNING list does not
 * throw — it surfaces as an `undefined` field, and every consumer downstream reads it as
 * "absent", which for `lifecycle` means the safe-looking `always-on`.
 *
 * That quiet failure is load-bearing for P-008/D-014. The gateway's cold-start rescue fires only
 * for a backend it can see is `on-demand` WITH a `unitName` (`startableOnDemand`), and it learns
 * both by reading them off these rows. If either stopped round-tripping, the rescue would go
 * silently dead: no error, no failing test, just a backend that never restarts and a caller that
 * eats a 502. The round-trip test below is the guard against exactly that.
 *
 * Applies the three real migrations that build the table: 445 (base), 843 (lifecycle/idle_ttl_sec/
 * unit_name + CHECK constraints), 845 (last_busy_at).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../../test/_pg-helpers';
import {
  registerLocalBackend,
  listLocalBackends,
  listOnDemandLocalBackends,
  setLocalBackendEnabled,
  markLocalBackendBusy,
  removeLocalBackend,
} from './local-backend-store';

const WS = 'ws-local-backend-store';
const OTHER_WS = 'ws-someone-else';

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('lbstore');
  await applyMigrationsForTest(db.sql, [
    '445-local-backend-pool.sql',
    '843-local-backend-lifecycle.sql',
    '845-local-backends-last-busy-at.sql',
  ]);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  await db.sql`DELETE FROM harness_shared.local_backends`;
});

/** An always-on registration — the shape every pre-843 caller writes. */
const alwaysOn = (id: string, models: string[] = ['m1']) => ({
  id,
  kind: 'llama-server' as const,
  baseUrl: `http://127.0.0.1:9000/${id}`,
  models,
  workspaceId: WS,
});

/** An on-demand registration — `unitName` is mandatory (843's CHECK, and the JS validator). */
const onDemand = (id: string, models: string[] = ['m1']) => ({
  ...alwaysOn(id, models),
  lifecycle: 'on-demand' as const,
  idleTtlSec: 1800,
  unitName: `llama-${id}.service`,
});

describe('registerLocalBackend', () => {
  it('INSERTS and round-trips every 843 column, and defaults an omitted lifecycle to always-on', async () => {
    const rec = await registerLocalBackend(alwaysOn('b-insert'), db.sql);

    expect(rec.id).toBe('b-insert');
    expect(rec.lifecycle).toBe('always-on');
    expect(rec.idleTtlSec).toBeNull();
    expect(rec.unitName).toBeNull();
    // Defaults applied by the store, not the caller.
    expect(rec.maxConcurrent).toBe(4);
    expect(rec.enabled).toBe(true);
    // Present in the RETURNING list, so never undefined.
    expect(rec.lastBusyAt).toEqual(expect.any(String));
    expect(rec.createdAt).toEqual(expect.any(String));
  });

  it('round-trips lifecycle + unitName + idleTtlSec on an on-demand registration', async () => {
    const rec = await registerLocalBackend(onDemand('b-ondemand'), db.sql);

    expect(rec.lifecycle).toBe('on-demand');
    expect(rec.unitName).toBe('llama-b-ondemand.service');
    expect(rec.idleTtlSec).toBe(1800);
  });

  it('strips a trailing slash from baseUrl (the pool concatenates /v1/... onto it)', async () => {
    const rec = await registerLocalBackend({ ...alwaysOn('b-slash'), baseUrl: 'http://127.0.0.1:9000/' }, db.sql);
    expect(rec.baseUrl).toBe('http://127.0.0.1:9000');
  });

  it('takes the ON CONFLICT UPDATE arm on re-registration — every 843 column is updated in place, not duplicated', async () => {
    await registerLocalBackend(alwaysOn('b-upsert'), db.sql);
    const updated = await registerLocalBackend(
      { ...onDemand('b-upsert', ['m1', 'm2']), maxConcurrent: 2, enabled: false },
      db.sql,
    );

    expect(updated.lifecycle).toBe('on-demand');
    expect(updated.unitName).toBe('llama-b-upsert.service');
    expect(updated.idleTtlSec).toBe(1800);
    expect(updated.models).toEqual(['m1', 'm2']);
    expect(updated.maxConcurrent).toBe(2);
    expect(updated.enabled).toBe(false);

    const all = await listLocalBackends({ workspaceId: WS }, db.sql);
    expect(all).toHaveLength(1); // upserted, not inserted twice
  });

  it('the conflict arm does NOT clobber last_busy_at — a re-registration is a config change, not idleness', async () => {
    await registerLocalBackend(onDemand('b-busy-keep'), db.sql);
    const at = new Date('2026-01-01T00:00:00.000Z');
    await markLocalBackendBusy('b-busy-keep', { workspaceId: WS, at }, db.sql);

    const after = await registerLocalBackend({ ...onDemand('b-busy-keep'), maxConcurrent: 3 }, db.sql);

    // last_busy_at is absent from the UPDATE SET list, so the watermark survives. If it were
    // reset here, every gateway hot-reload would make an idle backend look freshly busy and the
    // reaper could never stop it.
    expect(Date.parse(after.lastBusyAt)).toBe(at.getTime());
  });

  it('the DATABASE refuses on-demand without a unit, not just the JS validator', async () => {
    // Defence in depth: validateLocalBackendInput rejects this before any SQL runs, so this
    // asserts the 843 CHECK is real by going around the validator entirely. Without it, a
    // direct/raw writer could arm a backend that nothing is able to stop.
    await expect(
      db.sql`INSERT INTO harness_shared.local_backends
               (id, workspace_id, kind, base_url, models, max_concurrent, enabled, lifecycle, unit_name)
             VALUES ('b-raw', ${WS}, 'llama-server', 'http://127.0.0.1:9', '["m1"]'::jsonb, 4, true, 'on-demand', NULL)`,
    ).rejects.toThrow(/local_backends_on_demand_needs_unit_check/);
  });
});

describe('listLocalBackends', () => {
  it('returns every registration for the workspace, disabled included, ordered by id', async () => {
    await registerLocalBackend(alwaysOn('b-2'), db.sql);
    await registerLocalBackend(alwaysOn('b-1'), db.sql);
    await registerLocalBackend({ ...alwaysOn('b-3'), enabled: false }, db.sql);

    const rows = await listLocalBackends({ workspaceId: WS }, db.sql);

    expect(rows.map((r) => r.id)).toEqual(['b-1', 'b-2', 'b-3']);
    expect(rows.find((r) => r.id === 'b-3')?.enabled).toBe(false);
  });

  it('is scoped to its workspace', async () => {
    await registerLocalBackend(alwaysOn('b-mine'), db.sql);
    await registerLocalBackend({ ...alwaysOn('b-theirs'), workspaceId: OTHER_WS }, db.sql);

    expect((await listLocalBackends({ workspaceId: WS }, db.sql)).map((r) => r.id)).toEqual(['b-mine']);
    expect((await listLocalBackends({ workspaceId: OTHER_WS }, db.sql)).map((r) => r.id)).toEqual(['b-theirs']);
  });
});

describe('listOnDemandLocalBackends (the reaper working set)', () => {
  it('returns ONLY enabled on-demand backends — an always-on row and a disabled on-demand row are both excluded', async () => {
    await registerLocalBackend(alwaysOn('b-always'), db.sql); // wrong lifecycle
    await registerLocalBackend({ ...onDemand('b-off'), enabled: false }, db.sql); // right lifecycle, disabled
    await registerLocalBackend(onDemand('b-live'), db.sql); // the only match

    const rows = await listOnDemandLocalBackends({ workspaceId: WS }, db.sql);

    expect(rows.map((r) => r.id)).toEqual(['b-live']);
    // Both exclusions matter and for different reasons: reaping an always-on backend stops
    // something nothing will restart, and reaping a disabled one acts on a row taken out of
    // rotation on purpose.
    expect(rows.map((r) => r.id)).not.toContain('b-always');
    expect(rows.map((r) => r.id)).not.toContain('b-off');
  });

  it('carries unitName through — the reaper stops the UNIT, and has nothing to stop without it', async () => {
    await registerLocalBackend(onDemand('b-unit'), db.sql);
    const [row] = await listOnDemandLocalBackends({ workspaceId: WS }, db.sql);
    expect(row.unitName).toBe('llama-b-unit.service');
  });

  it('is empty when nothing is on-demand — the reaper sweeps nothing rather than everything', async () => {
    await registerLocalBackend(alwaysOn('b-a'), db.sql);
    await registerLocalBackend(alwaysOn('b-b'), db.sql);
    expect(await listOnDemandLocalBackends({ workspaceId: WS }, db.sql)).toEqual([]);
  });
});

describe('setLocalBackendEnabled', () => {
  it('flips enabled and returns the updated record without disturbing the lifecycle fields', async () => {
    await registerLocalBackend(onDemand('b-toggle'), db.sql);

    const off = await setLocalBackendEnabled('b-toggle', false, { workspaceId: WS }, db.sql);
    expect(off?.enabled).toBe(false);
    expect(off?.lifecycle).toBe('on-demand');
    expect(off?.unitName).toBe('llama-b-toggle.service');

    const on = await setLocalBackendEnabled('b-toggle', true, { workspaceId: WS }, db.sql);
    expect(on?.enabled).toBe(true);
  });

  it('returns null for an unknown id rather than throwing', async () => {
    expect(await setLocalBackendEnabled('nope', false, { workspaceId: WS }, db.sql)).toBeNull();
  });

  it('will not reach across workspaces', async () => {
    await registerLocalBackend({ ...alwaysOn('b-theirs'), workspaceId: OTHER_WS }, db.sql);
    expect(await setLocalBackendEnabled('b-theirs', false, { workspaceId: WS }, db.sql)).toBeNull();
  });
});

describe('markLocalBackendBusy', () => {
  it('stamps the watermark and reports the row was found', async () => {
    await registerLocalBackend(onDemand('b-stamp'), db.sql);
    const at = new Date('2026-02-02T03:04:05.000Z');

    expect(await markLocalBackendBusy('b-stamp', { workspaceId: WS, at }, db.sql)).toBe(true);

    const [row] = await listOnDemandLocalBackends({ workspaceId: WS }, db.sql);
    expect(Date.parse(row.lastBusyAt)).toBe(at.getTime());
  });

  it('does NOT touch updated_at — being busy is not a change to the registration', async () => {
    const registered = await registerLocalBackend(onDemand('b-untouched'), db.sql);
    await markLocalBackendBusy('b-untouched', { workspaceId: WS }, db.sql);

    const [row] = await listOnDemandLocalBackends({ workspaceId: WS }, db.sql);
    // Documented invariant: conflating the two would churn updated_at on every reaper poll and
    // make it useless for spotting real config drift.
    expect(row.updatedAt).toBe(registered.updatedAt);
  });

  it('reports false for a row that is not there, so a caller iterating a stale list can tell', async () => {
    expect(await markLocalBackendBusy('ghost', { workspaceId: WS }, db.sql)).toBe(false);
  });
});

describe('removeLocalBackend', () => {
  it('deletes and reports whether anything was removed', async () => {
    await registerLocalBackend(alwaysOn('b-gone'), db.sql);
    expect(await removeLocalBackend('b-gone', { workspaceId: WS }, db.sql)).toBe(true);
    expect(await removeLocalBackend('b-gone', { workspaceId: WS }, db.sql)).toBe(false);
    expect(await listLocalBackends({ workspaceId: WS }, db.sql)).toEqual([]);
  });
});

describe('P-008/D-014: the register -> list round-trip the gateway cold-start depends on', () => {
  it('delivers lifecycle AND unitName to the reader, which is what makes a backend startable at all', async () => {
    // This mirrors refreshLocalBackends (launch.ts): the gateway reads these rows and copies both
    // fields into the live pool, where `startableOnDemand` = enabled && lifecycle === 'on-demand'
    // && !!unitName decides whether a 502 gets rescued by a cold start or relayed to the caller.
    await registerLocalBackend(onDemand('ornith-llamaserver', ['ornith-35b']), db.sql);

    const [row] = await listLocalBackends({ workspaceId: WS }, db.sql);
    const startable = row.enabled && row.lifecycle === 'on-demand' && !!row.unitName;

    expect(startable).toBe(true);
    expect(row.unitName).toBe('llama-ornith-llamaserver.service');
  });

  it('CONTROL: the same predicate is false for an always-on registration, so the rescue stays scoped', async () => {
    // The falsifiability half — proves the assertion above tracks the DATA and is not simply
    // always-true. An always-on backend has no unit to start, and must relay its 502 unchanged.
    await registerLocalBackend(alwaysOn('proxy-only', ['ornith-35b']), db.sql);

    const [row] = await listLocalBackends({ workspaceId: WS }, db.sql);
    const startable = row.enabled && row.lifecycle === 'on-demand' && !!row.unitName;

    expect(startable).toBe(false);
  });
});
