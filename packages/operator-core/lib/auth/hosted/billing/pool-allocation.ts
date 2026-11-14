/** P544/P538 accounting preparation, not a customer charge or a measured price.
 * Reconcile an observed invoice in integer currency micros. The caller must bind
 * the invoice, achieved-capacity observation and tenant usage to the same period.
 * Requested agent slots are deliberately not an allocation input.
 */
export type PoolBillAllocation =
  | { kind: 'compute'; achievedAgentMilliseconds: number; capacityEvidenceRef: string;
      tenants: readonly { tenantId: string; activeAgentMilliseconds: number }[] }
  | { kind: 'weighted'; overheadWeight: number;
      tenants: readonly { tenantId: string; weight: number }[] }
  | { kind: 'unresolved'; reason: string };

export interface PoolBillLine {
  id: string;
  periodRef: string;
  provider: string;
  currency: string;
  category: 'compute' | 'persistent-storage' | 'provisioned-performance' | 'backup'
    | 'object-storage' | 'network' | 'control-plane' | 'warm-capacity' | 'inference';
  kind: 'charge' | 'credit';
  /** Null retains an unpriced exposure, including when the invoice residual is zero. */
  amountMicros: number | null;
  sourceRef: string;
  allocation: PoolBillAllocation;
}

export function allocatePoolBill(input: {
  periodRef: string; currency: string; totalMicros: number; lines: readonly PoolBillLine[];
}) {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const amount = (value: number, name: string, nonnegative = false): bigint => {
    if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) throw new Error(`invalid ${name}`);
    return BigInt(value);
  };
  const safe = (value: bigint): number => {
    if (value < -max || value > max) throw new Error('pool bill amount overflow');
    return Number(value);
  };
  const ref = (value: string): void => {
    if (typeof value !== 'string' || !value.trim()) throw new Error('missing pool bill reference');
  };
  ref(input.periodRef);
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new Error('invalid pool bill currency');
  const total = amount(input.totalMicros, 'invoice total');
  const tenantTotals = new Map<string, bigint>(), seen = new Set<string>();
  const unpricedLineIds: string[] = [], gaps: string[] = [];
  let known = 0n, overhead = 0n, unallocated = 0n, credits = 0n;
  let unpricedCharge = false, unpricedCredit = false;
  const categories = new Set(['compute', 'persistent-storage', 'provisioned-performance', 'backup',
    'object-storage', 'network', 'control-plane', 'warm-capacity', 'inference']);

  const lines = input.lines.map((line) => {
    ref(line.id); ref(line.provider); ref(line.sourceRef);
    if (seen.has(line.id)) throw new Error('duplicate pool bill line');
    seen.add(line.id);
    if (line.periodRef !== input.periodRef) throw new Error('pool bill period mismatch');
    if (line.currency !== input.currency) throw new Error('pool bill currency mismatch');
    if (!categories.has(line.category) || !['charge', 'credit'].includes(line.kind)) {
      throw new Error('invalid pool bill category or kind');
    }
    const value = line.amountMicros === null ? null : amount(line.amountMicros, 'line amount');
    if (value !== null && (line.kind === 'charge' ? value < 0n : value > 0n)) {
      throw new Error('pool bill charge/credit sign mismatch');
    }

    const weights: { tenantId: string | null; weight: bigint; remainder: bigint; share: bigint }[] = [];
    const allocation = line.allocation;
    if (allocation.kind === 'unresolved') {
      ref(allocation.reason);
      gaps.push(`unresolved-allocation:${line.id}`);
    } else {
      if (!['compute', 'weighted'].includes(allocation.kind)) throw new Error('invalid pool bill allocation');
      const tenants = new Set<string>();
      let used = 0n;
      const weightedTenants = allocation.kind === 'compute'
        ? allocation.tenants.map((tenant) => ({ tenantId: tenant.tenantId, weight: tenant.activeAgentMilliseconds }))
        : allocation.tenants;
      for (const tenant of weightedTenants) {
        ref(tenant.tenantId);
        if (tenants.has(tenant.tenantId)) throw new Error('duplicate pool bill tenant');
        tenants.add(tenant.tenantId);
        const weight = amount(tenant.weight, 'tenant allocation weight', true);
        weights.push({ tenantId: tenant.tenantId, weight, remainder: 0n, share: 0n });
        used += weight;
      }
      let shared: bigint;
      if (allocation.kind === 'compute') {
        ref(allocation.capacityEvidenceRef);
        const achieved = amount(allocation.achievedAgentMilliseconds, 'achieved agent milliseconds', true);
        if (used > achieved) throw new Error('tenant activity exceeds achieved capacity');
        shared = achieved - used;
      } else {
        shared = amount(allocation.overheadWeight, 'overhead weight', true);
      }
      // No activity does not erase a warm host, retained disk or control-plane bill.
      if (used + shared === 0n) shared = 1n;
      weights.push({ tenantId: null, weight: shared, remainder: 0n, share: 0n });
    }
    if (value === null) {
      unpricedLineIds.push(line.id);
      if (line.kind === 'charge') unpricedCharge = true;
      else unpricedCredit = true;
      gaps.push(`unpriced:${line.id}`);
      return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
        amountMicros: null, tenants: [], overheadMicros: null, unallocatedMicros: null };
    }
    known += value;
    if (line.kind === 'credit') credits += value;
    if (allocation.kind === 'unresolved') {
      unallocated += value;
      return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
        amountMicros: safe(value), tenants: [], overheadMicros: 0, unallocatedMicros: safe(value) };
    }
    const denominator = weights.reduce((sum, row) => sum + row.weight, 0n);
    const absolute = value < 0n ? -value : value;
    let remainder = absolute;
    for (const row of weights) {
      row.share = absolute * row.weight / denominator;
      row.remainder = absolute * row.weight % denominator;
      remainder -= row.share;
    }
    // Largest remainder, with a stable identifier tie break. Credits use the same
    // split with the opposite sign; neither currency micros nor overhead disappear.
    weights.sort((a, b) => a.remainder !== b.remainder ? (a.remainder > b.remainder ? -1 : 1)
      : a.tenantId === null ? (b.tenantId === null ? 0 : 1)
      : b.tenantId === null ? -1 : a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0);
    for (const row of weights) {
      if (remainder > 0n) { row.share++; remainder--; }
      if (value < 0n) row.share = -row.share;
    }
    const shared = weights.find((row) => row.tenantId === null)!.share;
    overhead += shared;
    const tenants = weights.filter((row) => row.tenantId !== null).map((row) => {
      const tenantId = row.tenantId!;
      tenantTotals.set(tenantId, (tenantTotals.get(tenantId) ?? 0n) + row.share);
      return { tenantId, amountMicros: safe(row.share) };
    }).sort((a, b) => a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0);
    return { id: line.id, provider: line.provider, category: line.category, sourceRef: line.sourceRef,
      amountMicros: safe(value), tenants, overheadMicros: safe(shared), unallocatedMicros: 0 };
  });
  const unknownRateAllocation = total - known;
  if ((!unpricedLineIds.length && unknownRateAllocation !== 0n)
    || (unknownRateAllocation > 0n && !unpricedCharge) || (unknownRateAllocation < 0n && !unpricedCredit)) {
    throw new Error('pool bill total does not reconcile to its lines');
  }
  unallocated += unknownRateAllocation;
  const tenants = [...tenantTotals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([tenantId, micros]) => ({ tenantId, amountMicros: safe(micros) }));
  const tenantTotal = [...tenantTotals.values()].reduce((sum, value) => sum + value, 0n);
  if (tenantTotal + overhead + unallocated !== total) throw new Error('pool bill allocation lost money');
  return { periodRef: input.periodRef, currency: input.currency, totalMicros: safe(total),
    tenants, tenantTotalMicros: safe(tenantTotal), overheadMicros: safe(overhead),
    unallocatedMicros: safe(unallocated), unknownRateAllocationMicros: safe(unknownRateAllocation),
    creditsMicros: safe(credits), creditsExcludedTotalMicros: unpricedLineIds.length ? null : safe(total - credits),
    complete: gaps.length === 0, unpricedLineIds, gaps, lines };
}
