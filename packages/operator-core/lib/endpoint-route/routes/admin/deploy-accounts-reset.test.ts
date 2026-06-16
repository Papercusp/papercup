/**
 * deploy-accounts-reset.test.ts — POST /api/admin/deploy-accounts/reset-rate
 * (accounts-pool-tab-2026-06-15 P-001, the per-card Reset button's backend).
 *
 * Verifies: the VTL auth tier, the 400 on a missing id, the 404 on an unknown
 * account (no save), and the happy path (recordAccountReset clears the projected
 * pause/penalty → saveAccountPool → notifySyncInvalidate('accounts.pool') so the
 * tab refreshes). The pure recordAccountReset is left REAL; only the IO + CORS +
 * sync-bus boundaries are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../cors', () => ({ requireAllowedOriginOr403: () => null }));

const loadAccountPool = vi.fn();
const saveAccountPool = vi.fn(async () => {});
vi.mock('../../../deployment/account-pool-store', () => ({
  loadAccountPool: (...a: unknown[]) => loadAccountPool(...a),
  saveAccountPool: (...a: unknown[]) => saveAccountPool(...a),
}));

const notifySyncInvalidate = vi.fn(async () => {});
vi.mock('../../../sync-sse', () => ({
  notifySyncInvalidate: (...a: unknown[]) => notifySyncInvalidate(...a),
}));

import resetRoute from './deploy-accounts-reset';

function poolWith(id: string) {
  return {
    accounts: [
      {
        id,
        credentialRef: `token:/x/${id}`,
        boundTo: [],
        addedAt: 1,
        rate: { pausedUntil: 9_999_999_999_999, lastPenaltyAt: 5, penaltyCount: 3, windowStartedAt: 5 },
      },
    ],
  };
}

async function post(body: unknown) {
  const req = new Request('http://127.0.0.1/api/admin/deploy-accounts/reset-rate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1' },
    body: JSON.stringify(body),
  });
  const res = (await resetRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

beforeEach(() => {
  loadAccountPool.mockReset();
  saveAccountPool.mockReset();
  saveAccountPool.mockResolvedValue(undefined);
  notifySyncInvalidate.mockReset();
  notifySyncInvalidate.mockResolvedValue(undefined);
});

describe('POST /api/admin/deploy-accounts/reset-rate', () => {
  it('declares the VTL (verified/trusted/unverified-loopback) auth tier', () => {
    expect((resetRoute as { auth?: unknown }).auth).toEqual({ trust: ['verified', 'trusted', 'unverified-loopback'] });
  });

  it('400s a missing id without touching the pool', async () => {
    const { status, body } = await post({});
    expect(status).toBe(400);
    expect(String(body?.error)).toMatch(/id required/);
    expect(loadAccountPool).not.toHaveBeenCalled();
  });

  it('404s an unknown account and does NOT save', async () => {
    loadAccountPool.mockResolvedValue(poolWith('a1'));
    const { status, body } = await post({ id: 'nope' });
    expect(status).toBe(404);
    expect(body?.error).toBe('unknown_account');
    expect(saveAccountPool).not.toHaveBeenCalled();
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('resets a known account: clears the projected pause/penalty, saves, invalidates the tab', async () => {
    loadAccountPool.mockResolvedValue(poolWith('a1'));
    const { status, body } = await post({ id: 'a1' });
    expect(status).toBe(200);
    expect(body?.ok).toBe(true);
    // The saved pool carries a fresh rate for a1 (pause + penalty cleared).
    const saved = saveAccountPool.mock.calls[0][0] as {
      accounts: { id: string; rate: { pausedUntil: number; penaltyCount: number } }[];
    };
    const acct = saved.accounts.find((a) => a.id === 'a1');
    expect(acct?.rate.pausedUntil).toBe(0);
    expect(acct?.rate.penaltyCount).toBe(0);
    // The tab is told to refresh.
    expect(notifySyncInvalidate).toHaveBeenCalledWith('accounts.pool', {});
  });
});
