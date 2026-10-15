/** P-016: action → authenticated reader/parser → real hosted-service transaction.
 * Provider transport and alert destination are private fixtures; no production
 * credential, schedule or outward notification is used by this suite.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../../auth/hosted/workos-lifecycle-postgres';
import { PostgresHostedBillingStore } from '../../auth/hosted/billing/billing-store';
import { createStripeBillingClient } from '../../auth/hosted/billing/stripe-billing-client';
import { parseHostedBillingEvent } from '../../auth/hosted/billing/stripe-billing-events';
import { webhookBodyDigest } from '../../cupboard/webhook-inbox';
import { makeHostedBillingReconcileAction } from './hosted-billing-reconcile-action';

let db: OrgTestDb;
const T0 = 1_790_000_000;
const accountId = 'acct_Recovery';
const planKeyForPrice = (id: string | null) => id === 'price_team' ? 'team' : null;
const hex = () => randomBytes(6).toString('hex');
const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;

async function fixture() {
  const store = new PostgresHostedBillingStore(runService);
  const organizationId = randomUUID();
  const customerId = `cus_${hex()}`;
  const subscriptionId = `sub_${hex()}`;
  await store.recordCustomer({ organizationId, stripeCustomerId: customerId, livemode: false });
  const event = (status: string, created: number) => ({ object: 'event', id: `evt_${hex()}`,
    type: 'customer.subscription.updated', created, livemode: false,
    data: { object: { id: subscriptionId, customer: customerId, status,
      metadata: { organizationId }, items: { data: [{ price: { id: 'price_team' } }] },
      description: 'private customer payload' } } });
  const observe = vi.fn(async (_value: { failureClass: string; eventId: string | null }) => {});
  const requests: Array<{ url: URL; method: string | undefined }> = [];
  let readEvents = (_url: URL): Response => new Response('{}', { status: 503 });
  let requestId = 0;
  const response = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'request-id': `req_Recovery${++requestId}` },
  });
  const built = createStripeBillingClient({ secretKey: 'sk_test_recovery', liveModeAllowed: false,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url)); requests.push({ url: parsed, method: init?.method });
      if (parsed.pathname === '/v1/account') return response({ object: 'account', id: accountId });
      if (parsed.pathname === `/v1/customers/${customerId}`) return response({ object: 'customer',
        id: customerId, livemode: false, metadata: { organizationId } });
      if (parsed.pathname === '/v1/events') return readEvents(parsed);
      throw new Error('unexpected fixture transport');
    }) as typeof fetch });
  if (!built.ok) throw new Error('fixture client refused');
  const action = () => makeHostedBillingReconcileAction({ makeDeps: async () => ({
    store: {
      beginReconciliation: input => store.beginReconciliation(input),
      applyReconciliationPage: input => store.applyReconciliationPage(input),
      deliveryIssues: input => store.deliveryIssues(input),
      reconciliationTargets: async input => (await store.reconciliationTargets(input))
        .filter(target => target.organizationId === organizationId),
    }, client: built.client, planKeyForPrice, observe,
  }) });
  const fire = (maxPages = 3, createdBefore = T0 + 100) => action()({ installSlug: 'papercusp',
    workspaceId: 'test-billing-recovery', triggerConfig: {}, payloadTemplate: { input: {
      accountId, createdFrom: T0 - 1, createdBefore, overlapSeconds: 5, maxCustomers: 100, maxPages,
    } } });
  const page = (data: unknown[], has_more = false) => response({ object: 'list', url: '/v1/events', data, has_more });
  const setProvider = (read: typeof readEvents) => { readEvents = read; };
  const checkpoint = async () => (await db.adminSql`
    SELECT reconciliation_checkpoint AS value FROM papercusp_auth.hosted_billing_customers
     WHERE organization_id = ${organizationId}::uuid`)[0]!.value;
  const mirror = async () => (await db.adminSql`
    SELECT status, plan_key FROM papercusp_auth.hosted_subscriptions
     WHERE stripe_subscription_id = ${subscriptionId}`)[0] ?? null;
  const audit = async () => db.adminSql`
    SELECT action, metadata FROM papercusp_auth.organization_audit_events
     WHERE organization_id = ${organizationId}::uuid`;
  const receipt = async (id: string) => (await db.adminSql`
    SELECT body_digest, api_observation, outcome FROM papercusp_auth.hosted_billing_webhook_events
     WHERE provider_event_id = ${id}`)[0] ?? null;
  const deliver = async (raw: string) => {
    const parsed = parseHostedBillingEvent(raw);
    if (!parsed.ok) throw new Error('fixture event refused');
    return store.applyEvent({ event: parsed.event, bodyDigest: webhookBodyDigest(raw), expectedLivemode: false, planKeyForPrice });
  };
  return { store, organizationId, event, observe, requests, fire, page, setProvider, checkpoint, mirror, audit, receipt, deliver };
}

describe('hosted billing reconciliation action composition (real Postgres)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    await db.adminSql.unsafe(readFileSync(new URL(
      '../../../../../libs/papercusp/libs/db/sql/1515-hosted-billing-api-recovery.sql', import.meta.url), 'utf8'));
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  it('repairs a never-delivered event, reports it independently and preserves signed-byte authority on replay', async () => {
    const f = await fixture(); const event = f.event('active', T0 + 10);
    f.setProvider(() => f.page([event]));
    expect(await f.mirror()).toBeNull();
    const out = await f.fire();
    expect(out.diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 1, pages: 1, failed: 0,
      issues: expect.arrayContaining([{ eventId: event.id, failureClass: 'undelivered' }]) } });
    expect(await f.mirror()).toMatchObject({ status: 'active', plan_key: 'team' });
    expect(await f.receipt(event.id)).toMatchObject({ body_digest: null, outcome: 'ignored',
      api_observation: { source: 'stripe-authenticated-api', accountId } });
    expect(f.observe).toHaveBeenCalledWith({ failureClass: 'undelivered', eventId: event.id });
    const originalAllAudit = await f.audit();
    const originalAudit = originalAllAudit.filter(row => row.action === 'billing.event.reconciled');
    expect(originalAudit).toHaveLength(1);
    const readCount = f.requests.length;
    await f.fire();
    expect(f.requests).toHaveLength(readCount);
    expect(await f.audit()).toEqual(originalAllAudit);
    const raw = JSON.stringify(event);
    await f.deliver(raw);
    expect(await f.receipt(event.id)).toMatchObject({ body_digest: webhookBodyDigest(raw) });
    expect((await f.audit()).filter(row => row.action === 'billing.event.reconciled')).toEqual(originalAudit);
    const signedAudit = await f.audit();
    await f.deliver(raw);
    const changed = await f.deliver(`${raw} `);
    expect(changed).toEqual({ outcome: 'replay-mismatch' });
    expect(await f.audit()).toEqual(signedAudit);
    expect(await f.mirror()).toMatchObject({ status: 'active' });
    expect(f.requests.every(request => request.method === 'GET')).toBe(true);
    expect(JSON.stringify({ observations: f.observe.mock.calls, audit: originalAudit }))
      .not.toContain('private customer payload');
  });

  it('resumes a budget-limited fixed window in a new action without overwriting a newer signed webhook', async () => {
    const f = await fixture();
    const first = f.event('active', T0 + 20); const last = f.event('past_due', T0 + 10);
    f.setProvider(url => url.searchParams.has('starting_after') ? f.page([last]) : f.page([first], true));
    expect((await f.fire(1)).diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 0, budgetExhausted: true } });
    expect(await f.checkpoint()).toMatchObject({ startingAfter: first.id, complete: false, createdBefore: T0 + 100 });
    const newer = f.event('canceled', T0 + 30);
    await f.deliver(JSON.stringify(newer));
    expect((await f.fire(3, T0 + 200)).diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 1, failed: 0 } });
    expect(await f.checkpoint()).toMatchObject({ complete: true, createdBefore: T0 + 100 });
    expect(await f.mirror()).toMatchObject({ status: 'canceled' });
    const resumed = f.requests.filter(request => request.url.pathname === '/v1/events').at(-1)!.url;
    expect(resumed.searchParams.get('starting_after')).toBe(first.id);
    expect(resumed.searchParams.get('created[lt]')).toBe(String(T0 + 100));
    expect(f.observe).toHaveBeenCalledWith({ failureClass: 'budget-exhausted', eventId: null });
  });

  it('leaves a failed provider window recoverable and retries it through a new action instance', async () => {
    const f = await fixture(); const event = f.event('active', T0 + 5);
    const failed = await f.fire();
    expect(failed.diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 0, failed: 1 } });
    expect(await f.mirror()).toBeNull(); expect(await f.receipt(event.id)).toBeNull();
    expect(await f.checkpoint()).toMatchObject({ complete: false, startingAfter: null });
    expect(f.observe).toHaveBeenCalledWith({ failureClass: 'provider-unavailable', eventId: null });
    f.setProvider(() => f.page([event]));
    expect((await f.fire()).diagnostics).toMatchObject({ hostedBillingReconcile: { completed: 1, failed: 0 } });
    expect(await f.mirror()).toMatchObject({ status: 'active' });
    expect((await f.audit()).filter(row => row.action === 'billing.event.reconciled')).toHaveLength(1);
  });
});
