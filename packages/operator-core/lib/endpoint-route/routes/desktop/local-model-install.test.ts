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

const detectHardwareMock = vi.fn();
vi.mock('../../../provisioner/hardware-detect', () => ({
  detectHardware: (...args: unknown[]) => detectHardwareMock(...args),
}));

const resolveLlamaBinaryMock = vi.fn();
vi.mock('../../../provisioner/llama-binary', () => ({
  resolveLlamaBinary: (...args: unknown[]) => resolveLlamaBinaryMock(...args),
  computeCapToArch: (cc: string) => cc.replace(/\./g, ''),
}));

import route from './local-model-install';

beforeEach(() => {
  planProvisionMock.mockClear();
  applyProvisionMock.mockClear();
  detectHardwareMock.mockClear();
  resolveLlamaBinaryMock.mockClear();
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
    const res = await route.handler(jsonReq({}), {} as never);
    expect(applyProvisionMock).toHaveBeenCalledWith(plan, { start: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('defaults start to false when the request has no body at all', async () => {
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: false, registered: false, started: false });
    await route.handler(noBodyReq(), {} as never);
    expect(applyProvisionMock).toHaveBeenCalledWith(expect.anything(), { start: false });
  });

  it('only passes start:true when the body explicitly sets start:true', async () => {
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: true });
    await route.handler(jsonReq({ start: true }), {} as never);
    expect(applyProvisionMock).toHaveBeenCalledWith(expect.anything(), { start: true });
  });

  it('treats a truthy-but-not-boolean-true start as false (no coercion)', async () => {
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });
    await route.handler(jsonReq({ start: 'true' }), {} as never);
    expect(applyProvisionMock).toHaveBeenCalledWith(expect.anything(), { start: false });
  });

  it('returns {ok:false, error} with 500 when planProvision throws', async () => {
    planProvisionMock.mockRejectedValue(new Error('boom'));
    const res = await route.handler(jsonReq({}), {} as never);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: 'boom' });
    expect(applyProvisionMock).not.toHaveBeenCalled();
  });

  it('surfaces result.ok:false without throwing when apply is refused (plan blocked)', async () => {
    planProvisionMock.mockResolvedValue({ blocked: 'no combo fits' });
    applyProvisionMock.mockResolvedValue({ ok: false, wroteUnit: false, registered: false, started: false, error: 'no combo fits' });
    const res = await route.handler(jsonReq({}), {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, result: { error: 'no combo fits' } });
  });

  describe('provisionBinary (WI-1617 opt-in on-demand binary resolution)', () => {
    it('defaults provisionBinary to false — never resolves/detects hardware when omitted', async () => {
      planProvisionMock.mockResolvedValue({ blocked: null });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });
      await route.handler(jsonReq({}), {} as never);
      expect(detectHardwareMock).not.toHaveBeenCalled();
      expect(resolveLlamaBinaryMock).not.toHaveBeenCalled();
      expect(planProvisionMock).toHaveBeenCalledWith({ binPath: undefined });
    });

    it('resolves a binary and threads binPath into planProvision when provisionBinary:true', async () => {
      const hw = { platform: 'linux', arch: 'x64', ramGB: 32, gpu: { vendor: 'nvidia', vramGB: 24, computeCap: '8.6' }, notes: [] };
      detectHardwareMock.mockResolvedValue(hw);
      resolveLlamaBinaryMock.mockResolvedValue({ ok: true, binPath: '/home/u/.papercusp/backends/llama-server/b1/linux-x64-cuda/llama-server', fromCache: true });
      planProvisionMock.mockResolvedValue({ blocked: null });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

      const res = await route.handler(jsonReq({ provisionBinary: true }), {} as never);

      expect(detectHardwareMock).toHaveBeenCalled();
      expect(resolveLlamaBinaryMock).toHaveBeenCalledWith(hw, { cudaArch: '86', cudaHostCompiler: undefined });
      expect(planProvisionMock).toHaveBeenCalledWith({ binPath: '/home/u/.papercusp/backends/llama-server/b1/linux-x64-cuda/llama-server' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    });

    it('omits cudaArch when the GPU is not nvidia (no compute_cap to convert)', async () => {
      const hw = { platform: 'darwin', arch: 'arm64', ramGB: 36, gpu: { vendor: 'apple', vramGB: 36, unifiedMemory: true }, notes: [] };
      detectHardwareMock.mockResolvedValue(hw);
      resolveLlamaBinaryMock.mockResolvedValue({ ok: true, binPath: '/home/u/.papercusp/backends/llama-server/b1/macos-arm64-metal/llama-server' });
      planProvisionMock.mockResolvedValue({ blocked: null });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

      await route.handler(jsonReq({ provisionBinary: true }), {} as never);

      expect(resolveLlamaBinaryMock).toHaveBeenCalledWith(hw, { cudaArch: undefined, cudaHostCompiler: undefined });
    });

    it('returns {ok:false, error} with 500 (never falling back to a bare-PATH assumption) when binary resolution is blocked', async () => {
      detectHardwareMock.mockResolvedValue({ platform: 'linux', arch: 'x64', ramGB: 32, gpu: null, notes: [] });
      resolveLlamaBinaryMock.mockResolvedValue({ ok: false, blocked: 'no usable release found' });

      const res = await route.handler(jsonReq({ provisionBinary: true }), {} as never);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: 'binary provisioning failed: no usable release found' });
      expect(planProvisionMock).not.toHaveBeenCalled();
      expect(applyProvisionMock).not.toHaveBeenCalled();
    });

    it('treats a truthy-but-not-boolean-true provisionBinary as false (no coercion)', async () => {
      planProvisionMock.mockResolvedValue({ blocked: null });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });
      await route.handler(jsonReq({ provisionBinary: 1 }), {} as never);
      expect(resolveLlamaBinaryMock).not.toHaveBeenCalled();
      expect(planProvisionMock).toHaveBeenCalledWith({ binPath: undefined });
    });
  });
});
