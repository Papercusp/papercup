/**
 * Mobile pairing route surface — E2E through the Hono shim.
 *
 * Scope: the contract phone clients depend on. Token redemption, deviceAuth
 * gate, malformed body rejection, expired/invalid token paths.
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

test.describe('mobile pairing route surface', () => {
  test('/api/mobile/pair rejects missing body', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mobile/pair`, {
      data: {},
      headers: { 'Content-Type': 'application/json' },
    });
    expect([400, 401]).toContain(res.status());
  });

  test('/api/mobile/pair rejects invalid pairToken', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mobile/pair`, {
      data: { pairToken: 'not-a-real-token-zzz' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid_or_expired/);
  });

  test('/api/mobile/workspace/switch requires bearer token', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mobile/workspace/switch`, {
      data: { workspaceId: 'default' },
      headers: { 'Content-Type': 'application/json' },
    });
    // 401 (no bearer) confirms deviceAuth() middleware gates this endpoint
    expect(res.status()).toBe(401);
  });

  test('/api/mobile/rest-query requires bearer token', async ({ request }) => {
    const res = await request.post(`${baseURL}/api/mobile/rest-query`, {
      data: { name: 'workspaces.list', args: {} },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).toBe(401);
  });

  test('/api/mobile/pair endpoint is reachable (no 404)', async ({ request }) => {
    // Negative confirmation: routing is correct, only auth/validation is left.
    const res = await request.post(`${baseURL}/api/mobile/pair`, {
      data: { pairToken: 'x' },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status()).not.toBe(404);
  });
});
