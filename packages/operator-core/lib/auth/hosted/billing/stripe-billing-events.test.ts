import { describe, expect, it } from 'vitest';
import {
  compareSubscriptionOrderKeys,
  parseHostedBillingEvent,
  subscriptionOrderKey,
  type SubscriptionStateFact,
} from './stripe-billing-events';

const ORG = '11111111-2222-4333-8444-555555555555';

function event(type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ id: 'evt_1', type, created: 1_790_000_000, livemode: false, data: { object }, ...extra });
}

const sub = (over: Record<string, unknown> = {}) => ({
  id: 'sub_A',
  customer: 'cus_A',
  status: 'active',
  cancel_at_period_end: false,
  canceled_at: null,
  metadata: { organizationId: ORG },
  items: { data: [{ price: { id: 'price_team' }, current_period_end: 1_792_000_000 }] },
  ...over,
});

describe('parseHostedBillingEvent', () => {
  it('reads a subscription update into a subscription fact (period from the item, API 2025+)', () => {
    const parsed = parseHostedBillingEvent(event('customer.subscription.updated', sub()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.event).toMatchObject({ eventId: 'evt_1', livemode: false });
    expect(parsed.event.facts).toEqual([{
      kind: 'subscription',
      organizationId: ORG,
      stripeCustomerId: 'cus_A',
      stripeSubscriptionId: 'sub_A',
      status: 'active',
      priceId: 'price_team',
      currentPeriodEnd: new Date(1_792_000_000_000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
    }]);
  });

  it('accepts an expanded customer object and a legacy top-level period', () => {
    const parsed = parseHostedBillingEvent(event('customer.subscription.created', sub({ customer: { id: 'cus_A' }, current_period_end: 1_793_000_000 })));
    expect(parsed.ok && (parsed.event.facts[0] as SubscriptionStateFact).currentPeriodEnd).toEqual(new Date(1_793_000_000_000));
  });

  it('refuses a subscription without org metadata as missing-organization (never guesses)', () => {
    const parsed = parseHostedBillingEvent(event('customer.subscription.updated', sub({ metadata: {} })));
    expect(parsed).toMatchObject({ ok: false, code: 'missing-organization', eventId: 'evt_1', livemode: false });
  });

  it('maps a subscription-mode checkout to a checkout fact and ignores payment-mode checkouts', () => {
    const completed = parseHostedBillingEvent(event('checkout.session.completed', {
      mode: 'subscription', customer: 'cus_A', subscription: 'sub_A', client_reference_id: ORG, metadata: {},
    }));
    expect(completed.ok && completed.event.facts).toEqual([{ kind: 'checkout', organizationId: ORG, stripeCustomerId: 'cus_A', stripeSubscriptionId: 'sub_A' }]);
    const oneTime = parseHostedBillingEvent(event('checkout.session.completed', { mode: 'payment', client_reference_id: 'order-1' }));
    expect(oneTime.ok && oneTime.event.facts).toEqual([]);
  });

  it('reads invoice.paid / invoice.payment_failed from both the legacy and the parent subscription shape', () => {
    const legacy = parseHostedBillingEvent(event('invoice.paid', { id: 'in_1', customer: 'cus_A', subscription: 'sub_A' }));
    expect(legacy.ok && legacy.event.facts[0]).toMatchObject({ kind: 'invoice', invoiceStatus: 'paid', organizationId: null, stripeSubscriptionId: 'sub_A' });
    const parent = parseHostedBillingEvent(event('invoice.payment_failed', {
      id: 'in_2', customer: 'cus_A',
      parent: { subscription_details: { subscription: 'sub_A', metadata: { organizationId: ORG } } },
    }));
    expect(parent.ok && parent.event.facts[0]).toMatchObject({ invoiceStatus: 'payment_failed', organizationId: ORG });
    const oneOff = parseHostedBillingEvent(event('invoice.paid', { id: 'in_3', customer: 'cus_A' }));
    expect(oneOff.ok && oneOff.event.facts).toEqual([]);
  });

  it('treats unrelated authenticated events as zero facts and rejects malformed envelopes', () => {
    const other = parseHostedBillingEvent(event('payout.paid', { id: 'po_1' }));
    expect(other.ok && other.event.facts).toEqual([]);
    expect(parseHostedBillingEvent('not json')).toMatchObject({ ok: false, code: 'malformed-body', eventId: null });
    expect(parseHostedBillingEvent(event('customer.subscription.updated', sub(), { livemode: 'no' }))).toMatchObject({ ok: false, code: 'malformed-body' });
    expect(parseHostedBillingEvent(event('customer.subscription.updated', sub({ status: 'bogus' })))).toMatchObject({ ok: false, code: 'malformed-body' });
  });
});

describe('subscription order key', () => {
  const at = (sec: number) => new Date(sec * 1000);
  const fold = (keys: ReturnType<typeof subscriptionOrderKey>[]) =>
    keys.reduce((best, key) => (compareSubscriptionOrderKeys(key, best) > 0 ? key : best));

  it('a terminal status dominates a later non-terminal update (no resurrection)', () => {
    const canceled = subscriptionOrderKey('canceled', at(100), 'evt_a');
    const lateUpdate = subscriptionOrderKey('active', at(200), 'evt_b');
    expect(compareSubscriptionOrderKeys(canceled, lateUpdate)).toBeGreaterThan(0);
  });

  it('within one second the later lifecycle stage wins, then the event id breaks ties', () => {
    expect(compareSubscriptionOrderKeys(subscriptionOrderKey('active', at(5), 'evt_a'), subscriptionOrderKey('incomplete', at(5), 'evt_z'))).toBeGreaterThan(0);
    expect(compareSubscriptionOrderKeys(subscriptionOrderKey('active', at(5), 'evt_b'), subscriptionOrderKey('active', at(5), 'evt_a'))).toBeGreaterThan(0);
  });

  it('the winning key is identical for every delivery order (order independence)', () => {
    const keys = [
      subscriptionOrderKey('incomplete', at(10), 'evt_1'),
      subscriptionOrderKey('active', at(10), 'evt_2'),
      subscriptionOrderKey('past_due', at(40), 'evt_3'),
      subscriptionOrderKey('active', at(50), 'evt_4'),
    ];
    const expected = fold(keys);
    const permutations = (xs: typeof keys): (typeof keys)[] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
    for (const order of permutations(keys)) expect(fold(order)).toEqual(expected);
    expect(expected.eventId).toBe('evt_4');
  });
});
