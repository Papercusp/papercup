/**
 * WI-1937 unit tests for the host-availability.ts D-007 snapshot builder:
 * M11 default-zero (no allotment row → null axis), POLICY = absolute
 * forward-seam cap (dollarCapUsd / slots) minus P-205 metered spend, PHYSICS
 * fail-closed to 0 (v1), and the unresolvable-workspace refusal (M11-empty,
 * SQL-free).
 */
import { describe, expect, it } from 'vitest';
import { hostAvailability, type HostAvailabilityReaders } from './host-availability';
import type { OrgSql } from '../work-items';

/** A sql stub that FAILS the test if any query executes. */
const throwingSql = (() => {
  const fn = () => {
    throw new Error('unresolvable-workspace path must not touch SQL');
  };
  return fn as unknown as OrgSql;
})();

/**
 * A minimal tagged-template sql stub: routes on a substring of the query text
 * so one stub can answer listResourceAllotments + loadMeteringLedger's two
 * SELECTs (spend, contribution) in any call order (they run via Promise.all).
 * listResourceAllotments also nests a SECOND, inner `sql\`AND fleet_slug =
 * ...\`` fragment call whose resolved value is only spliced into the OUTER
 * call's values array (never awaited on its own) — an unmatched call must
 * resolve benignly (`[]`), not throw, or evaluating that nested expression
 * would blow up before the outer (matched) call ever runs.
 */
function routedSql(routes: { match: string; rows: unknown[] }[]): OrgSql {
  const fn = (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    for (const r of routes) {
      if (q.includes(r.match)) return Promise.resolve(r.rows);
    }
    return Promise.resolve([]); // unmatched (e.g. a nested fragment) — benign
  };
  return fn as unknown as OrgSql;
}

const allotmentRow = (over: Record<string, unknown> = {}) => ({
  workspace_id: 'ws-1',
  fleet_slug: 'fleet-a',
  resource_kind: 'account',
  resource_ref: 'acct-1',
  share_pct: 0,
  quantity: null,
  axis: { dollarCapUsd: 1 }, // $1 = 1_000_000 usd-micros
  status: 'active',
  created_by_github_user_id: null,
  created_at: new Date(0),
  updated_at: new Date(0),
  ...over,
});

