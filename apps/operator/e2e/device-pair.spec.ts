/**
 * Device pairing route surface — E2E through the Hono host.
 *
 * Scope: the contract phone clients depend on. Token redemption, the
 * device-JWT auth gate, malformed body rejection, expired/invalid token
 * paths.
 *
 * NOT covered here (out of scope per project_mobile_pair_setup memory):
 * - Cloudflare Tunnel routing
 * - Defguard mesh enrollment
 * - WireGuard handshake
 *
 * These live in infra and need their own test surfaces. This spec exercises
 * only what the operator binary itself owns.
 */
import { test, expect } from './_egress';

const baseURL =
  process.env.OPERATOR_E2E_BASE_URL ??
  `http://127.0.0.1:${Number(process.env.OPERATOR_E2E_PORT ?? process.env.PORT) || 3055}`;

test.describe('device pairing route surface', () => {
  test('POST /api/device/pair rejects missing body', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/device/pair`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([400, 401]).toContain(res.status());
  });

  test('POST /api/device/pair rejects invalid pairToken', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/device/pair`, {
      data: { pairToken: 'not-a-real-token-zzz' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid_or_expired/);
  });

  test('POST /api/device/workspace/switch requires a device token', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/device/workspace/switch`, {
      data: { workspaceId: 'default' },
      headers: { 'Content-Type': 'application/json' },
    });
    // The device-JWT gate rejects a caller with no device credential:
    // 401 from a remote origin, 403 from loopback (the loopback resolver
    // supplies a non-device principal, so it's a kind-mismatch, not a
    // missing-principal). Either way the caller is denied.
    expect([401, 403]).toContain(res.status());
  });

  test('GET /api/device/rest-query requires a device token', async ({ request }) => {
    // rest-query authenticates via ?token= (auth.tokenIn) — with neither a
    // query token nor an Authorization header it is rejected. It is a GET.
    // 401 from a remote origin, 403 from loopback (loopback-principal
    // kind-mismatch).
    const res = await request.get(`${baseURL}/api/device/rest-query`);
    expect([401, 403]).toContain(res.status());
  });

  test('POST /api/device/pair endpoint is reachable (no 404)', async ({ request }) => {
    // Negative confirmation: routing is correct, only auth/validation is left.
    const res = await request.post(`${baseURL}/api/device/pair`, {
      data: { pairToken: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).not.toBe(404);
  });
});
