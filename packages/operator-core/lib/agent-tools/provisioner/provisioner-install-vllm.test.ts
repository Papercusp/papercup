/**
 * provisioner-install-vllm.test.ts — the `provisioner:install` tool's `pullVllmImage:true`
 * branch (WI-1618/D-009 #3, mirroring `provisioner-install-binary.test.ts`'s equivalent
 * `provisionBinary:true` coverage). Kept in its own file for the same reason: this branch calls
 * into `detectContainerRuntime`/`pullVllmImage`/`planProvision`/`applyProvision` — all mocked
 * here so the wiring (container-runtime probe → image pull → planProvision/applyProvision) is
 * provable without ever touching a real docker/podman daemon or Postgres.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const planProvisionMock = vi.fn();
const applyProvisionMock = vi.fn();
vi.mock('../../provisioner/provision', () => ({
  planProvision: (...args: unknown[]) => planProvisionMock(...args),
  applyProvision: (...args: unknown[]) => applyProvisionMock(...args),
}));

const detectHardwareMock = vi.fn();
vi.mock('../../provisioner/hardware-detect', () => ({
  detectHardware: (...args: unknown[]) => detectHardwareMock(...args),
}));

const resolveLlamaBinaryMock = vi.fn();
vi.mock('../../provisioner/llama-binary', () => ({
  resolveLlamaBinary: (...args: unknown[]) => resolveLlamaBinaryMock(...args),
  computeCapToArch: (cc: string) => cc.replace(/\./g, ''),
}));

const detectContainerRuntimeMock = vi.fn();
const pullVllmImageMock = vi.fn();
vi.mock('../../provisioner/vllm-container', () => ({
  detectContainerRuntime: (...args: unknown[]) => detectContainerRuntimeMock(...args),
  pullVllmImage: (...args: unknown[]) => pullVllmImageMock(...args),
  VLLM_PINNED_IMAGE: 'vllm/vllm-openai:v0.24.0',
}));

// recommendCombo is used by provisioner:recommend, not provisioner:install — mock it too so
// importing ./provisioner never triggers a real hardware probe for an unrelated tool.
vi.mock('../../provisioner/recommend', () => ({ recommendCombo: vi.fn() }));

import { provisionerInstallTool } from './provisioner';

const body = (o: unknown) => JSON.parse((o as { content: { text: string }[] }).content[0]!.text);

beforeEach(() => {
  planProvisionMock.mockClear();
  applyProvisionMock.mockClear();
  detectHardwareMock.mockClear();
  resolveLlamaBinaryMock.mockClear();
  detectContainerRuntimeMock.mockClear();
  pullVllmImageMock.mockClear();
});

describe('provisioner:install pullVllmImage (WI-1618)', () => {
  it('never probes the container runtime or pulls when pullVllmImage is omitted', async () => {
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

    const r = body(await provisionerInstallTool.handler({}, {} as never));

    expect(detectContainerRuntimeMock).not.toHaveBeenCalled();
    expect(pullVllmImageMock).not.toHaveBeenCalled();
    expect(planProvisionMock).toHaveBeenCalledWith({ binPath: undefined });
    expect(r.ok).toBe(true);
  });

  it('probes the runtime and pulls the pinned image before planning when pullVllmImage:true', async () => {
    const runtimeInfo = { runtime: 'docker' as const, version: '27.0.0', notes: [] };
    detectContainerRuntimeMock.mockResolvedValue(runtimeInfo);
    pullVllmImageMock.mockResolvedValue({ ok: true, runtime: 'docker', image: 'vllm/vllm-openai:v0.24.0', alreadyPresent: false });
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

    const r = body(await provisionerInstallTool.handler({ pullVllmImage: true }, {} as never));

    expect(detectContainerRuntimeMock).toHaveBeenCalled();
    expect(pullVllmImageMock).toHaveBeenCalledWith('vllm/vllm-openai:v0.24.0', { runtimeInfo });
    expect(planProvisionMock).toHaveBeenCalledWith({ binPath: undefined });
    expect(r.ok).toBe(true);
  });

  it('fails the whole call (never falls through to planning) when the image pull is blocked', async () => {
    detectContainerRuntimeMock.mockResolvedValue({ runtime: null, notes: ['docker not usable'] });
    pullVllmImageMock.mockResolvedValue({ ok: false, blocked: 'no working container runtime (docker/podman) found' });

    const r = body(await provisionerInstallTool.handler({ pullVllmImage: true }, {} as never));

    expect(r.ok).toBe(false);
    expect(r.error).toContain('no working container runtime');
    expect(planProvisionMock).not.toHaveBeenCalled();
    expect(applyProvisionMock).not.toHaveBeenCalled();
  });

  it('composes with provisionBinary:true — both opt-in steps run before planning', async () => {
    const hw = { platform: 'linux', arch: 'x64', ramGB: 32, gpu: { vendor: 'nvidia', vramGB: 24, computeCap: '8.6' }, notes: [] };
    detectHardwareMock.mockResolvedValue(hw);
    resolveLlamaBinaryMock.mockResolvedValue({ ok: true, binPath: '/bin/llama-server' });
    detectContainerRuntimeMock.mockResolvedValue({ runtime: 'podman', version: '5.0', notes: [] });
    pullVllmImageMock.mockResolvedValue({ ok: true, runtime: 'podman', image: 'vllm/vllm-openai:v0.24.0', alreadyPresent: true });
    planProvisionMock.mockResolvedValue({ blocked: null });
    applyProvisionMock.mockResolvedValue({ ok: true, wroteUnit: true, registered: true, started: false });

    const r = body(await provisionerInstallTool.handler({ provisionBinary: true, pullVllmImage: true }, {} as never));

    expect(resolveLlamaBinaryMock).toHaveBeenCalled();
    expect(pullVllmImageMock).toHaveBeenCalled();
    expect(planProvisionMock).toHaveBeenCalledWith({ binPath: '/bin/llama-server' });
    expect(r.ok).toBe(true);
  });
});