describe('hostAvailability (WI-1937 D-007 snapshot builder)', () => {
  it('unresolvable workspace ⇒ { remote: null, local: null } WITHOUT touching SQL (M11-empty, not a throw — mirrors listResourceAllotments)', async () => {
    const r = await hostAvailability({ workspaceId: 'default', hostRef: 'host-1' }, 'fleet-a', throwingSql);
    expect(r).toEqual({ remote: null, local: null });
  });

  it('no allotment row for the fleet ⇒ both axes null (M11 default-zero)', async () => {
    const sql = routedSql([
      { match: 'resource_allotments', rows: [] },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql);
    expect(r).toEqual({ remote: null, local: null });
  });

  it('an account row with dollarCapUsd resolves to an absolute remote cap (usd-micros), local stays null', async () => {
    const sql = routedSql([
      { match: 'resource_allotments', rows: [allotmentRow({ axis: { dollarCapUsd: 2.5 } })] },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql);
    expect(r.remote).toMatchObject({ allotmentRemaining: 2_500_000, liveHeadroom: 0 });
    expect(r.local).toBeNull();
  });

  it('a gpu row with axis.slots resolves to an absolute local cap (slots)', async () => {
    const sql = routedSql([
      { match: 'resource_allotments', rows: [allotmentRow({ resource_kind: 'gpu', resource_ref: 'gpu-1', axis: { slots: 4 } })] },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql);
    expect(r.local).toMatchObject({ allotmentRemaining: 4, liveHeadroom: 0 });
    expect(r.remote).toBeNull();
  });

  it('a sharePct-only row (no absolute forward-seam field) contributes 0 to the cap — fail-closed, not a guessed conversion', async () => {
    const sql = routedSql([
      { match: 'resource_allotments', rows: [allotmentRow({ share_pct: 50, axis: {} })] },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql);
    // Still "served" (a row exists) so not null, but the cap resolves to 0.
    expect(r.remote).toMatchObject({ allotmentRemaining: 0, liveHeadroom: 0 });
  });

  it('P-205 metering spend for THIS hostRef/fleet/axis is subtracted from the cap, floored at 0', async () => {
    const sql = routedSql([
      { match: 'resource_allotments', rows: [allotmentRow({ axis: { dollarCapUsd: 1 } })] }, // 1_000_000 usd-micros
      {
        match: 'p2p_metering_spend',
        rows: [
          { host_ref: 'host-1', fleet_slug: 'fleet-a', axis: 'remote', amount: 400_000, unit: 'usd-micros' },
          // a DIFFERENT host's spend must not affect this host's remaining
          { host_ref: 'host-other', fleet_slug: 'fleet-a', axis: 'remote', amount: 999_999, unit: 'usd-micros' },
        ],
      },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql);
    expect(r.remote).toMatchObject({ allotmentRemaining: 600_000, liveHeadroom: 0 });

    // Overspend (beyond the cap) floors at 0, never negative.
    const sqlOver = routedSql([
      { match: 'resource_allotments', rows: [allotmentRow({ axis: { dollarCapUsd: 1 } })] },
      {
        match: 'p2p_metering_spend',
        rows: [{ host_ref: 'host-1', fleet_slug: 'fleet-a', axis: 'remote', amount: 5_000_000, unit: 'usd-micros' }],
      },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const rOver = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sqlOver);
    expect(rOver.remote).toMatchObject({ allotmentRemaining: 0, liveHeadroom: 0 });
  });

  it('an agent_slot allotment row never contributes to remote/local budget math (D-002 exclusion)', async () => {
    const sql = routedSql([
      {
        match: 'resource_allotments',
        rows: [
          allotmentRow({
            resource_kind: 'agent_slot',
            resource_ref: 'opus:xhigh:AUTO',
            axis: { model: 'opus', effort: 'xhigh', account: 'AUTO' },
            quantity: 3,
          }),
        ],
      },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql);
    expect(r).toEqual({ remote: null, local: null });
  });
});

/**
 * WI-3590: the PHYSICS layer is now a live read. These drive it through INJECTED readers — the
 * production defaults deliberately short-circuit to "unreachable" under VITEST so the tests above
 * (which inject nothing) keep asserting the fail-closed v1 behaviour deterministically instead of
 * reading whatever real :8788 gateway happens to be running on the box.
 */
describe('hostAvailability PHYSICS layer (WI-3590)', () => {
  const readers = (over: Partial<HostAvailabilityReaders> = {}): HostAvailabilityReaders => ({
    gatewayHeadroom: async () => ({ reachable: true, window: '5h', utilization: 0, healthyAccounts: 2, paused: false, rejected: false }),
    localBackends: async () => ({
      reachable: true,
      configured: true,
      candidates: [
        {
          backend: { id: 'a', kind: 'llama-server', baseUrl: 'http://127.0.0.1:9001', models: ['m'], maxConcurrent: 4, enabled: true },
          inFlight: 1,
          healthy: true,
          // The MEASURED engine reading is the only source of free slots since a525f934f0;
          // registry maxConcurrent is policy/diagnostic metadata, never a physical ceiling.
          engineCapacity: { freeSlots: 3, totalSlots: 4, contextTokens: null, observedAtMs: Date.now(), source: 'test' },
        },
      ],
    }),
    ...over,
  });

  const accountSql = (dollarCapUsd: number) =>
    routedSql([
      { match: 'resource_allotments', rows: [allotmentRow({ axis: { dollarCapUsd } })] },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);

  it('a healthy idle gateway leaves the remote POLICY cap unbound (physics does not bind at 0% utilization)', async () => {
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', accountSql(1), readers());
    expect(r.remote?.allotmentRemaining).toBe(1_000_000);
    expect(r.remote?.liveHeadroom).toBe(1_000_000);
  });

  it('a busy gateway DERATES the remote cap by live utilization', async () => {
    const r = await hostAvailability(
      { workspaceId: 'ws-1', hostRef: 'host-1' },
      'fleet-a',
      accountSql(1),
      readers({ gatewayHeadroom: async () => ({ reachable: true, window: '5h', utilization: 0.8, healthyAccounts: 2 }) }),
    );
    expect(r.remote?.liveHeadroom).toBe(200_000);
  });

  it('a down gateway fails the remote axis CLOSED and says why (the detail reaches the refusal line)', async () => {
    const r = await hostAvailability(
      { workspaceId: 'ws-1', hostRef: 'host-1' },
      'fleet-a',
      accountSql(1),
      readers({ gatewayHeadroom: async () => ({ reachable: false, error: 'ECONNREFUSED' }) }),
    );
    expect(r.remote?.allotmentRemaining).toBe(1_000_000); // POLICY still says yes …
    expect(r.remote?.liveHeadroom).toBe(0); // … PHYSICS overrides it to no
    expect(r.remote?.liveHeadroomDetail).toContain('unreachable');
  });

  it('the local axis reads real free slots from the pool', async () => {
    const sql = routedSql([
      { match: 'resource_allotments', rows: [allotmentRow({ resource_kind: 'gpu', resource_ref: 'gpu-1', axis: { slots: 8 } })] },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql, readers());
    expect(r.local?.allotmentRemaining).toBe(8); // POLICY allows 8 …
    expect(r.local?.liveHeadroom).toBe(3); // … but only 3 slots (4 − 1 in flight) exist right now
  });

  it('does NOT probe the gateway for an axis this host does not serve (no wasted hot-path round-trip)', async () => {
    let remoteProbes = 0;
    let localProbes = 0;
    await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', accountSql(1), {
      gatewayHeadroom: async () => {
        remoteProbes += 1;
        return { reachable: true, utilization: 0, healthyAccounts: 1 };
      },
      localBackends: async () => {
        localProbes += 1;
        return { reachable: true, configured: true, candidates: [] };
      },
    });
    expect(remoteProbes).toBe(1); // an account row IS served
    expect(localProbes).toBe(0); // no gpu row ⇒ local axis is null ⇒ never probed
  });

  it('one dead reader cannot deny the OTHER axis (independent fail-closed)', async () => {
    const sql = routedSql([
      {
        match: 'resource_allotments',
        rows: [
          allotmentRow({ axis: { dollarCapUsd: 1 } }),
          allotmentRow({ resource_kind: 'gpu', resource_ref: 'gpu-1', axis: { slots: 8 } }),
        ],
      },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql, readers({
      gatewayHeadroom: async () => ({ reachable: false, error: 'gateway down' }),
    }));
    expect(r.remote?.liveHeadroom).toBe(0); // remote is dead …
    expect(r.local?.liveHeadroom).toBe(3); // … local is unaffected
  });
});
