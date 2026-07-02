/**
 * local-model-install.test.ts — the thin POST wrapper over planProvision()+applyProvision().
 * applyProvision()'s own logic (writes gated behind opts.start, GPU-touch gated behind
 * opts.start) is exhaustively covered by provisioner/provision.test.ts's injected-deps unit
 * tests; this file only proves the route shape and — most importantly for this task's hard
 * invariant — that `start` DEFAULTS TO FALSE when the request body omits it or sends garbage.
 */
/* NOTE: `beforeEach` clears CALL HISTORY only (`mockClear`, not `mockReset`) — every test sets
 * both mocks' resolved/rejected values explicitly before invoking the route anyway, and
 * `mockReset()` ahead of a rejected-value test lets the rejection slip past the route's own
 * try/catch as an unhandled rejection in this Vitest/tinyspy version (reproduced in isolation
 * — see local-model-status.test.ts's matching note), not a bug in the route itself. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const planProvisionMock = vi.fn();
const applyProvisionMock = vi.fn();
vi.mock('../../../provisioner/provision', () => ({
  planProvision: (...args: unknown[]) => planProvisionMock(...args),
  applyProvision: (...args: unknown[]) => applyProvisionMock(...args),
}));

import route from './local-model-install';

beforeEach(() => {
  planProvisionMock.mockClear();
  applyProvisionMock.mockClear();
});

function jsonReq(body: unknown) {
  return new Request('http://127.0.0.1/api/desktop/local-model-install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function noBodyReq() {
  return new Request('http://127.0.0.1/api/desktop/local-model-install', { method: 'POST' });
}

describe('POST /desktop/local-model-install', () => {
  it('defaults start to false when the body omits it', async () => {
    const plan = { blocked: null };
    planProvisionMock.mockResolvedValue(plan);
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });
    const res = await route.handler(jsonReq({}));
    expect(applyProvisionMock).toHaveBeenCalledWith(plan, { start: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('defaults start to false when the request has no body at all', async () => {
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: false, registered: false, started: false });
    await route.handler(noBodyReq());
    expect(applyProvisionMock).toHaveBeenCalledWith(expect.anything(), { start: false });
  });

  it('only passes start:true when the body explicitly sets start:true', async () => {
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: true });
    await route.handler(jsonReq({ start: true }));
    expect(applyProvisionMock).toHaveBeenCalledWith(expect.anything(), { start: true });
  });

  it('treats a truthy-but-not-boolean-true start as false (no coercion)', async () => {
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });
    await route.handler(jsonReq({ start: 'true' }));
    expect(applyProvisionMock).toHaveBeenCalledWith(expect.anything(), { start: false });
  });

  it('returns {ok:false, error} with 500 when planProvision throws', async () => {
    planProvisionMock.mockRejectedValue(new Error('boom'));
    const res = await route.handler(jsonReq({}));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'boom' });
    expect(applyProvisionMock).not.toHaveBeenCalled();
  });

  it('surfaces result.ok:false without throwing when apply is refused (plan blocked)', async () => {
    planProvisionMock.mockResolvedValue({ blocked: 'no combo fits' });
    applyProvisionMock.mockResolvedValue({ ok: false, wroteUnit: false, registered: false, started: false, error: 'no combo fits' });
    const res = await route.handler(jsonReq({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, result: { error: 'no combo fits' } });
  });
});
