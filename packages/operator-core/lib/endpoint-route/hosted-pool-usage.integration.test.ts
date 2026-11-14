/** P538 accounting through the authenticated mounted hosted-billing runtime. */
import { describe, expect, it, vi } from 'vitest';
import { createHostedPrincipal } from '../auth/hosted-principal';
import type { HostedBillingStore } from '../auth/hosted/billing/billing-store';
import type { HostedPrincipalResolver } from '../auth/hosted-principal-resolver';
import type { HostedBillingUsageSource } from '../auth/hosted/billing/usage-service';
import { POOL_COST_CATEGORIES } from '../auth/hosted/billing/pool-usage';
import { PILOT_COST_CATEGORIES } from '../auth/hosted/billing/unit-economics';
import { createHostedBillingRuntime } from './hosted-billing-runtime';

const T = Date.UTC(2026, 9, 2);
const CONTROL = 'control-a'; const ORG = 'org-a';
type UsageRead = Parameters<HostedBillingUsageSource>[0];
const resolvePrincipal: HostedPrincipalResolver = async headers => ({ ok: true,
  principal: createHostedPrincipal({ workspaceId: CONTROL, userId: 'user-a', activeOrganizationId: ORG,
    sessionId: 'session-a', sessionVersion: 1,
    permissions: headers.get('test-session') === 'owner' ? ['billing:manage', 'workspace:view'] : ['workspace:view'] }),
  session: {} as never, membership: {} as never });
const billingStore: HostedBillingStore = {
  customerFor: async () => null, recordCustomer: async customer => customer,
  currentSubscription: async () => null, applyEvent: async () => ({ outcome: 'ignored', organizationId: null }),
  recordRejectedEvent: async () => 'recorded',
};
const headers = (session = 'owner') => ({ headers: { 'test-session': session } });

describe('P538 hosted pool usage integration', () => {
  it('serves scoped pool accounting through the real runtime without posting usage charges', async () => {
    const append = vi.fn(async () => 'recorded' as const);
    const poolUsage = vi.fn(async (input: UsageRead) => ({ scope: input.scope, month: input.month,
      workspaces: ['customer-a', 'customer-b'].map(customerWorkspaceId => ({ ...input.scope, customerWorkspaceId })),
      source: { complete: true, observedAtMs: T, maximumAgeMs: 0, evidenceRef: 'fixture:pool-period' },
      bills: [{ invoiceId: 'invoice-a', periodRef: input.month, currency: 'USD', totalMicros: 900,
        lines: POOL_COST_CATEGORIES.map(category => ({ id: category, category, kind: 'charge' as const,
          provider: 'gcp', periodRef: input.month, currency: 'USD', amountMicros: 100, sourceRef: 'fixture:bill',
          allocation: { kind: 'compute' as const, achievedAgentMilliseconds: 1000, capacityEvidenceRef: 'fixture:achieved',
            tenants: [{ tenantId: 'customer-a', activeAgentMilliseconds: 300 },
              { tenantId: 'customer-b', activeAgentMilliseconds: 200 }] } })) }] }));
    const built = await createHostedBillingRuntime({ publicOrigin: 'https://app.example', stripeSecretKeyRef: null,
      stripeWebhookSecretRef: null, plans: [] }, { resolvePrincipal, store: billingStore, clock: () => new Date(T),
      usageStore: { append, readRecords: async () => [], readOpenRouterBindings: async () => [] }, poolUsage,
      usageCollectors: [{ id: 'measured-zero', provider: 'fixture', categories: [...PILOT_COST_CATEGORIES],
        read: async input => ({ scope: input.scope, month: input.month, observedAtMs: T,
          complete: true, evidenceRef: 'fixture:usage-zero', records: [] }) }] });
    const response = await built.app.request('/api/hosted/billing/usage?month=2026-10&workspaceId=customer-a', headers());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.statement.infrastructure).toMatchObject({ tenantTotalMicros: 270, sharedOverheadMicros: 450,
      poolTotalMicros: 900, unallocatedMicros: 0, observedAtMs: T, complete: true });
    expect(body.statement.infrastructure.tenants).toEqual([{ customerWorkspaceId: 'customer-a', knownMicros: 270, totalMicros: 270 }]);
    expect(JSON.stringify(body)).not.toContain('customer-b');
    expect(body.statement.consumptionBilled.micros).toBe(0); expect(append).not.toHaveBeenCalled();
    expect(poolUsage).toHaveBeenCalledExactlyOnceWith({ scope: { controlWorkspaceId: CONTROL,
      organizationId: ORG, customerWorkspaceId: 'customer-a' }, month: '2026-10', asOfMs: T });
    expect((await built.app.request('/api/hosted/billing/usage', headers('member'))).status).toBe(403);
    expect(poolUsage).toHaveBeenCalledTimes(1);
  });
});
