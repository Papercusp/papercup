import { describe, expect, it } from 'vitest';
import { buildHostedUsageStatement, type HostedUsageRecord } from './usage-statement';

const JAN = Date.UTC(2026, 0, 1);
const FEB = Date.UTC(2026, 1, 1);
const NOW = FEB + 1000;
function receipt(patch: Partial<HostedUsageRecord> = {}): HostedUsageRecord {
  return { controlWorkspaceId: 'control', organizationId: 'org-a', customerWorkspaceId: 'ws-a',
    recordId: 'receipt-a', usageId: 'usage-a', revision: 1, provider: 'openrouter',
    category: 'inference-input', payer: 'consumption', occurredAtMs: JAN + 1000, observedAtMs: JAN + 2000,
    quantity: 100, unit: 'tokens', costSource: 'provider-billed', costMicros: 10_001,
    sourceRef: 'provider:receipt-a', ...patch };
}
function statement(records: readonly HostedUsageRecord[], patch: Partial<Parameters<typeof buildHostedUsageStatement>[0]> = {}) {
  return buildHostedUsageStatement({ scope: { controlWorkspaceId: 'control', organizationId: 'org-a', customerWorkspaceId: null },
    month: '2026-01', asOfMs: NOW, source: { complete: true, observedAtMs: NOW, maximumAgeMs: 1000, evidenceRef: 'collector:census' }, records, ...patch });
}

