/**
 * The per-use metering door is REACHABLE through the shipped Worker API.
 *
 * `metered-invocation-door-io.test.ts` (operator-core) proves the client side of
 * the metered door against a faked fetch, so on its own it cannot tell whether
 * `meteredUsageRoute` is actually mounted in `buildApi` — a grep of
 * routes/index.ts proves the TEXT exists, not that a request reaches the handler
 * (an `api.route()` in a dead branch would still grep). These tests drive the
 * real `buildApi` over real D1 migrations and assert on bodies that ONLY the
 * metered route produces; the CONTROL case shows an unmounted path yields
 * Hono's plain 404, so a 404 status alone is never taken as proof of the mount.
 *
 * Acceptance: shared-pot-dao-cupboard-v1-2026-09-04 rubric criterion R-1
 * (per-use metering through production doors).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth.ts';
import { buildApi } from '../routes/index.ts';
import { makeEnv } from './fake-d1.ts';
import { makeSqliteDb } from './sqlite-d1.ts';

const auth = vi.hoisted(() => ({ resolveGithubBearer: vi.fn() }));
vi.mock('../auth.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth.ts')>();
  return { ...actual, resolveGithubBearer: auth.resolveGithubBearer };
});

function harness() {
  const { db } = makeSqliteDb();
  const { env } = makeEnv();
  env.DB = db;
  return { api: buildApi(), env };
}

function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

const WELL_FORMED_VOUCHER = {
  payer: `0x${'1'.repeat(40)}`,
  seller: `0x${'2'.repeat(40)}`,
  releaseRef: 'release:mount-test',
  usageNonce: 'nonce-mount-test',
  meterQuantity: '1',
  pricePerUnitMicros: '10',
  priceVersion: 'v1',
  splitManifestHash: 'a'.repeat(64),
  expiresAtMs: 4_102_444_800_000,
  cumulativeClaimMicros: '10',
  signature: `0x${'b'.repeat(130)}`,
};

describe('meteredUsageRoute is mounted in the Worker API', () => {
  beforeEach(() => {
    auth.resolveGithubBearer.mockReset();
    auth.resolveGithubBearer.mockResolvedValue({ id: 42, login: 'metered-buyer' });
  });

  it('refuses an unauthenticated reserve with the route\'s own 401 body, before reading the request', async () => {
    auth.resolveGithubBearer.mockRejectedValue(new AuthError('missing_bearer'));
    const { api, env } = harness();
    const response = await api.request('/commerce/metered-invocations', post({}), env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'missing_bearer' });
  });

  it('refuses a reserve without channel, offer and voucher as invalid_request', async () => {
    const { api, env } = harness();
    const response = await api.request('/commerce/metered-invocations', post({ channelId: 'c1' }), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_request' });
  });

  it('reaches the channel lookup for a well-formed voucher and refuses an unknown channel', async () => {
    const { api, env } = harness();
    const response = await api.request(
      '/commerce/metered-invocations',
      post({ channelId: 'no-such-channel', offerId: 'offer-1', voucher: WELL_FORMED_VOUCHER }),
      env,
    );
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'unknown_channel' });
  });

  it('reaches the reservation lookup on settle and refuses an unknown reservation', async () => {
    const { api, env } = harness();
    const response = await api.request(
      '/commerce/metered-invocations/nonce-never-reserved/settle',
      post({ channelId: 'no-such-channel', receiptSignature: `0x${'c'.repeat(130)}` }),
      env,
    );
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'unknown-reservation' });
  });

  it('serves the channel usage read and refuses an unknown channel', async () => {
    const { api, env } = harness();
    const response = await api.request(
      '/commerce/payment-channels/no-such-channel/usage',
      { headers: { Authorization: 'Bearer test-token' } },
      env,
    );
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'unknown_channel' });
  });

  it('CONTROL: an unmounted path is a plain 404 with none of the metered route\'s bodies', async () => {
    const { api, env } = harness();
    const response = await api.request('/commerce/metered-invocations-not-mounted', post({}), env);
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain('unknown_channel');
    expect(text).not.toContain('invalid_request');
    expect(text).not.toContain('unauthorized');
  });
});
