/**
 * Hosted subscription billing store against real Postgres, real roles and real
 * RLS (migration 1276). Every case runs the production `PostgresHostedBillingStore`
 * on `harness_app` switched into `hosted_service` with `SET LOCAL ROLE` — the
 * privilege path `withHostedServiceContext` takes — and inspects rows through the
 * RLS-bypassing admin client.
 *
 * The unit suites prove the routes (`hosted-billing-runtime.test.ts`) and the
 * order key in JavaScript (`stripe-billing-events.test.ts`); only a real database
 * can prove the SQL row comparison, the "C"-collation tie-break, the one
 * transaction that binds the idempotency row to its facts, and the grants.
 *
 * Events are built as Stripe JSON and run through `parseHostedBillingEvent`, so
 * the parser→store seam is exercised exactly as the webhook route uses it.
 *
 * stripe-subscription-signup-2026-10-01 P-003.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import { webhookBodyDigest } from '../../../cupboard/webhook-inbox';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { PostgresHostedBillingStore } from './billing-store';
import { parseHostedBillingEvent, type HostedBillingEvent } from './stripe-billing-events';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');

let db: OrgTestDb;

/** Production's hosted-service transaction shape: harness_app, then SET LOCAL ROLE. */
const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async (tx) => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;

const planKeyForPrice = (priceId: string | null) => (priceId === 'price_team' ? 'team' : priceId === 'price_pro' ? 'pro' : null);

const hex = () => randomBytes(6).toString('hex');

interface Fixture {
  organizationId: string;
  customerId: string;
  subscriptionId: string;
}

async function fixture(store = new PostgresHostedBillingStore(runService)): Promise<Fixture> {
  const f = { organizationId: randomUUID(), customerId: `cus_${hex()}`, subscriptionId: `sub_${hex()}` };
  await store.recordCustomer({ organizationId: f.organizationId, stripeCustomerId: f.customerId, livemode: false });
  return f;
}

const T0 = 1_790_000_000; // seconds

function subscriptionJson(f: Fixture, input: {
  id: string;
  created: number;
  status: string;
  priceId?: string;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
  periodEnd?: number;
  organizationId?: string;
  livemode?: boolean;
  type?: string;
}): string {
  return JSON.stringify({
    id: input.id,
    type: input.type ?? 'customer.subscription.updated',
    created: input.created,
    livemode: input.livemode ?? false,
    data: {
      object: {
        id: f.subscriptionId,
        customer: f.customerId,
        status: input.status,
        cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
        canceled_at: input.canceledAt ?? null,
        metadata: { organizationId: input.organizationId ?? f.organizationId },
        items: { data: [{ price: { id: input.priceId ?? 'price_team' }, current_period_end: input.periodEnd ?? T0 + 2_592_000 }] },
      },
    },
  });
}

function invoiceJson(f: Fixture, input: { id: string; created: number; invoiceId: string; paid: boolean }): string {
  return JSON.stringify({
    id: input.id,
    type: input.paid ? 'invoice.paid' : 'invoice.payment_failed',
    created: input.created,
    livemode: false,
    data: { object: { id: input.invoiceId, customer: f.customerId, subscription: f.subscriptionId } },
  });
}

function checkoutJson(f: Fixture, input: { id: string; created: number }): string {
  return JSON.stringify({
    id: input.id,
    type: 'checkout.session.completed',
    created: input.created,
    livemode: false,
    data: {
      object: {
        mode: 'subscription', customer: f.customerId, subscription: f.subscriptionId,
        client_reference_id: f.organizationId, metadata: {},
      },
    },
  });
}

function parsed(raw: string): HostedBillingEvent {
  const result = parseHostedBillingEvent(raw);
  if (!result.ok) throw new Error(`fixture event did not parse: ${result.code}`);
  return result.event;
}

async function deliver(store: PostgresHostedBillingStore, raw: string, expectedLivemode = false) {
  return store.applyEvent({ event: parsed(raw), bodyDigest: webhookBodyDigest(raw), expectedLivemode, planKeyForPrice });
}

