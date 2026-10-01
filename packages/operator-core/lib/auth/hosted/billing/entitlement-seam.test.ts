import { afterEach, describe, expect, it } from 'vitest';
import {
  STUB_ENTITLEMENT_PROVIDER_ID,
  configureHostedSubscriptionEntitlementProvider,
  currentHostedSubscriptionEntitlementProvider,
  resolveHostedSubscriptionEntitlement,
  stubHostedSubscriptionEntitlementProvider,
  type HostedSubscriptionEntitlementProvider,
  type HostedSubscriptionSnapshot,
} from './entitlement-seam';

const snapshot = (over: Partial<HostedSubscriptionSnapshot> = {}): HostedSubscriptionSnapshot => ({
  organizationId: '11111111-2222-4333-8444-555555555555',
  stripeSubscriptionId: 'sub_A',
  status: 'active',
  planKey: 'team',
  priceId: 'price_team',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  canceledAt: null,
  livemode: false,
  latestInvoiceStatus: 'paid',
  ...over,
});

afterEach(() => {
  configureHostedSubscriptionEntitlementProvider(stubHostedSubscriptionEntitlementProvider);
});

describe('stub entitlement provider', () => {
  it.each([
    ['active', true, 'active'],
    ['trialing', true, 'trialing'],
    ['past_due', true, 'grace_past_due'],
    ['unpaid', false, 'inactive'],
    ['canceled', false, 'inactive'],
    ['incomplete', false, 'inactive'],
    ['pending', false, 'inactive'],
  ] as const)('%s → entitled=%s (%s)', async (status, entitled, reason) => {
    const answer = await resolveHostedSubscriptionEntitlement(snapshot({ status }));
    expect(answer).toMatchObject({ entitled, reason, source: 'billing', providerId: STUB_ENTITLEMENT_PROVIDER_ID, patch: null });
    expect(answer.bundleKey).toBe(entitled ? 'hosted-paid:team' : null);
  });

  it('no subscription is not_subscribed; an unconfigured price fails closed', async () => {
    expect(await resolveHostedSubscriptionEntitlement(null)).toMatchObject({ entitled: false, reason: 'not_subscribed' });
    expect(await resolveHostedSubscriptionEntitlement(snapshot({ planKey: null }))).toMatchObject({ entitled: false, reason: 'unknown_plan' });
  });
});

describe('the seam', () => {
  it('a configured provider (the metering work) replaces the stub without touching callers', async () => {
    const metered: HostedSubscriptionEntitlementProvider = {
      id: 'metering:test',
      entitlementFor: (s) => ({
        entitled: s?.status === 'active',
        reason: s?.status === 'active' ? 'active' : 'inactive',
        bundleKey: s?.status === 'active' ? 'team-v2' : null,
        patch: { quotas: { 'agent-hours': 40 } },
        source: 'billing',
        providerId: 'metering:test',
      }),
    };
    const previous = configureHostedSubscriptionEntitlementProvider(metered);
    expect(previous.id).toBe(STUB_ENTITLEMENT_PROVIDER_ID);
    expect(currentHostedSubscriptionEntitlementProvider().id).toBe('metering:test');
    expect(await resolveHostedSubscriptionEntitlement(snapshot())).toMatchObject({ bundleKey: 'team-v2', patch: { quotas: { 'agent-hours': 40 } } });
  });

  it('fails closed when a provider throws or answers malformed', async () => {
    const throwing: HostedSubscriptionEntitlementProvider = { id: 'broken', entitlementFor: () => { throw new Error('down'); } };
    expect(await resolveHostedSubscriptionEntitlement(snapshot(), { provider: throwing })).toMatchObject({ entitled: false, providerId: 'broken' });
    const lying: HostedSubscriptionEntitlementProvider = {
      id: 'lying',
      entitlementFor: () => ({ entitled: true, reason: 'active', bundleKey: null, patch: null, source: 'billing', providerId: 'lying' }),
    };
    expect(await resolveHostedSubscriptionEntitlement(snapshot(), { provider: lying })).toMatchObject({ entitled: false });
  });
});
