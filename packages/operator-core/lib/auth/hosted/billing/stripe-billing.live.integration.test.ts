/**
 * Hosted subscription billing against REAL Stripe test mode, end to end.
 *
 * The other billing suites stub Stripe at the fetch edge
 * (`hosted-billing-runtime.test.ts`) or feed hand-built event JSON to the store
 * (`billing-store.integration.test.ts`). Only this file proves the pieces agree
 * with Stripe itself: the production `createHostedBillingRuntime` on a real org
 * database, real Checkout/portal sessions from the Stripe test API, and real
 * signed webhook deliveries forwarded by `stripe listen` into the mounted
 * webhook route.
 *
 * OPT-IN, never implicit. It makes network calls and creates (then deletes)
 * Stripe test objects, so it must not run inside the green-checkpoint gate just
 * because a box happens to hold test keys. Run it with:
 *
 *   PAPERCUSP_STRIPE_TEST_E2E=1 npm run test:file -- \
 *     packages/operator-core/lib/auth/hosted/billing/stripe-billing.live.integration.test.ts
 *
 * Preconditions (each missing one skips with a named reason):
 * - `PAPERCUSP_STRIPE_TEST_SECRET_KEY_REF` (default `file:~/.papercusp/secrets/stripe-test-secret-key`)
 *   resolving to an `sk_test_`/`rk_test_` key. A live key is refused outright.
 * - `PAPERCUSP_STRIPE_TEST_WEBHOOK_SECRET_REF` (default `file:~/.papercusp/secrets/stripe-test-webhook-secret`)
 *   resolving to the `whsec_` that `stripe listen` signs with for this device.
 * - the `stripe` CLI on PATH, logged in (`PAPERCUSP_STRIPE_CLI_PROJECT`, default `papercusp`).
 * - `PAPERCUSP_STRIPE_TEST_PRICE_ID` / `PAPERCUSP_STRIPE_TEST_PORTAL_CONFIGURATION_ID`
 *   default to the test-mode objects created for stripe-subscription-signup-2026-10-01.
 * - Docker (the org test database), as for every operator-core integration test.
 *
 * stripe-subscription-signup-2026-10-01 R-9 (promoted from the WI-10004478 scratch probe
 * so an independent grader can re-run it from the tree).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import { createHostedBillingRuntime, readHostedBillingRuntimeConfiguration } from '../../../endpoint-route/hosted-billing-runtime';
import { resolveSecretRef } from '../../../inference-gateway/egress-providers/secret-ref';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { PostgresHostedBillingStore } from './billing-store';

const SECRETS = join(homedir(), '.papercusp', 'secrets');
const SECRET_KEY_REF = process.env.PAPERCUSP_STRIPE_TEST_SECRET_KEY_REF ?? `file:${SECRETS}/stripe-test-secret-key`;
const WEBHOOK_SECRET_REF = process.env.PAPERCUSP_STRIPE_TEST_WEBHOOK_SECRET_REF ?? `file:${SECRETS}/stripe-test-webhook-secret`;
const PRICE_ID = process.env.PAPERCUSP_STRIPE_TEST_PRICE_ID ?? 'price_1ULZRfF3Zj0ZNLH5tI51SDps';
const PORTAL_CONFIGURATION_ID = process.env.PAPERCUSP_STRIPE_TEST_PORTAL_CONFIGURATION_ID ?? 'bpc_1ULZRfF3Zj0ZNLH5JEPEUsY4';
const CLI_PROJECT = process.env.PAPERCUSP_STRIPE_CLI_PROJECT ?? 'papercusp';
const PUBLIC_ORIGIN = 'http://127.0.0.1:1';
const FORWARDED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
].join(',');

async function resolvePreconditions(): Promise<{ skip: string | null; secretKey: string }> {
  if (process.env.PAPERCUSP_STRIPE_TEST_E2E !== '1') return { skip: 'opt-in: set PAPERCUSP_STRIPE_TEST_E2E=1', secretKey: '' };
  let secretKey: string;
  try {
    secretKey = (await resolveSecretRef(SECRET_KEY_REF)).trim();
    await resolveSecretRef(WEBHOOK_SECRET_REF);
  } catch (error) {
    return { skip: `secret ref unresolvable: ${(error as Error).message.slice(0, 120)}`, secretKey: '' };
  }
  if (!/^(sk|rk)_test_/.test(secretKey)) return { skip: 'refusing: the configured key is not a Stripe TEST key', secretKey: '' };
  if (spawnSync('stripe', ['--version'], { stdio: 'ignore' }).status !== 0) return { skip: 'stripe CLI not on PATH', secretKey: '' };
  return { skip: null, secretKey };
}

const preconditions = await resolvePreconditions();
const redact = (text: string) => text.replace(/(sk|rk)_test_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+/g, '[redacted]');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stripeApi(method: string, path: string, form?: Record<string, string>): Promise<Record<string, any>> {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${preconditions.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const json = (await response.json()) as Record<string, any>;
  if (!response.ok) throw new Error(redact(`stripe ${method} ${path} -> ${response.status} ${json?.error?.code ?? ''}`));
  return json;
}

describe.skipIf(preconditions.skip !== null)(`hosted billing against real Stripe test mode${preconditions.skip ? ` (skipped: ${preconditions.skip})` : ''}`, () => {
  let db: OrgTestDb;
  let server: ServerType | null = null;
  let listener: ChildProcess | null = null;
  let base = '';
  let store: PostgresHostedBillingStore;
  const organizationId = randomUUID();
  const state: { customerId: string | null; subscriptionId: string | null } = { customerId: null, subscriptionId: null };

  const post = (path: string, body?: unknown, origin = PUBLIC_ORIGIN) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', origin },
    });

  async function subscriptionUntil(predicate: (status: string | undefined) => boolean): Promise<any> {
    let snapshot: any = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      snapshot = await (await fetch(`${base}/subscription`)).json();
      if (predicate(snapshot?.subscription?.status)) return snapshot;
      await sleep(1000);
    }
    return snapshot;
  }

  beforeAll(async () => {
    const { createOrgTestDb } = await import('../../../../test/_org-test-db');
    db = await createOrgTestDb();
    const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
      db.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
        await tx.unsafe('SET LOCAL ROLE hosted_service');
        return fn(tx as unknown as Sql);
      }) as Promise<T>;
    store = new PostgresHostedBillingStore(runService);

    const env = {
      PAPERCUSP_HOSTED_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      PAPERCUSP_STRIPE_SECRET_KEY_REF: SECRET_KEY_REF,
      PAPERCUSP_STRIPE_WEBHOOK_SECRET_REF: WEBHOOK_SECRET_REF,
      PAPERCUSP_STRIPE_PORTAL_CONFIGURATION_ID: PORTAL_CONFIGURATION_ID,
      PAPERCUSP_HOSTED_BILLING_PLANS: JSON.stringify([{ planKey: 'team', priceId: PRICE_ID, label: 'Team' }]),
    } as NodeJS.ProcessEnv;
    const principal = { activeOrganizationId: organizationId, capabilities: new Set(['workspace:view', 'billing:manage']) };
    const runtime = await createHostedBillingRuntime(readHostedBillingRuntimeConfiguration(env), {
      resolvePrincipal: async () => ({ ok: true, principal }) as never,
      runService,
      store,
    });
    expect(runtime.unavailableReason).toBeNull();
    expect(runtime.configured).toBe(true);

    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: runtime.app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) => resolve(info.port));
    });
    base = `http://127.0.0.1:${port}/api/hosted/billing`;

    listener = spawn('stripe', ['--project-name', CLI_PROJECT, 'listen', '--forward-to', `${base}/webhook`, '--events', FORWARDED_EVENTS], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const onOutput = (chunk: Buffer) => {
      if (chunk.toString().includes('Ready!')) ready = true;
    };
    listener.stdout?.on('data', onOutput);
    listener.stderr?.on('data', onOutput);
    for (let attempt = 0; attempt < 60 && !ready; attempt++) await sleep(500);
    expect(ready, 'stripe listen never reported Ready!').toBe(true);
  }, 90_000);

  afterAll(async () => {
    if (state.subscriptionId) await stripeApi('DELETE', `/subscriptions/${state.subscriptionId}`).catch(() => {});
    if (state.customerId) await stripeApi('DELETE', `/customers/${state.customerId}`).catch(() => {});
    listener?.kill('SIGTERM');
    (server as { close?: () => void } | null)?.close?.();
    await db?.cleanup().catch(() => {});
  }, 60_000);

  it('lists the configured plan without exposing its price id', async () => {
    const body = (await (await fetch(`${base}/plans`)).json()) as { plans?: Array<Record<string, unknown>> };
    expect(body.plans?.some((plan) => plan.planKey === 'team')).toBe(true);
    expect(JSON.stringify(body)).not.toContain(PRICE_ID);
  });

  it('refuses a cross-origin checkout before calling Stripe', async () => {
    const response = await post('/checkout', { planKey: 'team' }, 'https://evil.example');
    expect(response.status).toBe(403);
    expect(await store.customerFor(organizationId)).toBeNull();
  });

  it('opens a real Stripe Checkout session and records one test-mode customer for the org', async () => {
    const response = await post('/checkout', { planKey: 'team' });
    const body = (await response.json()) as { url?: string };
    expect(response.status).toBe(200);
    expect(body.url ?? '').toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const customer = await store.customerFor(organizationId);
    expect(customer?.stripeCustomerId).toMatch(/^cus_/);
    expect(customer?.livemode).toBe(false);
    state.customerId = customer?.stripeCustomerId ?? null;
  });

  it('turns real signed webhook deliveries into an active org subscription', async () => {
    expect(state.customerId).not.toBeNull();
    const paymentMethod = await stripeApi('POST', '/payment_methods/pm_card_visa/attach', { customer: state.customerId! });
    const subscription = await stripeApi('POST', '/subscriptions', {
      customer: state.customerId!,
      'items[0][price]': PRICE_ID,
      default_payment_method: paymentMethod.id,
      'metadata[organizationId]': organizationId,
    });
    state.subscriptionId = subscription.id;
    expect(subscription.status).toBe('active');
    const snapshot = await subscriptionUntil((status) => status === 'active');
    expect(snapshot?.subscription?.status).toBe('active');
    expect(snapshot?.subscription?.planKey).toBe('team');
  }, 90_000);

  it('opens a real Stripe billing portal session for the subscribed org', async () => {
    const response = await post('/portal');
    const body = (await response.json()) as { url?: string };
    expect(response.status).toBe(200);
    expect(body.url ?? '').toMatch(/^https:\/\/billing\.stripe\.com\//);
  });

  it('refuses a second checkout while the org already holds an active subscription', async () => {
    const response = await post('/checkout', { planKey: 'team' });
    expect(response.status).not.toBe(200);
  });

  it('records the cancellation Stripe delivers when the subscription is deleted', async () => {
    expect(state.subscriptionId).not.toBeNull();
    await stripeApi('DELETE', `/subscriptions/${state.subscriptionId}`);
    state.subscriptionId = null;
    const snapshot = await subscriptionUntil((status) => status !== undefined && status !== 'active');
    expect(snapshot?.subscription?.status).toBe('canceled');
  }, 90_000);
});
