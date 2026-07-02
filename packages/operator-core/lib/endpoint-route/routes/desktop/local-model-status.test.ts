/**
 * local-model-status.test.ts — the thin GET wrapper over planProvision(). planProvision()'s own
 * logic (hardware detect / recommend / weights resolution) is exhaustively covered by
 * provisioner/provision.test.ts's injected-deps unit tests; this file only proves the route
 * shape (ok:true + the plan payload; ok:false + 500 on a thrown error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const planProvisionMock = vi.fn();
vi.mock('../../../provisioner/provision', () => ({
  planProvision: (...args: unknown[]) => planProvisionMock(...args),
}));

import route from './local-model-status';

beforeEach(() => planProvisionMock.mockReset());

describe('GET /desktop/local-model-status', () => {
  it('returns {ok:true, plan} on success', async () => {
    const plan = { hardware: { platform: 'linux' }, recommendation: { entry: null }, blocked: null };
    planProvisionMock.mockResolvedValue(plan);
    const res = await route.handler(new Request('http://127.0.0.1/api/desktop/local-model-status'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, plan });
  });

  it('returns {ok:false, error} with a 500 when planProvision throws', async () => {
    planProvisionMock.mockRejectedValue(new Error('boom'));
    const res = await route.handler(new Request('http://127.0.0.1/api/desktop/local-model-status'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'boom' });
  });
});
