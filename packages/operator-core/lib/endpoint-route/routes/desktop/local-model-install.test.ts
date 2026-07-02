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

const detectContainerRuntimeMock = vi.fn();
const pullVllmImageMock = vi.fn();
vi.mock('../../../provisioner/vllm-container', () => ({
  detectContainerRuntime: (...args: unknown[]) => detectContainerRuntimeMock(...args),
  pullVllmImage: (...args: unknown[]) => pullVllmImageMock(...args),
  VLLM_PINNED_IMAGE: 'vllm/vllm-openai:v0.24.0',
}));

const pullOllamaWeightsMock = vi.fn();
vi.mock('../../../provisioner/weights', () => ({
  pullOllamaWeights: (...args: unknown[]) => pullOllamaWeightsMock(...args),
}));

import route from './local-model-install';

beforeEach(() => {
  planProvisionMock.mockClear();
  applyProvisionMock.mockClear();
  detectHardwareMock.mockClear();
  resolveLlamaBinaryMock.mockClear();
  detectContainerRuntimeMock.mockClear();
  pullVllmImageMock.mockClear();
  pullOllamaWeightsMock.mockClear();
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

  describe('pullVllmImage (WI-1618 opt-in vLLM container image provisioning)', () => {
    it('defaults pullVllmImage to false — never probes/pulls when omitted', async () => {
      planProvisionMock.mockResolvedValue({ blocked: null });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });
      await route.handler(jsonReq({}), {} as never);
      expect(detectContainerRuntimeMock).not.toHaveBeenCalled();
      expect(pullVllmImageMock).not.toHaveBeenCalled();
    });

    it('probes the runtime and pulls the pinned image before planning when pullVllmImage:true', async () => {
      const runtimeInfo = { runtime: 'docker' as const, version: '27.0.0', notes: [] };
      detectContainerRuntimeMock.mockResolvedValue(runtimeInfo);
      pullVllmImageMock.mockResolvedValue({ ok: true, runtime: 'docker', image: 'vllm/vllm-openai:v0.24.0', alreadyPresent: false });
      planProvisionMock.mockResolvedValue({ blocked: null });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

      const res = await route.handler(jsonReq({ pullVllmImage: true }), {} as never);

      expect(detectContainerRuntimeMock).toHaveBeenCalled();
      expect(pullVllmImageMock).toHaveBeenCalledWith('vllm/vllm-openai:v0.24.0', { runtimeInfo });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    });

    it('returns {ok:false, error} with 500 (never falling back to plan) when the image pull is blocked', async () => {
      detectContainerRuntimeMock.mockResolvedValue({ runtime: null, notes: ['docker not usable'] });
      pullVllmImageMock.mockResolvedValue({ ok: false, blocked: 'no working container runtime (docker/podman) found' });

      const res = await route.handler(jsonReq({ pullVllmImage: true }), {} as never);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: 'vLLM image provisioning failed: no working container runtime (docker/podman) found' });
      expect(planProvisionMock).not.toHaveBeenCalled();
      expect(applyProvisionMock).not.toHaveBeenCalled();
    });

    it('treats a truthy-but-not-boolean-true pullVllmImage as false (no coercion)', async () => {
      planProvisionMock.mockResolvedValue({ blocked: null });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });
      await route.handler(jsonReq({ pullVllmImage: 1 }), {} as never);
      expect(pullVllmImageMock).not.toHaveBeenCalled();
    });
  });

  describe('pullWeights (WI-1598 auto weight download)', () => {
    it('defaults pullWeights to false — never pulls when omitted', async () => {
      planProvisionMock.mockResolvedValue({ blocked: null });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });
      await route.handler(jsonReq({}), {} as never);
      expect(pullOllamaWeightsMock).not.toHaveBeenCalled();
    });

    it('pulls llama-server weights and re-plans before apply when pullWeights:true and the first plan is blocked on missing weights', async () => {
      planProvisionMock
        .mockResolvedValueOnce({
          blocked: 'weights not present locally',
          recommendation: { entry: { backend: 'llama-server', model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M' } } },
          weights: { needsDownload: true },
        })
        .mockResolvedValueOnce({
          blocked: null,
          recommendation: { entry: { backend: 'llama-server', model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M' } } },
          weights: { needsDownload: false, weightsPath: '/blob' },
        });
      pullOllamaWeightsMock.mockResolvedValue({ ok: true, ollamaRef: 'maxwell1500/ornith-35b:IQ3_M' });
      applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

      const res = await route.handler(jsonReq({ pullWeights: true }), {} as never);

      expect(pullOllamaWeightsMock).toHaveBeenCalledWith('maxwell1500/ornith-35b:IQ3_M');
      expect(planProvisionMock).toHaveBeenCalledTimes(2);
      expect(applyProvisionMock).toHaveBeenCalledWith(expect.objectContaining({ blocked: null }), { start: false });
      expect(res.status).toBe(200);
    });

    it('returns 500 and never applies when weight pull fails', async () => {
      planProvisionMock.mockResolvedValue({
        blocked: 'weights not present locally',
        recommendation: { entry: { backend: 'llama-server', model: { ollamaRef: 'maxwell1500/ornith-35b:IQ3_M' } } },
        weights: { needsDownload: true },
      });
      pullOllamaWeightsMock.mockResolvedValue({ ok: false, blocked: 'ollama missing' });

      const res = await route.handler(jsonReq({ pullWeights: true }), {} as never);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: 'weight provisioning failed: ollama missing' });
      expect(applyProvisionMock).not.toHaveBeenCalled();
    });
  });
});
