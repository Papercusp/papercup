import { describe, expect, it } from 'vitest';
import {
  buildRows,
  CAPACITY,
  capacity,
  dedicatedHosts,
  evaluate,
  hostMonthUsd,
  renderMarkdown,
  SCENARIOS,
  serverMonthUsd,
  serverRamGiB,
  TARGET,
  tenantsPerHost,
} from './cost-model';

const perActiveSpot = (id: string) => hostMonthUsd(capacity(id).machineType, true) / capacity(id).active;
const row = (id: string, agents = 50, saved: number | null = null) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return evaluate(s, agents, saved);
};

describe('cost-model inputs', () => {
  it('every capacity row cites a plan Decision', () => {
    for (const c of CAPACITY) expect(c.source, c.id).toMatch(/\bD-\d{3}\b/);
  });

  // The decisions priced their rows from the same gcp-rails catalog prices, so the model must
  // reproduce the published per-active-agent figures; a price or capacity edit that breaks one fails here.
  it.each([
    ['mixed-e2s16', 3.86, 'D-019'],
    ['mixed-e2c16', 2.81, 'D-020'],
    ['heavy-e2s16', 10.33, 'D-023'],
    ['heavy-e2s16-adm', 7.76, 'D-023'],
  ])('reproduces %s spot USD per active agent-month (%s, %s)', (id, expected) => {
    expect(perActiveSpot(id)).toBeCloseTo(expected, 0);
    expect(Math.abs(perActiveSpot(id) - expected) / expected).toBeLessThan(0.02);
  });

  it('prices an idle Server inside the D-022 6-9 USD range at spot resource rates', () => {
    const { floor } = serverMonthUsd();
    expect(floor).toBeGreaterThanOrEqual(6);
    expect(floor).toBeLessThanOrEqual(9);
  });

  it('packs ~14 Servers on a 64 GiB host with a 10 GiB reserve (D-045)', () => {
    expect(tenantsPerHost()).toBe(14);
  });
});

describe('cost-model levers', () => {
  it('a freed GiB per Server raises the packing and lowers both Server prices', () => {
    expect(tenantsPerHost(1)).toBeGreaterThan(tenantsPerHost(0));
    const before = serverMonthUsd(0);
    const after = serverMonthUsd(1);
    expect(after.floor).toBeLessThan(before.floor);
    expect(after.packed).toBeLessThan(before.packed);
  });

  it('refuses a saving that is negative or at least the whole Server', () => {
    expect(() => serverRamGiB(-0.1)).toThrow(/out of range/);
    expect(() => serverRamGiB(3.6)).toThrow(/out of range/);
  });

  it('marks the P-532 rows PENDING until the saving is measured, then prices them', () => {
    expect(row('M5').pending).toBe(true);
    const measured = row('M5', 50, 1);
    expect(measured.pending).toBe(false);
    expect(measured.totalUsd.packed).toBeLessThan(row('M4').totalUsd.packed);
  });

  it('a dedicated VM must hold its own p99 busy agents plus the Server slot', () => {
    // 50 agents x 0.35 x 1.3 = 22.75 busy at p99, inside one e2-standard-8 (32 - 1 slots).
    expect(dedicatedHosts(50, capacity('mixed-e2s8'))).toBe(1);
    expect(dedicatedHosts(1, capacity('mixed-e2s4'))).toBe(1);
    // 100 agents need 45.5 at p99: two e2-standard-8.
    expect(dedicatedHosts(100, capacity('mixed-e2s8'))).toBe(2);
  });

  it('each lever row costs no more than the row it builds on', () => {
    const rows = buildRows(TARGET.agents, 1);
    for (const ladder of [
      ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'],
      ['H0', 'H1', 'H2', 'H3'],
    ]) {
      for (let i = 1; i < ladder.length; i++) {
        const prev = rows.find((r) => r.id === ladder[i - 1])!;
        const cur = rows.find((r) => r.id === ladder[i])!;
        expect(cur.totalUsd.packed, `${cur.id} vs ${prev.id}`).toBeLessThanOrEqual(prev.totalUsd.packed);
      }
    }
  });

  it('grades a row on its packed total against the target scaled to the agent count', () => {
    for (const r of buildRows(TARGET.agents, null)) {
      expect(r.meetsTarget, r.id).toBe(r.totalUsd.packed <= TARGET.googleUsdMonthMax);
    }
  });

  it('a 1-agent workspace in a shared pool costs mostly its Server', () => {
    const r = row('M3', 1);
    expect(r.serverUsd.packed).toBeGreaterThan(5 * r.computeUsd);
    expect(row('M1', 1).totalUsd.packed).toBeGreaterThan(5 * r.totalUsd.packed);
  });
});

describe('cost-model rendering', () => {
  it('shows a lower-bound capacity as an upper-bound cost and an unmeasured lever as PENDING', () => {
    const md = renderMarkdown(buildRows(TARGET.agents, null));
    expect(md).toMatch(/\| H2 \|[^\n]*\| <=\d/);
    expect(md).toMatch(/\| M5 \|[^\n]*PENDING P-532 \|$/m);
    expect(md).not.toMatch(/\| M4 \|[^\n]*PENDING/);
  });
});
