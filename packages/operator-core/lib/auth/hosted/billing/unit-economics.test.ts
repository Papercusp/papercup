import { describe, expect, it } from 'vitest';
import { calculatePilotEconomics, PILOT_COST_CATEGORIES, type PilotCostLine, type PilotPriceSheet } from './unit-economics';

const time = 1_000_000;
const provenance = { evidenceRef: 'fixture:observed-cost', measuredAtMs: time };
function line(category: PilotCostLine['category'], quantity = 0, micros = 1_000_000): PilotCostLine {
  return {
    id: category, category, payer: ['support', 'platform-overhead'].includes(category) ? 'platform' : 'consumption',
    quantity, unit: 'fixture-unit', usage: { ...provenance, kind: 'observed' },
    rate: { ...provenance, kind: 'provider-billed', unit: 'fixture-unit', unitsPerRate: 1, microsPerRate: micros },
  };
}
function sheet(overrides: Partial<PilotPriceSheet> = {}): PilotPriceSheet {
  return {
    version: 'fixture-v1', asOfMs: time, maximumEvidenceAgeMs: 1000,
    lines: PILOT_COST_CATEGORIES.map((category) => line(category)),
    platformPriceCents: 10_000, consumptionPriceCents: 2_000, includedAllowanceMicros: 20_000_000,
    inferenceMode: 'managed', overage: 'stop',
    paymentFee: { ...provenance, kind: 'merchant-confirmed', percentageBps: 290, fixedCents: 30 },
    targetPlatformMarginBps: 5000, targetConsumptionMarginBps: 2000, ...overrides,
  };
}
function replace(base: PilotPriceSheet, category: PilotCostLine['category'], patch: Partial<PilotCostLine>): PilotPriceSheet {
  return { ...base, lines: base.lines.map((row) => row.category === category ? { ...row, ...patch } : row) };
}

