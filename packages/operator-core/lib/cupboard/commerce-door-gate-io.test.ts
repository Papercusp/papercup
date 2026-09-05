/**
 * The hosted checkout leg — the half of `cupboard:checkout` that leaves the
 * machine (D-045 §3d, WI-2146326).
 *
 * These cases pin the contract su-57f4104a's Worker route (WI-2146343) actually
 * landed, not the contract its brief described. Two corrections came in while
 * this was being built and both are pinned here rather than in prose: the path
 * carries NO `/v1` prefix, and the route DOES authenticate (a 401 the brief
 * first said was absent). A fake that drifts from either would let both halves
 * pass their own tests and still never meet.
 */
import { describe, expect, it } from 'vitest';

import {
  CHECKOUT_SESSIONS_PATH,
  isCanonicalUserId,
  postCheckoutSession,
  USER_ID_FORM,
  type CheckoutSessionResult,
} from './commerce-door-gate-io';

const REQUEST = {
  buyerOrgId: 'org-acme',
  offerId: 'offer-1',
  successUrl: 'https://example.test/ok',
  cancelUrl: 'https://example.test/no',
  idempotencyKey: 'key-1',
  quantity: 1,
} as const;

const BASE = 'https://cupboard.test';

interface Captured {
  url: string;
  init: RequestInit;
}

function transport(status: number, body: unknown): { fetchImpl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const OK_BODY = { orderId: 'order-1', providerSessionId: 'cs_1', url: 'https://pay.test/cs_1' };

async function post(
  status: number,
  body: unknown,
  calls?: { current?: Captured[] },
): Promise<CheckoutSessionResult> {
  const t = transport(status, body);
  if (calls) calls.current = t.calls;
  return postCheckoutSession(REQUEST, { fetchImpl: t.fetchImpl, baseUrl: BASE, authToken: 'gh-token' });
}

describe('postCheckoutSession', () => {
  it('posts to the landed path — no /v1 prefix', () => {
    // Pinned as a literal because the P-010 brief named `/v1/commerce/...` and
    // the mounted route does not. This is the assertion that fails if either
    // half drifts back to the brief's wording.
    expect(CHECKOUT_SESSIONS_PATH).toBe('/commerce/checkout-sessions');
    expect(CHECKOUT_SESSIONS_PATH.startsWith('/v1')).toBe(false);
  });

  it('sends the GitHub bearer and the request body', async () => {
    const captured: { current?: Captured[] } = {};
    await post(201, OK_BODY, captured);
    const call = captured.current?.[0];
    expect(call?.url).toBe(`${BASE}/commerce/checkout-sessions`);
    expect(call?.init.method).toBe('POST');
    expect((call?.init.headers as Record<string, string>).Authorization).toBe('Bearer gh-token');
    expect(JSON.parse(String(call?.init.body))).toEqual(REQUEST);
  });

  it('reads a 201 as a fresh session', async () => {
    const result = await post(201, OK_BODY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.orderId).toBe('order-1');
    expect(result.idempotentReplay).toBe(false);
  });

  it('reads a 200 as the idempotent replay, not a second order', async () => {
    // The distinction a caller retrying after a timeout needs: same body, and
    // flattening the two would hide that no new order was created.
    const result = await post(200, OK_BODY);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.orderId).toBe('order-1');
    expect(result.idempotentReplay).toBe(true);
  });

  it('surfaces a 401 from the authenticated route', async () => {
    const result = await post(401, { error: 'unauthorized', reason: 'bad-token' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(401);
    expect(result.error).toBe('unauthorized');
  });

  it.each([
    [403, 'org_membership_unknown'],
    [403, 'not_org_member'],
    [404, 'unknown_offer'],
    [404, 'unknown_product'],
    [422, 'inactive_offer'],
    [422, 'unsupported_quantity'],
    [502, 'provider_error'],
    [503, 'provider_not_configured'],
  ])('maps the hosted %i %s refusal', async (status, error) => {
    const result = await post(status, { error, detail: 'because' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe(error);
    expect(result.detail).toBe('because');
  });

  it('refuses a 2xx whose body does not carry the contract', async () => {
    // A malformed success is a contract breach, not a success: reporting it as
    // ok would hand the caller `undefined` as an order id.
    const result = await post(201, { orderId: 'order-1' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe('malformed_response');
  });

  it('pins the shared userId form — a mismatch here MISSES silently', () => {
    // Org membership is matched by string equality, so a desktop door writing
    // `mia` against a Worker authenticating `gh:1234` does not error: it finds
    // no membership and refuses every legitimate member as a stranger. That is
    // why this is pinned rather than left to convention.
    expect(USER_ID_FORM).toBe('gh:<numeric github id>');
    expect(isCanonicalUserId('gh:1234')).toBe(true);
    expect(isCanonicalUserId('mia')).toBe(false);
    expect(isCanonicalUserId('gh:not-numeric')).toBe(false);
    expect(isCanonicalUserId('GH:1234')).toBe(false);
  });

  it('reports a transport failure rather than throwing', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const result = await postCheckoutSession(REQUEST, { fetchImpl, baseUrl: BASE, authToken: 't' });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toBe('transport_error');
    expect(result.detail).toContain('offline');
  });
});
