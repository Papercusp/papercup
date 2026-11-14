import { describe, expect, it } from 'vitest';
import { POOL_COST_CATEGORIES, readHostedPoolCosts, type HostedPoolUsageSnapshot } from './pool-usage';
import type { HostedUsageRead } from './usage-service';

const T = Date.UTC(2026, 10, 2);
const input: HostedUsageRead = { scope: { controlWorkspaceId: 'control-a', organizationId: 'org-a', customerWorkspaceId: null },
  month: '2026-11', asOfMs: T };
const snapshot = (): HostedPoolUsageSnapshot => ({ scope: { ...input.scope }, month: input.month,
  workspaces: ['customer-a', 'customer-b'].map(customerWorkspaceId => ({ ...input.scope, customerWorkspaceId })),
  source: { complete: true, observedAtMs: T, maximumAgeMs: 1000, evidenceRef: 'fixture:dated-pool-census' },
  bills: [{ invoiceId: 'invoice-a', periodRef: input.month, currency: 'USD', totalMicros: 900,
    lines: POOL_COST_CATEGORIES.map(category => ({ id: category, category, kind: 'charge', provider: 'gcp',
      periodRef: input.month, currency: 'USD', amountMicros: 100, sourceRef: `fixture:bill:${category}`,
      allocation: { kind: 'compute', achievedAgentMilliseconds: 1000, capacityEvidenceRef: 'fixture:achieved',
        tenants: [{ tenantId: 'customer-a', activeAgentMilliseconds: 300 }, { tenantId: 'customer-b', activeAgentMilliseconds: 200 }] } })) }] });