interface SubscriptionRow {
  status: string;
  price_id: string | null;
  plan_key: string | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  latest_invoice_id: string | null;
  latest_invoice_status: string | null;
}

async function subscriptionRow(subscriptionId: string): Promise<SubscriptionRow | null> {
  const rows = await db.adminSql<SubscriptionRow[]>`
    SELECT status, price_id, plan_key, current_period_end, cancel_at_period_end, canceled_at,
           latest_invoice_id, latest_invoice_status
      FROM papercusp_auth.hosted_subscriptions
     WHERE stripe_subscription_id = ${subscriptionId}
  `;
  return rows[0] ?? null;
}

async function eventRow(eventId: string) {
  const rows = await db.adminSql<Array<{ outcome: string; rejection_code: string | null; organization_id: string | null }>>`
    SELECT outcome, rejection_code, organization_id::text AS organization_id
      FROM papercusp_auth.hosted_billing_webhook_events
     WHERE provider_event_id = ${eventId}
  `;
  return rows[0] ?? null;
}

/** Deterministic Fisher–Yates so a failing order is reproducible from its seed. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('PostgresHostedBillingStore (real Postgres, real roles)', () => {
  const store = () => new PostgresHostedBillingStore(runService);

  beforeAll(async () => {
    db = await createOrgTestDb();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('keeps exactly one customer per organization (insert-or-keep, the earlier winner stays)', async () => {
    const organizationId = randomUUID();
    const first = await store().recordCustomer({ organizationId, stripeCustomerId: `cus_${hex()}`, livemode: false });
    const second = await store().recordCustomer({ organizationId, stripeCustomerId: `cus_${hex()}`, livemode: false });
    expect(second).toEqual(first);
    expect(await store().customerFor(organizationId)).toEqual(first);
    expect(await store().customerFor(randomUUID())).toBeNull();
  });

  it('converges to the same final row for every delivery order (order-independent max-registers)', async () => {
    // A realistic signup → upgrade → schedule-cancel lifecycle, including a
    // same-second pair (incomplete → active) that only the status rank orders,
    // and two invoices where the later one wins.
    const lifecycle = (f: Fixture, tag: string) => [
      checkoutJson(f, { id: `evt_${tag}a`, created: T0 }),
      subscriptionJson(f, { id: `evt_${tag}b`, created: T0 + 1, status: 'incomplete', type: 'customer.subscription.created' }),
      subscriptionJson(f, { id: `evt_${tag}c`, created: T0 + 1, status: 'active' }),
      invoiceJson(f, { id: `evt_${tag}d`, created: T0 + 2, invoiceId: 'in_first', paid: false }),
      invoiceJson(f, { id: `evt_${tag}e`, created: T0 + 3, invoiceId: 'in_second', paid: true }),
      subscriptionJson(f, { id: `evt_${tag}f`, created: T0 + 4, status: 'active', priceId: 'price_pro', periodEnd: T0 + 5_000_000 }),
      subscriptionJson(f, { id: `evt_${tag}g`, created: T0 + 5, status: 'active', priceId: 'price_pro', cancelAtPeriodEnd: true, periodEnd: T0 + 5_000_000 }),
    ];
    const expected: SubscriptionRow = {
      status: 'active',
      price_id: 'price_pro',
      plan_key: 'pro',
      current_period_end: new Date((T0 + 5_000_000) * 1000),
      cancel_at_period_end: true,
      canceled_at: null,
      latest_invoice_id: 'in_second',
      latest_invoice_status: 'paid',
    };

    const orders: Array<{ label: string; order: (events: string[]) => string[] }> = [
      { label: 'in order', order: (e) => e },
      { label: 'reversed', order: (e) => [...e].reverse() },
      ...[11, 23, 37, 41, 59, 73, 97, 101].map((seed) => ({ label: `seed ${seed}`, order: (e: string[]) => shuffled(e, seed) })),
    ];
    for (const { label, order } of orders) {
      const f = await fixture();
      for (const raw of order(lifecycle(f, hex()))) {
        const result = await deliver(store(), raw);
        expect(result.outcome, `${label}: ${raw.slice(0, 60)}`).toBe('applied');
      }
      expect(await subscriptionRow(f.subscriptionId), label).toEqual(expected);
      expect(await store().currentSubscription(f.organizationId, planKeyForPrice), label).toMatchObject({
        status: 'active', planKey: 'pro', cancelAtPeriodEnd: true, latestInvoiceStatus: 'paid',
      });
    }
  });

  it('a canceled subscription is never resurrected by a late or later non-terminal update', async () => {
    const f = await fixture();
    const tag = hex();
    await deliver(store(), subscriptionJson(f, { id: `evt_${tag}x`, created: T0 + 10, status: 'canceled', canceledAt: T0 + 10 }));
    // Older update arriving late.
    await deliver(store(), subscriptionJson(f, { id: `evt_${tag}y`, created: T0 + 5, status: 'active' }));
    // A non-terminal update stamped AFTER the cancellation (Stripe never revives; a bad clock must not either).
    await deliver(store(), subscriptionJson(f, { id: `evt_${tag}z`, created: T0 + 20, status: 'past_due' }));
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'canceled', canceled_at: new Date((T0 + 10) * 1000) });
    expect(await store().currentSubscription(f.organizationId, planKeyForPrice)).toMatchObject({ status: 'canceled' });
  });

  it('a live subscription outranks an organization’s older terminal one in currentSubscription', async () => {
    const f = await fixture();
    const tag = hex();
    await deliver(store(), subscriptionJson(f, { id: `evt_${tag}a`, created: T0 + 50, status: 'canceled', canceledAt: T0 + 50 }));
    const next: Fixture = { ...f, subscriptionId: `sub_${hex()}` };
    await deliver(store(), subscriptionJson(next, { id: `evt_${tag}b`, created: T0 + 40, status: 'active' }));
    expect(await store().currentSubscription(f.organizationId, planKeyForPrice)).toMatchObject({
      stripeSubscriptionId: next.subscriptionId, status: 'active', planKey: 'team',
    });
  });

  it('a checkout alone leaves a pending row the UI can show as processing', async () => {
    const f = await fixture();
    expect(await deliver(store(), checkoutJson(f, { id: `evt_${hex()}`, created: T0 }))).toMatchObject({ outcome: 'applied' });
    expect(await store().currentSubscription(f.organizationId, planKeyForPrice)).toMatchObject({ status: 'pending', planKey: null });
  });

  it('a byte-identical redelivery is a duplicate and changes nothing; different bytes under the same id is a replay', async () => {
    const f = await fixture();
    const id = `evt_${hex()}`;
    const raw = subscriptionJson(f, { id, created: T0, status: 'active' });
    expect(await deliver(store(), raw)).toEqual({ outcome: 'applied', organizationId: f.organizationId });
    expect(await deliver(store(), raw)).toEqual({ outcome: 'duplicate', organizationId: f.organizationId });
    const tampered = subscriptionJson(f, { id, created: T0, status: 'canceled', canceledAt: T0 });
    expect(await deliver(store(), tampered)).toEqual({ outcome: 'replay-mismatch' });
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'active' });
    expect(await eventRow(id)).toEqual({ outcome: 'applied', rejection_code: null, organization_id: f.organizationId });
  });

  it('refuses an event for an unrecorded customer, records the refusal, and treats its retry as a duplicate', async () => {
    const stranger: Fixture = { organizationId: randomUUID(), customerId: `cus_${hex()}`, subscriptionId: `sub_${hex()}` };
    const id = `evt_${hex()}`;
    const raw = subscriptionJson(stranger, { id, created: T0, status: 'active' });
    expect(await deliver(store(), raw)).toEqual({ outcome: 'rejected', code: 'unknown_customer', organizationId: stranger.organizationId });
    expect(await subscriptionRow(stranger.subscriptionId)).toBeNull();
    expect(await eventRow(id)).toEqual({ outcome: 'rejected', rejection_code: 'unknown_customer', organization_id: null });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'duplicate' });
  });

  it('refuses an event whose metadata names another organization than the customer belongs to', async () => {
    const f = await fixture();
    const id = `evt_${hex()}`;
    const raw = subscriptionJson(f, { id, created: T0, status: 'active', organizationId: randomUUID() });
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'rejected', code: 'organization_mismatch' });
    expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    expect(await eventRow(id)).toMatchObject({ outcome: 'rejected', rejection_code: 'organization_mismatch' });
  });

  it('refuses a subscription id that is already bound to a different organization', async () => {
    const a = await fixture();
    const b = await fixture();
    await deliver(store(), subscriptionJson(a, { id: `evt_${hex()}`, created: T0, status: 'active' }));
    const hijack: Fixture = { ...b, subscriptionId: a.subscriptionId };
    const result = await deliver(store(), subscriptionJson(hijack, { id: `evt_${hex()}`, created: T0 + 1, status: 'canceled', canceledAt: T0 + 1 }));
    expect(result).toMatchObject({ outcome: 'rejected', code: 'organization_mismatch' });
    expect(await subscriptionRow(a.subscriptionId)).toMatchObject({ status: 'active' });
  });

  it('refuses an event from the other Stripe mode without touching facts', async () => {
    const f = await fixture();
    const id = `evt_${hex()}`;
    const result = await deliver(store(), subscriptionJson(f, { id, created: T0, status: 'active', livemode: true }), false);
    expect(result).toEqual({ outcome: 'rejected', code: 'livemode_mismatch', organizationId: null });
    expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    expect(await eventRow(id)).toMatchObject({ outcome: 'rejected', rejection_code: 'livemode_mismatch' });
  });

  it('records an unparseable-but-authenticated delivery once; its retries are duplicates, altered bytes a replay', async () => {
    const id = `evt_${hex()}`;
    const input = { eventId: id, eventType: 'customer.subscription.updated', bodyDigest: 'a'.repeat(64), livemode: false, code: 'missing-organization' };
    expect(await store().recordRejectedEvent(input)).toBe('recorded');
    expect(await store().recordRejectedEvent(input)).toBe('duplicate');
    expect(await store().recordRejectedEvent({ ...input, bodyDigest: 'b'.repeat(64) })).toBe('replay-mismatch');
  });

  it('is atomic: a crash before commit leaves neither the idempotency row nor any fact, so the redelivery applies', async () => {
    const f = await fixture();
    const id = `evt_${hex()}`;
    const raw = subscriptionJson(f, { id, created: T0, status: 'active' });
    const crashing: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
      db.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        await fn(tx as unknown as Sql);
        throw new Error('simulated crash before commit');
      }) as Promise<T>;
    await expect(deliver(new PostgresHostedBillingStore(crashing), raw)).rejects.toThrow('simulated crash');
    expect(await eventRow(id)).toBeNull();
    expect(await subscriptionRow(f.subscriptionId)).toBeNull();
    expect(await deliver(store(), raw)).toMatchObject({ outcome: 'applied' });
    expect(await subscriptionRow(f.subscriptionId)).toMatchObject({ status: 'active' });
  });

  it('serializes a concurrent duplicate delivery: exactly one applies, the other sees a duplicate', async () => {
    const f = await fixture();
    const raw = subscriptionJson(f, { id: `evt_${hex()}`, created: T0, status: 'active' });
    const outcomes = (await Promise.all([deliver(store(), raw), deliver(store(), raw)])).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['applied', 'duplicate']);
  });

  it('grants the billing tables to hosted_service only — the tenant-facing hosted_app role cannot read them', async () => {
    // Switch from the superuser so the ROLE switch itself always succeeds: the
    // denial must come from the table grant, not from "permission denied to set role".
    for (const table of ['hosted_billing_customers', 'hosted_subscriptions', 'hosted_billing_webhook_events']) {
      const denied = db.adminSql.begin(async (tx) => {
        await tx.unsafe('SET LOCAL ROLE hosted_app');
        return tx.unsafe(`SELECT count(*) FROM papercusp_auth.${table}`);
      });
      await expect(denied).rejects.toThrow(new RegExp(`permission denied for table ${table}`));
    }
  });
});