describe('pilot unit economics (synthetic arithmetic fixtures, not customer measurements)', () => {
  it.each([
    ['idle', 0, 1, 1, 0, 2, 4_000_000],
    ['normal', 5, 1, 1, 2, 2, 11_000_000],
    ['heavy', 20, 2, 2, 5, 4, 33_000_000],
    ['burst', 50, 2, 2, 10, 8, 72_000_000],
  ] as const)('reproduces %s including retained resources', (_name, compute, storage, ip, egress, support, total) => {
    const quantities = { compute, 'persistent-storage': storage, 'external-ip': ip, egress, support };
    const result = calculatePilotEconomics(sheet({ lines: PILOT_COST_CATEGORIES.map((category) => line(category, quantities[category as keyof typeof quantities] ?? 0)) }));
    expect(result.costs.reduce((sum, row) => sum + row.micros!, 0)).toBe(total);
    expect(result.platform.costMicros).toBe(support * 1_000_000);
    expect(result.consumption.costMicros).toBe((compute + storage + ip + egress) * 1_000_000);
    expect(result.paymentFeeCents).toBe(378);
  });

  it('allocates processing fees without loss and keeps platform/consumption margins separate', () => {
    const result = calculatePilotEconomics(replace(replace(sheet(), 'support', { quantity: 30 }), 'compute', { quantity: 10 }));
    expect(result.platform.paymentFeeMicros).toBe(3_200_000);
    expect(result.consumption.paymentFeeMicros).toBe(580_000);
    expect(result.platform.profitMicros).toBe(66_800_000);
    expect(result.consumption.profitMicros).toBe(9_420_000);
    expect(result.platform.marginBps).toBe(6680);
    expect(result.consumption.marginBps).toBe(4710);
    expect(result.platform.paymentFeeMicros! + result.consumption.paymentFeeMicros!).toBe(result.paymentFeeCents! * 10_000);
    expect(result.quoteAllowed).toBe(true);
  });

  it('uses margin, not markup, and gives a minimal fee-inclusive whole-cent quote', () => {
    const base = replace(sheet({ consumptionPriceCents: 0, paymentFee: { ...provenance, kind: 'merchant-confirmed', percentageBps: 0, fixedCents: 0 } }), 'support', { quantity: 100 });
    const result = calculatePilotEconomics({ ...base, platformPriceCents: 12_000, targetPlatformMarginBps: 2000 });
    expect(result.platform.marginBps).toBe(1666); // 20% markup is 16.66% margin.
    expect(result.platform.targetMet).toBe(false);
    expect(result.platform.minimumPriceCents).toBe(12_500);
    const floor = calculatePilotEconomics({ ...base, platformPriceCents: 12_500, targetPlatformMarginBps: 2000 });
    expect(floor.platform.targetMet).toBe(true);
    expect(calculatePilotEconomics({ ...base, platformPriceCents: 12_499, targetPlatformMarginBps: 2000 }).platform.targetMet).toBe(false);
  });

  it('finds the exact price floor despite whole-cent fee rounding', () => {
    const base = replace(sheet({ consumptionPriceCents: 0 }), 'support', { quantity: 40 });
    const result = calculatePilotEconomics(base);
    const price = result.platform.minimumPriceCents!;
    expect(calculatePilotEconomics({ ...base, platformPriceCents: price }).platform.targetMet).toBe(true);
    expect(calculatePilotEconomics({ ...base, platformPriceCents: price - 1 }).platform.targetMet).toBe(false);
  });

  it.each([[10_001, 290, 5000], [123_456, 3333, 5000], [1000, 1, 9998], [5001, 4000, 5000]])(
    'matches an independent exhaustive quote oracle for cost=%s fee=%s target=%s', (cost, fee, target) => {
      let expected = 1;
      while ((expected * 10_000 - cost - (Math.ceil(expected * fee / 10_000) + 30) * 10_000) * 10_000 < expected * 10_000 * target) expected++;
      const base = replace(sheet({ targetPlatformMarginBps: target, paymentFee: { ...provenance, kind: 'merchant-confirmed', percentageBps: fee, fixedCents: 30 } }), 'support', { quantity: 1, rate: { ...sheet().lines[0].rate!, microsPerRate: cost } });
      expect(calculatePilotEconomics(base).platform.minimumPriceCents).toBe(expected);
    },
  );

  it('does not bill customer-direct BYOK cost as Papercusp consumption', () => {
    const base = sheet({ inferenceMode: 'customer-key', consumptionPriceCents: 0 });
    const lines = base.lines.map((row): PilotCostLine => row.category.startsWith('inference-') || row.category.startsWith('cache-')
      ? { ...row, payer: 'customer-direct', quantity: row.category === 'inference-output' ? 17 : 0 } : row);
    const result = calculatePilotEconomics({ ...base, lines });
    expect(result.customerDirectKnownCostMicros).toBe(17_000_000);
    expect(result.consumption.costMicros).toBe(0);
    expect(result.quoteAllowed).toBe(true);
    expect(() => calculatePilotEconomics(base)).toThrow('inference payer');
  });

  it('prices uncached, output and cache usage as distinct inputs', () => {
    const base = sheet({ lines: PILOT_COST_CATEGORIES.map((category) => line(category,
      category === 'inference-input' ? 10 : category === 'cache-read' ? 90 : category === 'cache-write' ? 5 : category === 'inference-output' ? 20 : 0,
      category === 'cache-read' ? 100_000 : category === 'cache-write' ? 1_250_000 : category === 'inference-output' ? 5_000_000 : 1_000_000)) });
    expect(calculatePilotEconomics(base).consumption.costMicros).toBe(125_250_000);
  });

  it('rounds a fractional rate up only to a micro, and fees only once per invoice', () => {
    const base = replace(sheet({ platformPriceCents: 1, consumptionPriceCents: 1 }), 'compute', {
      quantity: 2, rate: { ...provenance, unit: 'fixture-unit', unitsPerRate: 3, microsPerRate: 1, kind: 'provider-billed' },
    });
    const result = calculatePilotEconomics(base);
    expect(result.consumption.costMicros).toBe(1);
    expect(result.paymentFeeCents).toBe(31);
    expect(result.platform.paymentFeeMicros! + result.consumption.paymentFeeMicros!).toBe(310_000);
  });

  it.each(['catalog', 'estimate'] as const)('%s prices remain provisional even with observed usage', (kind) => {
    const base = sheet();
    const result = calculatePilotEconomics(replace(base, 'compute', { quantity: 1, rate: { ...base.lines[0].rate!, kind } }));
    expect(result.state).toBe('provisional');
    expect(result.quoteAllowed).toBe(false);
    expect(result.reasons).toContain('estimated-cost:compute');
  });
  it('modeled support and catalog merchant fees cannot certify a real quote', () => {
    const result = calculatePilotEconomics(replace(sheet({ paymentFee: { ...provenance, kind: 'catalog', percentageBps: 290, fixedCents: 30 } }), 'support', { usage: { ...provenance, kind: 'modeled' } }));
    expect(result.state).toBe('provisional');
    expect(result.reasons).toContain('modeled-usage:support');
    expect(result.reasons).toContain('estimated-cost:payment-fee');
  });
  it('missing storage price leaves cost and margin unknown instead of reporting free stopped resources', () => {
    const result = calculatePilotEconomics(replace(sheet(), 'persistent-storage', { quantity: 20, rate: null }));
    expect(result.state).toBe('incomplete');
    expect(result.consumption.costMicros).toBeNull();
    expect(result.consumption.marginBps).toBeNull();
    expect(result.consumption.minimumPriceCents).toBeNull();
    expect(result.quoteAllowed).toBe(false);
    expect(result.reasons).toContain('unpriced:persistent-storage');
  });
  it('requires an explicit observation for each cost category', () => {
    const result = calculatePilotEconomics(sheet({ lines: sheet().lines.filter((row) => row.category !== 'external-ip') }));
    expect(result.state).toBe('incomplete');
    expect(result.reasons).toContain('missing-cost:external-ip');
    expect(result.platform.marginBps).toBeNull();
  });
  it('permits observed zero exposure without inventing a rate', () => {
    expect(calculatePilotEconomics(replace(sheet(), 'external-ip', { quantity: 0, rate: null })).state).toBe('measured');
  });
  it('rejects stale and future-dated evidence as quote certification', () => {
    for (const measuredAtMs of [time - 1001, time + 1]) {
      const result = calculatePilotEconomics(replace(sheet(), 'compute', { usage: { ...provenance, measuredAtMs, kind: 'observed' } }));
      expect(result.state).toBe('provisional');
      expect(result.quoteAllowed).toBe(false);
      expect(result.reasons).toContain('stale-evidence:compute:usage');
    }
  });
  it('unknown fees do not produce a known margin', () => {
    const result = calculatePilotEconomics(sheet({ paymentFee: null }));
    expect(result.state).toBe('incomplete');
    expect(result.platform.marginBps).toBeNull();
    expect(result.paymentFeeCents).toBeNull();
  });
  it('reports uncharged consumption and negative margins faithfully', () => {
    const result = calculatePilotEconomics(replace(sheet({ consumptionPriceCents: 0, platformPriceCents: 1 }), 'compute', { quantity: 5 }));
    expect(result.reasons).toContain('unfunded-consumption');
    expect(result.platform.marginBps).toBe(-300_000);
    expect(result.quoteAllowed).toBe(false);
  });
  it('does not incur a transaction fee when no invoice is charged', () => {
    const result = calculatePilotEconomics(sheet({ platformPriceCents: 0, consumptionPriceCents: 0 }));
    expect(result.paymentFeeCents).toBe(0);
    expect(result.platform.marginBps).toBeNull();
    expect(result.quoteAllowed).toBe(false);
  });
  it('reports impossible fee-plus-margin targets without an invented quote', () => {
    const result = calculatePilotEconomics(sheet({ targetPlatformMarginBps: 9800 }));
    expect(result.platform.minimumPriceCents).toBeNull();
    expect(result.quoteAllowed).toBe(false);
  });
  it.each([-1, 0, Infinity, NaN])('rejects a non-finite or non-positive allowance %s', (includedAllowanceMicros) => {
    expect(() => calculatePilotEconomics(sheet({ includedAllowanceMicros }))).toThrow('finite allowance');
  });
  it('rejects duplicate cost ids, mismatched units and invalid billing units', () => {
    const base = sheet();
    expect(() => calculatePilotEconomics({ ...base, lines: [...base.lines, base.lines[0]] })).toThrow('duplicate');
    expect(() => calculatePilotEconomics(replace(base, 'compute', { unit: 'wrong' }))).toThrow('unit mismatch');
    expect(() => calculatePilotEconomics(replace(base, 'compute', { quantity: 0.5 }))).toThrow('quantity');
    expect(() => calculatePilotEconomics(replace(base, 'compute', { rate: { ...base.lines[0].rate!, unitsPerRate: 0 } }))).toThrow('rate units');
  });
  it('uses exact intermediate multiplication and refuses unsafe final amounts', () => {
    const base = replace(sheet(), 'compute', { quantity: 1_000_000_000, rate: { ...sheet().lines[0].rate!, unitsPerRate: 1_000_000_000, microsPerRate: 1_000_000_000 } });
    expect(calculatePilotEconomics(base).consumption.costMicros).toBe(1_000_000_000);
    expect(() => calculatePilotEconomics(replace(base, 'compute', { rate: { ...base.lines[0].rate!, unitsPerRate: 1 } }))).toThrow('overflow');
    expect(() => calculatePilotEconomics(sheet({ platformPriceCents: Number.MAX_SAFE_INTEGER }))).toThrow('overflow');
  });
});
