import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capacityRow, parseRampLog } from './capacity-table';
import {
  buildRows,
  allocatePoolBill,
  CAPACITY,
  capacity,
  dedicatedHosts,
  evaluate,
  hostMonthUsd,
  onDemandMonthUsd,
  renderMarkdown,
  SCENARIOS,
  serverMonthUsd,
  serverRamGiB,
  TARGET,
  tenantsPerHost,
  type PoolBillLine,
} from './cost-model';

const perActiveSpot = (id: string) => hostMonthUsd(capacity(id).machineType, true) / capacity(id).active;
const row = (id: string, agents = 50, saved: number | null = null) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return evaluate(s, agents, saved);
};

describe('cost-model inputs', () => {
  // Original GCP output, retained with the full source-file hashes. Do not compare the model
  // only with old decision prose: D-020 corrected D-019's slot-based pricing, but the model
  // and its old regression both retained 64 instead of the 60.1 sessions actually held.
  const { measurements } = JSON.parse(readFileSync(new URL('./fixtures/capacity-ramps.json', import.meta.url), 'utf8')) as {
    measurements: Array<{
      capacityId: string;
      source: string;
      sourceSha256: string;
      label?: string;
      verdictLines?: string[];
      summary?: { failed: number; achievedConcurrency: { target: number; mean: number } };
    }>;
  };

  it('retains original measurement evidence for every model capacity input', () => {
    expect(measurements.map((m) => m.capacityId).sort()).toEqual(CAPACITY.map((c) => c.id).sort());
    for (const m of measurements) {
      expect(m.source).not.toBe('');
      expect(m.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it.each(measurements)('$capacityId uses achieved concurrency and censoring from the original run', (m) => {
    const c = capacity(m.capacityId);
    if (m.verdictLines && m.label) {
      const measured = capacityRow(c.machineType, m.label, parseRampLog(m.verdictLines.join('\n')), { capture: null, sessions: [] }, 120);
      expect(measured.activeAgents).not.toBeNull();
      expect(c.active).toBe(measured.activeAgents);
      expect(c.atLeast ?? false).toBe(measured.censored);
    } else {
      expect(m.summary).toBeDefined();
      expect(m.summary?.failed).toBe(0);
      expect(c.active).toBe(Math.min(m.summary!.achievedConcurrency.target, m.summary!.achievedConcurrency.mean));
      expect(c.atLeast).toBe(true); // D-040's last tested step; no saturation run followed it.
    }
  });

  it('every capacity row cites a plan Decision', () => {
    for (const c of CAPACITY) expect(c.source, c.id).toMatch(/\bD-\d{3}\b/);
  });

  // Reproduce the achieved-concurrency figures, including D-020's correction to D-019.
  it.each([
    ['mixed-e2s16', 4.11, 'D-020'],
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
    // 50 agents x 0.35 x 1.3 = 22.75 busy at p99, inside one e2-standard-8 (31.6 - 1 active).
    expect(dedicatedHosts(50, capacity('mixed-e2s8'))).toBe(1);
    expect(dedicatedHosts(1, capacity('mixed-e2s4'))).toBe(1);
    // 100 agents need 45.5 at p99: two e2-standard-8.
    expect(dedicatedHosts(100, capacity('mixed-e2s8'))).toBe(2);
    // 135 agents: 61.425 busy at p99 over 30.6 usable active capacity = 3 hosts. Sizing on the
    // mean (47.25 busy) or forgetting the Server slot (61.425 / 31.6) would both give 2.
    expect(dedicatedHosts(135, capacity('mixed-e2s8'))).toBe(3);
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

describe('on-demand workspace month', () => {
  const profile = { computeHourlyUsd: 0.06, retainedDiskGiB: 52, diskGiBMonthUsd: 0.1,
    backupMonthUsd: 0.8, controlMonthUsd: 1, networkMonthUsd: 2, activeIpv4HourlyUsd: 0.005,
    inferenceMonthUsd: 1.5 };

  it('retains disks, backups and control costs when the VM never runs', () => {
    const idle = onDemandMonthUsd({ ...profile, activeHours: 0 });
    expect(idle.computeUsd).toBe(0);
    expect(idle.ipv4Usd).toBe(0);
    expect(idle.retainedUsd).toBeCloseTo(7);
    expect(idle.inferenceUsd).toBeCloseTo(1.5);
    expect(idle.totalUsd).toBeCloseTo(10.5);
  });

  it.each([[60, 14.4], [120, 18.3], [240, 26.1]])('prices %s active hours without prorating retained storage or monthly inference', (activeHours, total) => {
    const result = onDemandMonthUsd({ ...profile, activeHours });
    expect(result.storageUsd).toBeCloseTo(5.2);
    expect(result.totalUsd).toBeCloseTo(total);
  });

  it('accounts for growing storage independently of running hours', () => {
    const before = onDemandMonthUsd({ ...profile, activeHours: 60 });
    const after = onDemandMonthUsd({ ...profile, activeHours: 60, retainedDiskGiB: 104 });
    expect(after.computeUsd).toBe(before.computeUsd);
    expect(after.totalUsd - before.totalUsd).toBeCloseTo(5.2);
  });

  it('rejects missing, negative and non-finite inputs and hours beyond one month', () => {
    const input = { ...profile, activeHours: 60 };
    for (const key of Object.keys(input) as (keyof typeof input)[]) {
      for (const bad of [-1, NaN, Infinity, undefined]) {
        expect(() => onDemandMonthUsd({ ...input, [key]: bad } as Parameters<typeof onDemandMonthUsd>[0])).toThrow(/finite/);
      }
      const omitted = { ...input } as Partial<typeof input>;
      delete omitted[key];
      expect(() => onDemandMonthUsd(omitted as typeof input), `omitted ${key}`).toThrow(/finite/);
    }
    expect(() => onDemandMonthUsd({ ...profile, activeHours: 731 })).toThrow(/month/);
  });

  it('requires an explicit inference cost and includes it when a profile crosses $20', () => {
    const result = onDemandMonthUsd({ ...profile, activeHours: 120, inferenceMonthUsd: 3.2 });
    expect(result.inferenceUsd).toBe(3.2);
    expect(result.totalUsd).toBeCloseTo(20);
    const withoutInference = onDemandMonthUsd({ ...profile, activeHours: 120, inferenceMonthUsd: 0 });
    expect(withoutInference.totalUsd).toBeCloseTo(16.8);
  });

  it('rejects finite inputs whose computed monthly charge overflows', () => {
    expect(() => onDemandMonthUsd({ ...profile, activeHours: 730,
      computeHourlyUsd: Number.MAX_VALUE })).toThrow(/finite/);
  });
});

describe('pool bill conservation (synthetic accounting fixtures, not measured prices)', () => {
  const line = (patch: Partial<PoolBillLine> = {}): PoolBillLine => ({
    id: 'compute', periodRef: 'invoice:2026-10', provider: 'gcp', currency: 'USD',
    category: 'compute', kind: 'charge', amountMicros: 101, sourceRef: 'fixture:invoice',
    allocation: { kind: 'compute', achievedAgentMilliseconds: 1000,
      capacityEvidenceRef: 'fixture:measured-capacity', tenants: [{ tenantId: 'tenant-a', activeAgentMilliseconds: 500 }] },
    ...patch,
  });
  const bill = (lines: PoolBillLine[], totalMicros = lines.reduce((sum, row) => sum + (row.amountMicros ?? 0), 0)) =>
    allocatePoolBill({ periodRef: 'invoice:2026-10', currency: 'USD', totalMicros, lines });

  it.each([1, 50])('conserves a bill for %i agents and exposes unused achieved capacity as overhead', (agents) => {
    const result = bill([line({ allocation: { kind: 'compute', achievedAgentMilliseconds: (agents + 1) * 1000,
      capacityEvidenceRef: 'fixture:measured-capacity',
      tenants: Array.from({ length: agents }, (_, n) => ({ tenantId: `tenant-${n}`, activeAgentMilliseconds: 1000 })) } })]);
    expect(result.complete).toBe(true);
    expect(result.tenants).toHaveLength(agents);
    expect(result.tenants.reduce((sum, row) => sum + row.amountMicros, 0) + result.overheadMicros).toBe(101);
    expect(result.unallocatedMicros).toBe(0);
    expect(result.overheadMicros).toBeGreaterThan(0);
  });

  it('uses achieved capacity rather than nominal slots when allocating compute', () => {
    expect(bill([line({ amountMicros: 100 })]).tenants[0].amountMicros).toBe(50);
    const result = bill([line({ amountMicros: 100, allocation: { kind: 'compute', achievedAgentMilliseconds: 500,
      capacityEvidenceRef: 'fixture:measured-lower-capacity', tenants: [{ tenantId: 'tenant-a', activeAgentMilliseconds: 500 }] } })]);
    expect(result.tenants[0].amountMicros).toBe(100);
    expect(result.overheadMicros).toBe(0);
  });

  it('retains every resource class and mixed-provider costs at zero activity', () => {
    const categories: PoolBillLine['category'][] = ['compute', 'persistent-storage', 'provisioned-performance',
      'backup', 'object-storage', 'network', 'control-plane', 'warm-capacity', 'inference'];
    const result = bill(categories.map((category, n) => line({ id: category, category,
      provider: n % 2 ? 'aws' : 'gcp', amountMicros: n + 1,
      allocation: { kind: 'compute', achievedAgentMilliseconds: 0, capacityEvidenceRef: 'fixture:idle', tenants: [] } })));
    expect(result.overheadMicros).toBe(45);
    expect(result.tenantTotalMicros).toBe(0);
    expect(result.lines.map((row) => row.category)).toEqual(categories);
    expect(result.complete).toBe(true);
  });

  it('splits indivisible micros deterministically, independent of tenant order', () => {
    const tenants = [{ tenantId: 'b', weight: 1 }, { tenantId: 'a', weight: 1 }];
    const project = (rows: typeof tenants) => bill([line({ amountMicros: 2,
      allocation: { kind: 'weighted', tenants: rows, overheadWeight: 1 } })]);
    const result = project(tenants);
    expect(result.tenants).toEqual([{ tenantId: 'a', amountMicros: 1 }, { tenantId: 'b', amountMicros: 1 }]);
    expect(result.overheadMicros).toBe(0);
    expect(project([...tenants].reverse())).toEqual(result);
  });

  it('conserves signed credits while exposing the credits-excluded steady-state total', () => {
    const result = bill([line({ amountMicros: 101 }), line({ id: 'credit', kind: 'credit', amountMicros: -51 })]);
    expect(result.totalMicros).toBe(50);
    expect(result.creditsMicros).toBe(-51);
    expect(result.creditsExcludedTotalMicros).toBe(101);
    expect(result.tenantTotalMicros + result.overheadMicros + result.unallocatedMicros).toBe(50);
    expect(result.lines[1].tenants[0].amountMicros).toBe(-26);
    expect(result.lines[1].overheadMicros).toBe(-25);
  });

  it.each([0, 29])('keeps missing prices unknown even with a %i-micro invoice residual', (residual) => {
    const result = bill([line(), line({ id: 'unpriced-backup', category: 'backup', amountMicros: null })], 101 + residual);
    expect(result.complete).toBe(false);
    expect(result.unpricedLineIds).toEqual(['unpriced-backup']);
    expect(result.unknownRateAllocationMicros).toBe(residual);
    expect(result.unallocatedMicros).toBe(residual);
    expect(result.creditsExcludedTotalMicros).toBeNull();
    expect(result.lines[1]).toMatchObject({ amountMicros: null, overheadMicros: null, unallocatedMicros: null });
    expect(result.tenantTotalMicros + result.overheadMicros + result.unallocatedMicros).toBe(result.totalMicros);
  });

  it('preserves unresolved tenant ownership separately from shared overhead', () => {
    const result = bill([line({ allocation: { kind: 'unresolved', reason: 'usage-census-missing' } })]);
    expect(result).toMatchObject({ complete: false, overheadMicros: 0, unallocatedMicros: 101, tenantTotalMicros: 0 });
    expect(result.gaps).toEqual(['unresolved-allocation:compute']);
  });

  it('keeps an unpriced credit as an unresolved reduction rather than free capacity', () => {
    const result = bill([line(), line({ id: 'unpriced-credit', kind: 'credit', amountMicros: null })], 99);
    expect(result).toMatchObject({ totalMicros: 99, unknownRateAllocationMicros: -2,
      unallocatedMicros: -2, complete: false, creditsExcludedTotalMicros: null });
    expect(result.tenantTotalMicros + result.overheadMicros + result.unallocatedMicros).toBe(99);
  });

  it('rejects currency, period, identity, sign and total mismatches', () => {
    for (const patch of [{ currency: 'EUR' }, { periodRef: 'invoice:other' }, { sourceRef: '' }, { provider: '' },
      { amountMicros: -1 }, { kind: 'credit', amountMicros: 1 }]) {
      expect(() => bill([line(patch as Partial<PoolBillLine>)])).toThrow();
    }
    expect(() => bill([line(), line()])).toThrow('duplicate');
    expect(() => bill([line()], 100)).toThrow('does not reconcile');
    expect(() => bill([line({ amountMicros: null })], -1)).toThrow('does not reconcile');
    expect(() => bill([line({ amountMicros: null, kind: 'credit' })], 1)).toThrow('does not reconcile');
  });

  it('rejects unmeasured capacity, over-allocation and invalid integer counters', () => {
    for (const achieved of [-1, NaN, Infinity, 0.5, 499, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bill([line({ allocation: { kind: 'compute', achievedAgentMilliseconds: achieved,
        capacityEvidenceRef: 'fixture:measured-capacity', tenants: [{ tenantId: 'a', activeAgentMilliseconds: 500 }] } })])).toThrow();
    }
    expect(() => bill([line({ allocation: { kind: 'compute', achievedAgentMilliseconds: 1000,
      capacityEvidenceRef: '', tenants: [] } })])).toThrow('reference');
    expect(() => bill([line({ allocation: { kind: 'weighted', overheadWeight: 0,
      tenants: [{ tenantId: 'a', weight: 1 }, { tenantId: 'a', weight: 1 }] } })])).toThrow('duplicate');
    expect(() => bill([line({ amountMicros: 0.5 })], 0)).toThrow('line amount');
  });

  it('conserves every small signed bill across a census of asymmetric and empty allocation weights', () => {
    for (let micros = -17; micros <= 17; micros++) {
      for (let a = 0; a <= 3; a++) for (let b = 0; b <= 3; b++) for (let shared = 0; shared <= 3; shared++) {
        const result = bill([line({ amountMicros: micros, kind: micros < 0 ? 'credit' : 'charge',
          allocation: { kind: 'weighted', overheadWeight: shared,
            tenants: [{ tenantId: 'a', weight: a }, { tenantId: 'b', weight: b }] } })]);
        expect(result.tenantTotalMicros + result.overheadMicros + result.unallocatedMicros).toBe(micros);
        const weights = a + b + shared === 0 ? [0, 0, 1] : [a, b, shared];
        const shares = [...result.tenants.map((tenant) => tenant.amountMicros), result.overheadMicros];
        for (let n = 0; n < shares.length; n++) {
          const exact = Math.abs(micros) * weights[n] / weights.reduce((sum, value) => sum + value, 0);
          expect(Math.abs(shares[n])).toBeGreaterThanOrEqual(Math.floor(exact));
          expect(Math.abs(shares[n])).toBeLessThanOrEqual(Math.ceil(exact));
          expect(shares[n] * micros).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('conserves exact large values and refuses unsafe aggregate projections', () => {
    const result = bill([line({ amountMicros: Number.MAX_SAFE_INTEGER })]);
    expect(BigInt(result.tenantTotalMicros) + BigInt(result.overheadMicros)).toBe(BigInt(Number.MAX_SAFE_INTEGER));
    expect(() => bill([line({ id: 'one', amountMicros: Number.MAX_SAFE_INTEGER }),
      line({ id: 'two', amountMicros: Number.MAX_SAFE_INTEGER }),
      line({ id: 'offset', kind: 'credit', amountMicros: -Number.MAX_SAFE_INTEGER })])).toThrow('overflow');
    expect(() => bill([line({ amountMicros: Number.MAX_SAFE_INTEGER }), line({ id: 'one-more', amountMicros: 1 })])).toThrow();
  });
});
