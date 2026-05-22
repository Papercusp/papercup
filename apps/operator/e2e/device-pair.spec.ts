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
import { test, expect } from '@playwright/test';

const baseURL = process.env.OPERATOR_E2E_BASE_URL ?? 'http://127.0.0.1:3055';

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
    // 401 (no credential) confirms the device-JWT auth gate is enforced.
    expect(res.status()).toBe(401);
  });

  test('GET /api/device/rest-query requires a device token', async ({ request }) => {
    // rest-query authenticates via ?token= (auth.tokenIn) — with neither a
    // query token nor an Authorization header it must 401. It is a GET.
    const res = await request.get(`${baseURL}/api/device/rest-query`);
    expect(res.status()).toBe(401);
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