describe('hosted pool invoice accounting', () => {
  it('reuses achieved capacity and conserves every category with explicit overhead', async () => {
    const result = await readHostedPoolCosts(input, async () => snapshot());
    expect(result).toMatchObject({ complete: true, knownTenantMicros: 450, tenantTotalMicros: 450,
      poolTotalMicros: 900, sharedOverheadMicros: 450, unallocatedMicros: 0, creditsExcludedTenantMicros: 450,
      observedAtMs: T, sourceRef: 'fixture:dated-pool-census' });
    expect(result.knownTenantMicros + result.sharedOverheadMicros! + result.unallocatedMicros!).toBe(result.poolTotalMicros);
  });
  it('projects only the requested workspace while retaining the pool reconciliation', async () => {
    const scoped = { ...input, scope: { ...input.scope, customerWorkspaceId: 'customer-a' } };
    const result = await readHostedPoolCosts(scoped, async () => ({ ...snapshot(), scope: scoped.scope }));
    expect(result.tenantTotalMicros).toBe(270);
    expect(result.tenants).toEqual([{ customerWorkspaceId: 'customer-a', knownMicros: 270, totalMicros: 270 }]);
    expect(JSON.stringify(result)).not.toContain('customer-b');
  });
  it('keeps an unconfigured source unknown rather than free', async () => {
    expect(await readHostedPoolCosts(input)).toMatchObject({ complete: false, tenantTotalMicros: null,
      poolTotalMicros: null, sharedOverheadMicros: null, unallocatedMicros: null, gaps: ['pool-source-unconfigured'] });
  });
  it.each([0, 29])('retains missing rate uncertainty with a %i-micro residual', async residual => {
    const s = snapshot(); const bill = s.bills[0]!;
    const result = await readHostedPoolCosts(input, async () => ({ ...s, bills: [{ ...bill, totalMicros: 800 + residual,
      lines: bill.lines.map(line => line.category === 'backup' ? { ...line, amountMicros: null } : line) }] }));
    expect(result).toMatchObject({ complete: false, tenantTotalMicros: null, creditsExcludedTenantMicros: null,
      knownTenantMicros: 400, sharedOverheadMicros: 400, unallocatedMicros: residual });
    expect(result.gaps).toContain('invoice-a:unpriced:backup');
    expect(result.knownTenantMicros + result.sharedOverheadMicros! + result.unallocatedMicros!).toBe(result.poolTotalMicros);
  });
  it('retains unresolved ownership separately from overhead and a known tenant subtotal', async () => {
    const s = snapshot(); const bill = s.bills[0]!;
    const result = await readHostedPoolCosts(input, async () => ({ ...s, bills: [{ ...bill,
      lines: bill.lines.map(line => line.category === 'control-plane' ? { ...line,
        allocation: { kind: 'unresolved', reason: 'ownership-unmeasured' } } : line) }] }));
    expect(result).toMatchObject({ complete: false, knownTenantMicros: 400, tenantTotalMicros: null,
      sharedOverheadMicros: 400, unallocatedMicros: 100 });
  });
  it('does not erase a no-activity bill', async () => {
    const s = snapshot(); const bill = s.bills[0]!;
    const result = await readHostedPoolCosts(input, async () => ({ ...s, bills: [{ ...bill,
      lines: bill.lines.map(line => ({ ...line, allocation: { kind: 'compute', achievedAgentMilliseconds: 0,
        capacityEvidenceRef: 'fixture:idle-achieved', tenants: [] } })) }] }));
    expect(result).toMatchObject({ complete: true, tenantTotalMicros: 0, sharedOverheadMicros: 900, poolTotalMicros: 900 });
  });
  it('retains signed credits and credits-excluded cost without changing consumption billing', async () => {
    const s = snapshot(); const bill = s.bills[0]!;
    const result = await readHostedPoolCosts(input, async () => ({ ...s, bills: [{ ...bill, totalMicros: 800,
      lines: [...bill.lines, { ...bill.lines[0]!, id: 'credit-a', kind: 'credit', amountMicros: -100 }] }] }));
    expect(result).toMatchObject({ complete: true, tenantTotalMicros: 400, creditsExcludedTenantMicros: 450,
      sharedOverheadMicros: 400, poolTotalMicros: 800 });
  });
  it.each(['backup', 'warm-capacity', 'inference'] as const)('requires explicit %s exposure including measured zero', async missing => {
    const s = snapshot(); const bill = s.bills[0]!;
    const result = await readHostedPoolCosts(input, async () => ({ ...s, bills: [{ ...bill, totalMicros: 800,
      lines: bill.lines.filter(line => line.category !== missing) }] }));
    expect(result.complete).toBe(false); expect(result.tenantTotalMicros).toBeNull();
    expect(result.gaps).toContain(`missing-pool-category:${missing}`);
  });
  it.each(['stale', 'future', 'partial'] as const)('keeps %s source coverage unqualified', async kind => {
    const s = snapshot();
    const result = await readHostedPoolCosts(input, async () => ({ ...s, source: { ...s.source,
      observedAtMs: kind === 'future' ? T + 1 : kind === 'stale' ? T - 1001 : T, complete: kind !== 'partial' } }));
    expect(result.complete).toBe(false); expect(result.tenantTotalMicros).toBeNull();
  });
  it('rejects wrong organization, period, currency and duplicate invoices', async () => {
    const s = snapshot(); const b = s.bills[0]!;
    for (const value of [{ ...s, scope: { ...s.scope, organizationId: 'foreign' } },
      { ...s, month: '2026-10' }, { ...s, bills: [{ ...b, currency: 'EUR' }] },
      { ...s, bills: [{ ...b, periodRef: '2026-10' }] }, { ...s, bills: [b, b] }]) {
      await expect(readHostedPoolCosts(input, async () => value)).rejects.toThrow();
    }
  });
  it('rejects foreign, missing and duplicate composite tenant bindings before exposing costs', async () => {
    const s = snapshot();
    for (const workspaces of [[], [s.workspaces[0]!], [s.workspaces[0]!, s.workspaces[0]!],
      s.workspaces.map(row => ({ ...row, organizationId: 'foreign-org' })),
      s.workspaces.map(row => ({ ...row, controlWorkspaceId: 'foreign-control' }))]) {
      await expect(readHostedPoolCosts(input, async () => ({ ...s, workspaces }))).rejects.toThrow();
    }
  });
});
