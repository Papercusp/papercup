/**
 * WI-1937 unit tests for the host-availability.ts D-007 snapshot builder:
 * M11 default-zero (no allotment row → null axis), POLICY = absolute
 * forward-seam cap (dollarCapUsd / slots) minus P-205 metered spend, PHYSICS
 * fail-closed to 0 (v1), and the unresolvable-workspace refusal (M11-empty,
 * SQL-free).
 */
import { describe, expect, it } from 'vitest';
import { hostAvailability } from './host-availability';
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
    expect(r.remote).toEqual({ allotmentRemaining: 2_500_000, liveHeadroom: 0 });
    expect(r.local).toBeNull();
  });

  it('a gpu row with axis.slots resolves to an absolute local cap (slots)', async () => {
    const sql = routedSql([
      { match: 'resource_allotments', rows: [allotmentRow({ resource_kind: 'gpu', resource_ref: 'gpu-1', axis: { slots: 4 } })] },
      { match: 'p2p_metering_spend', rows: [] },
      { match: 'p2p_metering_contribution', rows: [] },
    ]);
    const r = await hostAvailability({ workspaceId: 'ws-1', hostRef: 'host-1' }, 'fleet-a', sql);
    expect(r.local).toEqual({ allotmentRemaining: 4, liveHeadroom: 0 });
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
    expect(r.remote).toEqual({ allotmentRemaining: 0, liveHeadroom: 0 });
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
    expect(r.remote).toEqual({ allotmentRemaining: 600_000, liveHeadroom: 0 });

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
    expect(rOver.remote).toEqual({ allotmentRemaining: 0, liveHeadroom: 0 });
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