describe('hosted usage statement projection (collector fixtures, not customer billing)', () => {
  it('reconciles distinct input/output/cache, retained compute/storage/IP and egress costs exactly', () => {
    const categories = ['inference-input', 'inference-output', 'cache-read', 'cache-write', 'compute', 'persistent-storage', 'external-ip', 'egress'] as const;
    const result = statement(categories.map((category, i) => receipt({ category, recordId: `r-${i}`, usageId: `u-${i}`, costMicros: i + 1 })));
    expect(result.lines).toHaveLength(8);
    expect(result.consumptionBilled).toEqual({ micros: 36, wholeCents: 0, roundingMicros: 36 });
    expect(result.settlementEligible).toBe(true);
  });

  it('replay does not change quantities, usage count, costs or evidence history', () => {
    const row = receipt();
    expect(statement([row, { ...row }, row])).toEqual(statement([row]));
  });

  it('rejects a changed immutable receipt rather than silently accepting its retry', () => {
    expect(() => statement([receipt(), receipt({ costMicros: 99 })])).toThrow('replay mismatch');
  });

  it('does not mix overlapping IDs across organizations or control workspaces', () => {
    const result = statement([receipt(), receipt({ organizationId: 'org-b', costMicros: 999_999, sourceRef: 'foreign:evidence' }),
      receipt({ controlWorkspaceId: 'other-control', costMicros: 999_999 })]);
    expect(result).toEqual(statement([receipt()]));
    expect(JSON.stringify(result)).not.toContain('foreign:evidence');
  });

  it('allows the same provider receipt ID in distinct customer workspaces, with exact workspace filtering', () => {
    const rows = [receipt(), receipt({ customerWorkspaceId: 'ws-b', costMicros: 20_001 })];
    expect(statement(rows).consumptionBilled.micros).toBe(30_002);
    const scoped = statement(rows, { scope: { controlWorkspaceId: 'control', organizationId: 'org-a', customerWorkspaceId: 'ws-b' } });
    expect(scoped.lines.map((line) => line.customerWorkspaceId)).toEqual(['ws-b']);
    expect(scoped.consumptionBilled.micros).toBe(20_001);
  });

  it('keeps estimated, reported and unpriced usage separate from billed amounts', () => {
    const result = statement([receipt({ costSource: 'estimate', costMicros: 50 }),
      receipt({ recordId: 'r-b', usageId: 'u-b', costSource: 'provider-reported', costMicros: 75 }),
      receipt({ recordId: 'r-c', usageId: 'u-c', costSource: 'unpriced', costMicros: null })]);
    expect(result.lines[0]).toMatchObject({ quantity: 300, usages: 3, estimatedMicros: 50, reportedMicros: 75, billedMicros: 0, unpricedUsages: 1 });
    expect(result.settlementEligible).toBe(false);
    expect(result.gaps).toEqual(['estimated-cost', 'unpriced-usage', 'unreconciled-provider-cost']);
  });

  it('late billing replaces the estimate once and preserves traceable receipt revisions', () => {
    const estimate = receipt({ costSource: 'estimate', costMicros: 999 });
    const billed = receipt({ recordId: 'receipt-b', revision: 2, observedAtMs: FEB, costMicros: 10_001, sourceRef: 'invoice:line-b' });
    const result = statement([billed, estimate, billed]);
    expect(result.settlementEligible).toBe(true);
    expect(result.lines[0]).toMatchObject({ usages: 1, quantity: 100, estimatedMicros: 0, billedMicros: 10_001 });
    expect(result.history[0]?.revisions.map((row) => row.sourceRef)).toEqual(['provider:receipt-a', 'invoice:line-b']);
    expect(statement([estimate, billed])).toEqual(result);
  });

  it('cost corrections replace an earlier bill without adding another charge', () => {
    const result = statement([receipt(), receipt({ recordId: 'credit-correction', revision: 2, costMicros: 2000, observedAtMs: FEB })]);
    expect(result.consumptionBilled.micros).toBe(2000);
    expect(result.history[0]?.revisions.map((row) => row.costMicros)).toEqual([10_001, 2000]);
  });

  it.each([
    { recordId: 'r-b' },
    { recordId: 'r-b', revision: 2, occurredAtMs: JAN + 2000 },
    { recordId: 'r-b', revision: 2, category: 'egress' as const },
    { recordId: 'r-b', revision: 2, payer: 'customer-direct' as const },
    { recordId: 'r-b', revision: 2, unit: 'bytes' },
    { recordId: 'r-b', revision: 2, observedAtMs: JAN + 1500 },
    { recordId: 'r-b', revision: 2, costSource: 'estimate' as const },
  ])('rejects ambiguous, identity-changing or downgraded revisions: %j', (patch) => {
    expect(() => statement([receipt(), receipt(patch)])).toThrow('conflicting usage revision');
  });

  it('takes provider and platform costs out of customer-direct BYOK totals without dropping disclosure', () => {
    const result = statement([receipt(), receipt({ recordId: 'byok', usageId: 'byok', payer: 'customer-direct', costMicros: 700 }),
      receipt({ recordId: 'support', usageId: 'support', category: 'support', payer: 'platform', costMicros: 300 })]);
    expect(result.consumptionBilled.micros).toBe(10_001);
    expect(result.customerDirectBilledMicros).toBe(700);
    expect(result.platformBilledMicros).toBe(300);
  });

  it('rounds once after monthly aggregation and retains every sub-cent micro', () => {
    const result = statement([receipt({ costMicros: 9999 }), receipt({ recordId: 'r-b', usageId: 'u-b', costMicros: 2 })]);
    expect(result.consumptionBilled).toEqual({ micros: 10_001, wholeCents: 1, roundingMicros: 1 });
    expect(result.consumptionBilled.wholeCents * 10_000 + result.consumptionBilled.roundingMicros).toBe(result.consumptionBilled.micros);
  });

  it('uses UTC start-inclusive/end-exclusive occurrence windows, even when billing arrives later', () => {
    const result = statement([receipt({ occurredAtMs: JAN, costMicros: 5 }),
      receipt({ recordId: 'old', usageId: 'old', occurredAtMs: JAN - 1, costMicros: 99 }),
      receipt({ recordId: 'next', usageId: 'next', occurredAtMs: FEB, observedAtMs: FEB, costMicros: 99 })]);
    expect(result.consumptionBilled.micros).toBe(5);
    expect(result.history).toHaveLength(1);
  });

  it('does not use a receipt that was unknown at the requested as-of time', () => {
    expect(statement([receipt(), receipt({ recordId: 'late', revision: 2, observedAtMs: NOW + 1, costMicros: 500 })])).toEqual(statement([receipt()]));
  });

  it('keeps an empty incomplete census unknown and requires a fresh completeness receipt', () => {
    expect(statement([], { source: { complete: false, observedAtMs: NOW - 2000, maximumAgeMs: 1000, evidenceRef: 'collector:partial' } }))
      .toMatchObject({ settlementEligible: false, gaps: ['incomplete-source', 'source-not-current'] });
    expect(statement([])).toMatchObject({ settlementEligible: true, lines: [], consumptionBilled: { micros: 0 } });
    expect(statement([], { source: { complete: true, observedAtMs: NOW + 1, maximumAgeMs: 1000, evidenceRef: 'collector:future' } }).settlementEligible).toBe(false);
  });

  it('accepts an explicit zero provider bill without calling unknown cost free', () => {
    expect(statement([receipt({ costMicros: 0 })]).settlementEligible).toBe(true);
    expect(() => statement([receipt({ costMicros: null })])).toThrow('safe integers');
    expect(() => statement([receipt({ costSource: 'unpriced', costMicros: 0 })])).toThrow('unknown cost');
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('refuses invalid cost/counter %s', (value) => {
    expect(() => statement([receipt({ costMicros: value })])).toThrow();
    expect(() => statement([receipt({ quantity: value })])).toThrow();
  });

  it('refuses aggregate overflow instead of losing financial precision', () => {
    expect(() => statement([receipt({ costMicros: Number.MAX_SAFE_INTEGER }), receipt({ recordId: 'r-b', usageId: 'u-b', costMicros: 1 })])).toThrow('safe integer range');
  });

  it('rejects customer content and freeform evidence fields at the metadata boundary', () => {
    expect(() => statement([{ ...receipt(), prompt: 'private source text' } as HostedUsageRecord])).toThrow('unsupported fields');
    expect(() => statement([receipt({ sourceRef: 'private source text' })])).toThrow('identifier');
    const result = statement([receipt()]);
    expect(result.history).toHaveLength(1); // The mechanism and legitimate evidence still work.
    expect(JSON.stringify(result)).not.toContain('private source text');
  });
});
